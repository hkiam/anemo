import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Auswertungen: Abdeckung zum Stichtag, Top-Fehler, Team/Aufwand, Portfolio', () => {
  let env: TestEnv;
  let plan: any;
  let execs: any[];
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'IN', name: 'Insights' });
    await env.call('POST', '/api/projects', { key: 'IX', name: 'Zweites' });
    for (const t of ['A', 'B', 'C']) await env.call('POST', '/api/projects/IN/test-cases', { content: { title: t, steps: [{ action: 'x', expected: 'y' }] } });
    for (const [k, req] of [['IN-T1', 'REQ-1'], ['IN-T2', 'REQ-2'], ['IN-T3', 'REQ-2']]) {
      const tc = (await env.call('GET', `/api/test-cases/${k}`)).body;
      await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc.id, provider: 'jira', externalKey: req, relation: 'REQUIREMENT' });
    }
    await env.call('PATCH', '/api/test-cases/IN-T1', { estimateMinutes: 30 });
    plan = (await env.call('POST', '/api/projects/IN/plans', { name: 'R1' })).body;
    const cyc = (await env.call('POST', '/api/projects/IN/cycles', { name: 'Lauf', planId: plan.id })).body;
    await env.call('POST', `/api/cycles/${cyc.id}/executions`, { testCaseIds: ['IN-T1', 'IN-T2', 'IN-T3'] });
    execs = (await env.call('GET', `/api/cycles/${cyc.id}/executions`)).body.items;
    await env.call('POST', '/api/executions/bulk-assign', { ids: execs.map((e: any) => e.id), assignee: 'lea' });
    await env.call('POST', `/api/executions/${execs[0].id}/result`, { status: 'PASS', durationSeconds: 900 }, 'lea');
    await env.call('POST', `/api/executions/${execs[1].id}/result`, { status: 'FAIL', comment: 'kaputt', defects: [{ provider: 'jira', key: 'BUG-1' }] }, 'lea');
    await env.call('POST', `/api/executions/${execs[2].id}/result`, { status: 'FAIL', comment: 'auch', defects: [{ provider: 'jira', key: 'BUG-1' }] }, 'lea');
  });
  after(() => env.close());

  it('Abdeckung heute und zum Stichtag vor den Ergebnissen', async () => {
    const now = (await env.call('GET', `/api/reports/traceability/${plan.id}?format=json`)).body;
    assert.deepEqual(now.totals, { OK: 1, NOK: 1, NOT_RUN: 0, UNCOVERED: 0 });
    // Zyklus vor 20 Tagen geplant; REQ-2 vor 10 Tagen fehlgeschlagen, REQ-1 erst heute bestanden
    await env.db`update test_execution set created_at = now() - interval '20 days' where id = any(${execs.map((e: any) => e.id)}::uuid[])`;
    await env.db`update execution_result set recorded_at = now() - interval '10 days' where execution_id = ${execs[1].id}`;
    await env.db`update execution_result set recorded_at = now() - interval '10 days' where execution_id = ${execs[2].id}`;
    const past = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    const then = (await env.call('GET', `/api/reports/traceability/${plan.id}?format=json&asOf=${past}`)).body;
    assert.deepEqual(then.totals, { OK: 0, NOK: 1, NOT_RUN: 1, UNCOVERED: 0 }, 'REQ-1 vor 5 Tagen noch nicht getestet');
    const hist = (await env.call('GET', `/api/plans/${plan.id}/coverage-history?weeks=3`)).body;
    assert.equal(hist.length, 3);
    assert.deepEqual(hist.at(-1).OK, 1);
    const html = await (await env.app.request(`/api/reports/traceability/${plan.id}?asOf=${past}`, { headers: { 'x-anemo-user': 'tester' } })).text();
    assert.match(html, /Stichtag/);
  });

  it('Top-Fehler mit betroffenen Testfällen und Anforderungen', async () => {
    const top = (await env.call('GET', '/api/projects/IN/top-defects')).body;
    assert.equal(top[0].externalKey, 'BUG-1');
    assert.equal(top[0].testCases, 2);
    assert.deepEqual(top[0].requirements, ['REQ-2']);
    assert.equal(top[0].resolution, 'open');
    const x = await env.app.request('/api/projects/IN/top-defects?format=xlsx', { headers: { 'x-anemo-user': 'tester' } });
    assert.match(x.headers.get('content-type')!, /spreadsheet/);
  });

  it('Team und Aufwand', async () => {
    const w = (await env.call('GET', `/api/projects/IN/workload?planId=${plan.id}`)).body;
    const lea = w.byAssignee.find((a: any) => a.assignee === 'lea');
    assert.deepEqual([lea.total, lea.open, lea.passed, lea.problems, lea.durationSeconds, lea.plannedMinutes, lea.withoutEstimate], [3, 0, 1, 2, 900, 30, 2]);
    assert.equal(w.byTester[0].executedBy, 'lea');
    assert.equal(w.byTester[0].week, 3);
  });

  it('Portfolio über sichtbare Projekte', async () => {
    const p = (await env.call('GET', '/api/portfolio')).body;
    const inn = p.find((x: any) => x.key === 'IN');
    assert.deepEqual([inn.testCases, inn.activeCycles, inn.executed30, inn.passRate30, inn.openDefects], [3, 1, 3, 33.3, 1]);
    assert.ok(p.some((x: any) => x.key === 'IX'));
  });
});
