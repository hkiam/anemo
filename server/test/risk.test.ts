import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setLlmFetch } from '../src/modules/assist/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Risikobasierte Testauswahl (H-J)', () => {
  let env: TestEnv;
  let cycle: string;
  const prompts: string[] = [];
  const pick = (r: any, key: string) => r.items.find((i: any) => i.key === key);
  const factor = (it: any, key: string) => it.factors.find((f: any) => f.key === key);
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'RK', name: 'Risiko' });
    const mk = (title: string, priority: string, components: string[] = []) =>
      env.call('POST', '/api/projects/RK/test-cases', { content: { title, priority, components, steps: [{ action: title, expected: 'ok' }] } });
    await mk('Anmeldung mit Kennwort', 'Blocker', ['Anmeldung']); // T1: fehlgeschlagen, offener Fehler
    await mk('Akte drucken', 'Trivial'); // T2: zuletzt bestanden
    await mk('Akte suchen', 'Schwer'); // T3: nie ausgeführt
    await mk('Akte exportieren als PDF', 'Schwer'); // T4: bestanden, danach geändert
    for (const [k, m] of [['RK-T1', 20], ['RK-T2', 5], ['RK-T3', 15], ['RK-T4', 30]] as const) await env.call('PATCH', `/api/test-cases/${k}`, { estimateMinutes: m });
    const c = (await env.call('POST', '/api/projects/RK/cycles', { name: 'Vorlauf' })).body;
    await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['RK-T1', 'RK-T2', 'RK-T4'] });
    const ex = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items;
    const of = (k: string) => ex.find((e: any) => e.testCaseKey === k).id;
    await env.call('POST', `/api/executions/${of('RK-T1')}/result`, { status: 'FAIL', comment: 'Anmeldung schlägt fehl', defects: [{ provider: 'jira', key: 'BUG-9' }] });
    await env.call('POST', `/api/executions/${of('RK-T2')}/result`, { status: 'PASS' });
    await env.call('POST', `/api/executions/${of('RK-T4')}/result`, { status: 'PASS' });
    const tc = (await env.call('GET', '/api/test-cases/RK-T4')).body;
    await env.call('PUT', '/api/test-cases/RK-T4/content', { content: { ...tc.version, objective: 'Export geändert' }, expectedVersion: 1 });
    // Zielzyklus enthält T2 bereits
    cycle = (await env.call('POST', '/api/projects/RK/cycles', { name: 'Regression' })).body.id;
    await env.call('POST', `/api/cycles/${cycle}/executions`, { testCaseIds: ['RK-T2'] });
  });
  after(async () => {
    setLlmFetch(null);
    for (const k of ['AI_MODEL', 'AI_BASE_URL']) delete process.env[k];
    await env.close();
  });

  it('Rangfolge mit nachvollziehbaren Faktoren', async () => {
    const r = (await env.call('POST', '/api/projects/RK/risk-selection', {})).body;
    assert.equal(r.items[0].key, 'RK-T1');
    const t1 = r.items[0];
    for (const k of ['priority', 'lastFailed', 'failRate', 'defects']) assert.ok(factor(t1, k), `Faktor ${k}`);
    assert.match(factor(t1, 'defects').detail, /BUG-9/);
    // eigener Schlüssel „never“ statt „changed“ (Review Teil 3, Befund 17 – bewusst geändert)
    assert.equal(factor(pick(r, 'RK-T3'), 'never').label, 'Nie ausgeführt');
    assert.equal(factor(pick(r, 'RK-T4'), 'changed').detail, 'v1 → v2');
    assert.equal(r.items.at(-1).key, 'RK-T2', 'bestanden, unverändert, niedrigste Priorität');
    assert.equal(t1.score, t1.factors.reduce((a: number, f: any) => a + f.points, 0));
  });

  it('Budget, Zielzyklus und Abfrage', async () => {
    const r = (await env.call('POST', '/api/projects/RK/risk-selection', { cycleId: cycle, budgetMinutes: 40 })).body;
    const sel = r.items.filter((i: any) => i.selected).map((i: any) => i.key);
    assert.ok(sel.includes('RK-T1'));
    assert.ok(r.summary.selectedMinutes <= 40);
    assert.equal(pick(r, 'RK-T2').inCycle, true);
    assert.equal(pick(r, 'RK-T2').selected, false, 'schon im Zyklus');
    assert.ok(r.summary.riskCovered > 0 && r.summary.riskCovered < 100);
    const q = (await env.call('POST', '/api/projects/RK/risk-selection', { aql: 'priorität >= Schwer' })).body;
    assert.deepEqual(q.items.map((i: any) => i.key).sort(), ['RK-T1', 'RK-T3', 'RK-T4']);
    assert.equal((await env.call('POST', '/api/projects/RK/risk-selection', { aql: 'priorität >=' })).status, 400);
  });

  it('Änderungsumfang hebt betroffene Testfälle', async () => {
    const r = (await env.call('POST', '/api/projects/RK/risk-selection', { change: { components: ['anmeldung'], text: 'PDF-Export überarbeitet' } })).body;
    assert.equal(factor(pick(r, 'RK-T1'), 'scope').detail, 'Anmeldung');
    assert.ok(factor(pick(r, 'RK-T4'), 'text'), 'Text passt zu „exportieren als PDF“');
    assert.equal(factor(pick(r, 'RK-T3'), 'text'), undefined);
  });

  it('KI verfeinert mit Begründung; ohne Modell 409', async () => {
    assert.equal((await env.call('POST', '/api/projects/RK/risk-selection', { ai: true })).status, 409);
    Object.assign(process.env, { AI_MODEL: 'qwen2.5:14b', AI_BASE_URL: 'http://ollama.test/v1' });
    setLlmFetch(async (_url, init) => {
      prompts.push(JSON.parse(String(init!.body)).messages[1].content);
      const out = { summary: 'Druckausgabe betroffen.', adjustments: [{ key: 'RK-T2', delta: 99, reason: 'Druck nutzt den geänderten PDF-Export' }, { key: 'GIBT-ES-NICHT', delta: 10 }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }), { status: 200 });
    });
    const r = await env.call('POST', '/api/projects/RK/risk-selection', { ai: true, change: { text: 'PDF-Export überarbeitet' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ai.applied, 1);
    assert.equal(r.body.ai.summary, 'Druckausgabe betroffen.');
    const ai = factor(pick(r.body, 'RK-T2'), 'ai');
    assert.equal(ai.points, 30, 'auf ±30 begrenzt');
    assert.match(ai.detail, /PDF-Export/);
    assert.match(prompts[0]!, /PDF-Export überarbeitet/);
    assert.match(prompts[0]!, /RK-T1 \| Anmeldung mit Kennwort/);
  });
});
