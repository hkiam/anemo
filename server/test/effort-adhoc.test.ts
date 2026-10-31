import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseEstimate } from '../src/modules/testcases/transfer.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Schätzung, Ad-hoc-Ausführung, Testplan klonen', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'EA', name: 'Aufwand' });
    for (const t of ['A', 'B', 'C']) await env.call('POST', '/api/projects/EA/test-cases', { content: { title: t, steps: [{ action: 'x', expected: 'y' }] } });
  });
  after(() => env.close());

  it('Schätzung setzen (einzeln, Masse), abfragen, aus Erfahrungswerten', async () => {
    await env.call('PATCH', '/api/test-cases/EA-T1', { estimateMinutes: 30 });
    const ids = (await env.call('GET', '/api/projects/EA/test-cases?idsOnly=true&limit=10&aql=' + encodeURIComponent('schätzung IST LEER'))).body.ids;
    assert.equal(ids.length, 2);
    assert.equal((await env.call('POST', '/api/test-cases/bulk', { ids, estimateMinutes: 45 })).body.updated, 2);
    const keys = (await env.call('GET', '/api/projects/EA/test-cases?aql=' + encodeURIComponent('schätzung > 40'))).body.items.map((t: any) => t.key).sort();
    assert.deepEqual(keys, ['EA-T2', 'EA-T3']);
    assert.equal(parseEstimate('1h 30m'), 90);
    assert.equal(parseEstimate('1,5 h'), 90);
    assert.equal(parseEstimate('2d'), 960);
    // Erfahrungswerte: zwei gemessene Ausführungen → Median
    const c = (await env.call('POST', '/api/projects/EA/cycles', { name: 'Mess' })).body;
    await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['EA-T1'] });
    const [e] = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items;
    await env.call('POST', `/api/executions/${e.id}/result`, { status: 'PASS', durationSeconds: 600 });
    const r = (await env.call('POST', '/api/test-cases/estimate-from-history', { ids: ['EA-T1'] })).body;
    assert.equal(r.updated, 0, 'eine Messung reicht nicht');
    await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['EA-T1'] }).catch(() => null);
    await env.db`insert into test_execution(cycle_id, test_case_id, test_case_version_id, order_no, status, duration_seconds)
      select cycle_id, test_case_id, test_case_version_id, 2, 'PASS', 1200 from test_execution where id = ${e.id}`;
    const r2 = (await env.call('POST', '/api/test-cases/estimate-from-history', { ids: ['EA-T1'] })).body;
    assert.equal(r2.updated, 1);
    assert.equal((await env.call('GET', '/api/test-cases/EA-T1')).body.estimateMinutes, 15, 'Median aus 10 und 20 Minuten');
    const ex = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body;
    assert.equal(ex.effort.plannedMinutes, 30, 'zwei Ausführungen × 15 min');
    assert.equal(ex.effort.withoutEstimate, 0);
  });

  it('Jetzt ausführen: Ad-hoc-Zyklus entsteht einmal, jede Ausführung eigener Eintrag', async () => {
    const a = (await env.call('POST', '/api/test-cases/EA-T2/run-adhoc', {}, 'tina')).body;
    const b = (await env.call('POST', '/api/test-cases/EA-T2/run-adhoc', {}, 'tina')).body;
    assert.equal(a.cycleId, b.cycleId);
    assert.notEqual(a.executionId, b.executionId);
    const cyc = (await env.call('GET', `/api/cycles/${a.cycleId}`)).body;
    assert.equal(cyc.name, 'Ad hoc');
    assert.equal(cyc.isAdhoc, true);
    const ex = (await env.call('GET', `/api/executions/${a.executionId}`)).body;
    assert.equal(ex.assignee, 'tina');
    // mit Testplan: eigener Ad-hoc-Zyklus des Plans
    const plan = (await env.call('POST', '/api/projects/EA/plans', { name: 'R2', release: '2.0' })).body;
    const c = (await env.call('POST', '/api/test-cases/EA-T2/run-adhoc', { planId: plan.id })).body;
    assert.notEqual(c.cycleId, a.cycleId);
    assert.equal((await env.call('GET', `/api/cycles/${c.cycleId}`)).body.name, 'Ad hoc – R2');
  });

  it('Testplan klonen mit Zyklen und Testfällen, ohne Ergebnisse', async () => {
    const plan = (await env.call('POST', '/api/projects/EA/plans', { name: 'R3', release: '3.0' })).body;
    await env.call('PUT', `/api/plans/${plan.id}/exit-criteria`, { minPassRate: 95 });
    const cyc = (await env.call('POST', '/api/projects/EA/cycles', { name: 'Regression', planId: plan.id })).body;
    await env.call('POST', `/api/cycles/${cyc.id}/executions`, { testCaseIds: ['EA-T1', 'EA-T3'] });
    const [e] = (await env.call('GET', `/api/cycles/${cyc.id}/executions`)).body.items;
    await env.call('POST', `/api/executions/${e.id}/result`, { status: 'PASS' });
    const r = (await env.call('POST', `/api/plans/${plan.id}/clone`, { name: 'R4', release: '4.0', withCycles: true })).body;
    assert.equal(r.cycles, 1);
    assert.equal(r.executions, 2);
    const np = (await env.call('GET', `/api/plans/${r.planId}`)).body;
    assert.equal(np.release, '4.0');
    assert.deepEqual(np.exitCriteria, { minPassRate: 95 });
    const cycles = (await env.call('GET', `/api/projects/EA/cycles?planId=${r.planId}`)).body.items;
    assert.equal(cycles[0].name, 'Regression');
    assert.deepEqual(cycles[0].byStatus, { NOT_EXECUTED: 2 });
  });
});
