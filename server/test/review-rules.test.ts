import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createRetest } from '../src/modules/execution/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

/** Fachregeln aus dem fachlichen und technischen Review (Kennzahlen, Empfehlung, Nachtest, Nachweise, Sperren). */
describe('Fachregeln: Kennzahlen, Freigabe, Nachtest, Nachweise', () => {
  let env: TestEnv;
  let planId = '';
  const cyc: Record<string, string> = {};
  const exec = async (cycle: string, key: string) => (await env.call('GET', `/api/cycles/${cycle}/executions?limit=50`)).body.items.find((e: any) => e.testCaseKey === key);
  const result = (id: string, body: object, user = 'tina') => env.call('POST', `/api/executions/${id}/result`, body, user);
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'FR', name: 'Fachregeln' });
    for (const t of ['A', 'B', 'C', 'D']) await env.call('POST', '/api/projects/FR/test-cases', { content: { title: t, steps: [{ action: 'x', expected: 'y' }] } });
    planId = (await env.call('POST', '/api/projects/FR/plans', { name: 'R1' })).body.id;
    cyc.ora = (await env.call('POST', '/api/projects/FR/cycles', { name: 'Lauf Oracle', planId, configuration: { database: ['Oracle'] } })).body.id;
    cyc.sql = (await env.call('POST', '/api/projects/FR/cycles', { name: 'Lauf SQL', planId, configuration: { database: ['SQL Server'] } })).body.id;
  });
  after(() => env.close());

  it('leerer Plan: „keine Aussage möglich“ statt Freigabe', async () => {
    const r = (await env.call('GET', `/api/reports/completion/${planId}?format=json`)).body;
    assert.equal(r.assessment.recommendation, 'insufficient');
  });

  it('Nachweispflicht: fehlgeschlagen nur mit Befund oder Fehlerverweis', async () => {
    await env.call('POST', `/api/cycles/${cyc.ora}/executions`, { testCaseIds: ['FR-T1', 'FR-T2'] });
    await env.call('POST', `/api/cycles/${cyc.sql}/executions`, { testCaseIds: ['FR-T1', 'FR-T2'] });
    const e = await exec(cyc.ora!, 'FR-T1');
    const bad = await result(e.id, { status: 'FAIL' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.detail, /Nachweis/);
    assert.equal((await result(e.id, { status: 'FAIL', comment: 'Absturz beim Speichern' })).status, 200);
  });

  it('Stand je Testfall × Konfiguration: späteres „bestanden“ unter SQL Server verdeckt den Oracle-Fehler nicht', async () => {
    await result((await exec(cyc.sql!, 'FR-T1')).id, { status: 'PASS' });
    await result((await exec(cyc.ora!, 'FR-T2')).id, { status: 'PASS' });
    await result((await exec(cyc.sql!, 'FR-T2')).id, { status: 'PASS' });
    const r = (await env.call('GET', `/api/reports/completion/${planId}?format=json`)).body;
    assert.deepEqual(r.problems.map((p: any) => p.testCaseKey), ['FR-T1']);
    assert.equal(r.assessment.recommendation, 'not-recommended');
    // Bestehensquote ISTQB: bestanden / (bestanden + fehlgeschlagen)
    assert.equal(r.current.passRate, 50);
    assert.equal(r.current.executionRate, 100);
  });

  it('Ergebnis-Historie; „ausgeführt am“ ändert sich nur bei neuem Ergebnis; optimistische Sperre', async () => {
    const e = await exec(cyc.ora!, 'FR-T2');
    const before = (await env.call('GET', `/api/executions/${e.id}`)).body;
    await result(e.id, { status: 'PASS', comment: 'nur Kommentar korrigiert' });
    const after = (await env.call('GET', `/api/executions/${e.id}`)).body;
    assert.equal(after.executedAt, before.executedAt);
    const hist = (await env.call('GET', `/api/executions/${e.id}/results`)).body;
    assert.equal(hist.length, 2);
    assert.equal((await result(e.id, { status: 'PASS', expectedUpdatedAt: before.updatedAt })).status, 409);
  });

  it('bestanden mit Einschränkung: zählt als bestanden, Empfehlung nur unter Vorbehalt', async () => {
    const [s] = await env.db<{ code: string }[]>`select code from execution_status where category = 'PASSED_WITH_ISSUES' limit 1`;
    let code = s?.code;
    if (!code) {
      const r = await env.call('PUT', '/api/admin/execution-statuses/MANGEL', { name: 'Bestanden mit Mangel', color: '#77aa55', category: 'PASSED_WITH_ISSUES', appliesTo: 'execution', active: true, sortOrder: 50, description: null });
      assert.equal(r.status, 204, JSON.stringify(r.body));
      code = 'MANGEL';
    }
    await result((await exec(cyc.ora!, 'FR-T1')).id, { status: code, comment: 'Layout verschoben' });
    const r = (await env.call('GET', `/api/reports/completion/${planId}?format=json`)).body;
    assert.equal(r.problems.length, 0);
    assert.equal(r.assessment.recommendation, 'conditional');
    assert.ok(r.risks.some((x: string) => /Einschränkung/.test(x)));
  });

  it('Ausstiegskriterien werden je Kriterium bewertet; Freigabeentscheidung braucht Begründung', async () => {
    await env.call('PUT', `/api/plans/${planId}/exit-criteria`, { minPassRate: 100, maxOpenDefects: 0 });
    const r = (await env.call('GET', `/api/reports/completion/${planId}?format=json`)).body;
    assert.deepEqual(r.criteria.map((c: any) => [c.label, c.met]), [['Bestehensquote', true], ['Offene Fehler', true]]);
    assert.equal((await env.call('PUT', `/api/plans/${planId}/release-decision`, { decision: 'conditional', note: '' })).status, 400);
    const p = (await env.call('PUT', `/api/plans/${planId}/release-decision`, { decision: 'conditional', note: 'Layoutmangel bis Hotfix akzeptiert' })).body;
    assert.equal(p.releaseDecision, 'conditional');
    const html = await env.app.request(`/api/reports/completion/${planId}`, { headers: { 'x-anemo-user': 't' } });
    assert.match(await html.text(), /Freigabeentscheidung[\s\S]*Mit Auflagen freigegeben[\s\S]*Ausstiegskriterien[\s\S]*Restrisiken/);
  });

  it('abgelehnter Fehler: kein Nachtest, sondern bekannter Fehler; behobener: Nachtest im jüngsten offenen Zyklus, nur einmal', async () => {
    const e = await exec(cyc.sql!, 'FR-T2');
    await result(e.id, { status: 'FAIL', defects: [{ provider: 'jira', key: 'FR-1' }, { provider: 'jira', key: 'FR-2' }] });
    await env.db`update external_reference set status = 'Abgelehnt' where external_key = 'FR-1'`;
    const r = (await env.call('GET', `/api/reports/completion/${planId}?format=json`)).body;
    assert.deepEqual(r.knownDefects.map((d: any) => d.key), ['FR-1']);
    const newer = (await env.call('POST', '/api/projects/FR/cycles', { name: 'Lauf SQL 2', planId, configuration: { database: ['SQL Server'] } })).body.id;
    const id = await createRetest(env.db, e.id, { provider: 'jira', key: 'FR-2', title: null, status: 'Erledigt' }, 'test');
    assert.ok(id);
    const [x] = await env.db<{ cycleId: string }[]>`select cycle_id from test_execution where id = ${id!}`;
    assert.equal(x!.cycleId, newer, 'Nachtest im jüngsten offenen Zyklus gleicher Konfiguration');
    assert.equal(await createRetest(env.db, e.id, { provider: 'jira', key: 'FR-2', title: null, status: 'Erledigt' }, 'test'), null, 'nur einmal');
  });

  it('Nachtest nie in anderer Konfiguration; ohne Zielzyklus protokolliert und im Cockpit als „behoben, nicht nachgetestet“ (Review F4)', async () => {
    await env.call('POST', `/api/cycles/${cyc.ora}/executions`, { testCaseIds: ['FR-T3'] });
    const e = await exec(cyc.ora!, 'FR-T3');
    await result(e.id, { status: 'FAIL', defects: [{ provider: 'jira', key: 'FR-9' }] });
    // Oracle-Zyklus abschließen: es gibt nur noch offene SQL-Server-Zyklen
    await env.call('POST', `/api/cycles/${cyc.ora}/state`, { state: 'closed' });
    await env.db`update external_reference set status = 'Erledigt' where external_key = 'FR-9'`;
    assert.equal(await createRetest(env.db, e.id, { provider: 'jira', key: 'FR-9', title: null, status: 'Erledigt' }, 'test'), null, 'kein Nachtest unter SQL Server');
    const [missing] = await env.db`select payload from domain_event where type = 'RetestMissing' and aggregate_id = ${e.id}`;
    assert.equal(missing!.payload.defect, 'jira:FR-9');
    const cp = (await env.call('GET', `/api/plans/${planId}/cockpit`)).body;
    assert.ok(cp.retestPending.some((x: { key: string; defects: string[] }) => x.key === 'FR-T3' && x.defects.includes('FR-9')), JSON.stringify(cp.retestPending));
    assert.ok(cp.assessment.reasons.some((r: string) => /Nachtest steht aus/.test(r)));
    await env.call('POST', `/api/cycles/${cyc.ora}/state`, { state: 'active' });
  });

  it('abgeschlossener Zyklus sperrt Ergebnisse; veraltete Testfälle werden nicht eingeplant', async () => {
    await env.call('POST', `/api/cycles/${cyc.ora}/state`, { state: 'closed' });
    assert.equal((await result((await exec(cyc.ora!, 'FR-T2')).id, { status: 'PASS' })).status, 409);
    await env.call('POST', `/api/cycles/${cyc.ora}/state`, { state: 'active' });
    await env.db`update test_case set status = 'DEPRECATED' where key = 'FR-T4'`;
    const r = (await env.call('POST', `/api/cycles/${cyc.sql}/executions`, { testCaseIds: ['FR-T3', 'FR-T4'] })).body;
    assert.equal(r.added, 1);
    assert.deepEqual(r.skipped, ['FR-T4']);
    assert.ok(r.warnings.some((w: string) => /nicht freigegeben/.test(w)));
  });
});
