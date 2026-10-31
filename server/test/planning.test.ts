import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Zyklus wiederholen und vergleichen (F)', () => {
  let env: TestEnv;
  let source: string;
  const run = async (cycleId: string, results: Record<string, string>) => {
    const items = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body.items;
    for (const e of items) if (results[e.testCaseKey]) await env.call('POST', `/api/executions/${e.id}/result`, { status: results[e.testCaseKey], comment: 'Befund im Test' });
  };
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'PL', name: 'Planung' });
    for (const t of ['A', 'B', 'C', 'D']) await env.call('POST', '/api/projects/PL/test-cases', { content: { title: t, steps: [{ action: 'x', expected: 'y' }] } });
    source = (await env.call('POST', '/api/projects/PL/cycles', { name: 'Regression', build: '1.0' })).body.id;
    await env.call('POST', `/api/cycles/${source}/executions`, { testCaseIds: ['PL-T1', 'PL-T2', 'PL-T3', 'PL-T4'] });
    const items = (await env.call('GET', `/api/cycles/${source}/executions`)).body.items;
    await env.call('POST', '/api/executions/bulk-assign', { ids: [items[0].id], assignee: 'tina' });
    await run(source, { 'PL-T1': 'PASS', 'PL-T2': 'FAIL', 'PL-T3': 'BLOCKED' }); // T4 offen
  });
  after(() => env.close());

  it('Nachtest übernimmt nur Probleme und offene Tests, je Konfiguration ein Zyklus', async () => {
    const r = await env.call('POST', `/api/cycles/${source}/repeat`, {
      name: 'Nachtest', build: '1.0.1', onlyProblems: true,
      configurations: [{ database: ['Oracle'] }, { database: ['SQL Server'] }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.cycles.map((c: any) => [c.name, c.added]), [['Nachtest – Oracle', 3], ['Nachtest – SQL Server', 3]]);
    const c = (await env.call('GET', `/api/cycles/${r.body.cycles[0].id}`)).body;
    assert.deepEqual([c.build, c.configuration], ['1.0.1', { database: ['Oracle'] }]);
    const keys = (await env.call('GET', `/api/cycles/${r.body.cycles[0].id}/executions`)).body.items.map((e: any) => e.testCaseKey).sort();
    assert.deepEqual(keys, ['PL-T2', 'PL-T3', 'PL-T4']);
  });

  it('vollständige Wiederholung behält Zuständige; Vergleich erkennt Regression und Behebung', async () => {
    const r = (await env.call('POST', `/api/cycles/${source}/repeat`, { name: 'Regression 1.1', build: '1.1' })).body;
    const next = r.cycles[0].id;
    const items = (await env.call('GET', `/api/cycles/${next}/executions`)).body.items;
    assert.equal(items.length, 4);
    assert.equal(items.find((e: any) => e.testCaseKey === 'PL-T1').assignee, 'tina');
    await run(next, { 'PL-T1': 'FAIL', 'PL-T2': 'PASS', 'PL-T3': 'BLOCKED', 'PL-T4': 'PASS' });
    const cmp = (await env.call('GET', `/api/cycle-comparison?a=${source}&b=${next}`)).body;
    const change = Object.fromEntries(cmp.items.map((i: any) => [i.key, i.change]));
    assert.deepEqual(change, { 'PL-T1': 'regression', 'PL-T2': 'fixed', 'PL-T3': 'stillFailing', 'PL-T4': 'other' });
    assert.equal(cmp.counts.regression, 1);
    assert.equal((await env.call('POST', `/api/cycles/${source}/repeat`, { name: 'leer', onlyProblems: true })).status, 201);
  });

  it('verteilt offene Ausführungen nach Auslastung (Schritte, große zuerst)', async () => {
    for (const [t, n] of [['Groß', 6], ['Mittel', 3], ['Klein', 1]] as const) {
      await env.call('POST', '/api/projects/PL/test-cases', { content: { title: t, steps: Array.from({ length: n }, (_, i) => ({ action: `s${i}`, expected: 'e' })) } });
    }
    const c = (await env.call('POST', '/api/projects/PL/cycles', { name: 'Verteilung' })).body.id;
    await env.call('POST', `/api/cycles/${c}/executions`, { testCaseIds: ['PL-T5', 'PL-T6', 'PL-T7'] });
    const r = await env.call('POST', `/api/cycles/${c}/distribute`, { assignees: ['anna', 'bert'], weight: 'steps' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.loadAfter, { anna: 6, bert: 4 }, 'Groß an anna, Mittel+Klein an bert');
    const items = (await env.call('GET', `/api/cycles/${c}/executions`)).body.items;
    assert.equal(items.find((e: any) => e.testCaseKey === 'PL-T5').assignee, 'anna');
  });

  it('speichert private und geteilte Ansichten', async () => {
    const v = await env.call('POST', '/api/projects/PL/views', { page: 'cycles', name: 'Fehlgeschlagene ORA', query: '?state=failed&cfg=database:Oracle', shared: true });
    assert.equal(v.status, 201);
    await env.call('POST', '/api/projects/PL/views', { page: 'cycles', name: 'Meins', query: 'q=x' }, 'anna');
    const forBert = (await env.call('GET', '/api/projects/PL/views?page=cycles', undefined, 'bert')).body;
    assert.deepEqual(forBert.map((x: any) => x.name), ['Fehlgeschlagene ORA'], 'private Ansicht von anna nicht sichtbar');
    assert.equal(forBert[0].query, 'state=failed&cfg=database:Oracle');
    assert.equal((await env.call('DELETE', `/api/views/${v.body.id}`)).status, 204);
  });
});
