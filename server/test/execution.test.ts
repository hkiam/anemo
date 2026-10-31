import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Planung und Ausführung (API)', () => {
  let env: TestEnv;
  let cycleId: string;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'EX', name: 'Exec' });
    await env.call('POST', '/api/projects/EX/test-cases', {
      content: { title: 'Login', steps: [{ action: 'Anmelden', expected: 'Startseite' }, { action: 'Abmelden', expected: 'Login-Maske' }] },
    });
    await env.call('POST', '/api/projects/EX/test-cases', {
      content: { title: 'Gherkin', format: 'GHERKIN', gherkin: 'Feature: F\n  Scenario: S\n    Given a\n    When b\n    Then c\n' },
    });
  });
  after(() => env.close());

  it('legt Plan und Zyklus an und nimmt Tests auf', async () => {
    const plan = (await env.call('POST', '/api/projects/EX/plans', { name: 'Release 7.4', release: '7.4' })).body;
    const cycle = await env.call('POST', '/api/projects/EX/cycles', { name: 'Regression', planId: plan.id, release: '7.4', startDate: '2026-10-12' });
    assert.equal(cycle.status, 201);
    cycleId = cycle.body.id;
    const added = await env.call('POST', `/api/cycles/${cycleId}/executions`, { testCaseIds: ['EX-T1', 'EX-T2', 'EX-T1'] });
    assert.equal(added.body.added, 2, 'doppelte Aufnahme wird ignoriert');
    const cycles = (await env.call('GET', '/api/projects/EX/cycles')).body.items;
    assert.deepEqual([cycles[0].total, cycles[0].byStatus], [2, { NOT_EXECUTED: 2 }]);
  });

  it('erfasst Ergebnis mit Schrittergebnissen und Defect, Event TestFailed', async () => {
    const [exec] = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body.items;
    const detail = (await env.call('GET', `/api/executions/${exec.id}`)).body;
    const r = await env.call('POST', `/api/executions/${exec.id}/result`, {
      status: 'FAIL', comment: 'Abmelden hängt',
      stepResults: [{ stepId: detail.steps[0].id, status: 'PASS' }, { stepId: detail.steps[1].id, status: 'FAIL', comment: 'Timeout' }],
      defects: [{ provider: 'jira', key: 'EX-99' }],
    }, 'carla');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'FAIL');
    assert.equal(r.body.executedBy, 'carla');
    assert.deepEqual(r.body.defects.map((d: any) => [d.externalKey, d.relation]), [['EX-99', 'DEFECT']]);
    const events = (await env.call('GET', `/api/events?aggregateId=${exec.id}`)).body.map((e: any) => e.type);
    assert.deepEqual(events, ['ReferenceLinked', 'TestExecuted', 'TestFailed']);
    const back = (await env.call('GET', '/api/references/by-key/jira/EX-99')).body;
    assert.equal(back[0].ownerId, exec.id);
  });

  it('lehnt fremde Schritt-IDs und unbekannte Status ab', async () => {
    const [exec] = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body.items;
    assert.equal((await env.call('POST', `/api/executions/${exec.id}/result`, { status: 'GIBTSNICHT' })).status, 400);
    assert.equal((await env.call('POST', `/api/executions/${exec.id}/result`, { status: 'PASS', stepResults: [{ stepId: 'x', status: 'PASS' }] })).status, 400);
  });

  it('historische Ausführung bleibt an ihrer Version, wenn der Testfall geändert wird', async () => {
    const tc = (await env.call('GET', '/api/test-cases/EX-T1')).body;
    await env.call('PUT', '/api/test-cases/EX-T1/content', { content: { ...tc.version, title: 'Login (neu)' } });
    const execs = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body.items;
    const e1 = execs.find((e: any) => e.testCaseKey === 'EX-T1');
    assert.deepEqual([e1.title, e1.versionNo, e1.currentVersion], ['Login', 1, 2]);
    assert.equal((await env.call('POST', `/api/executions/${e1.id}/update-version`)).status, 400, 'ausgeführte Ergebnisse werden nicht umgehängt');
    const hist = (await env.call('GET', '/api/test-cases/EX-T1/executions')).body;
    assert.deepEqual([hist[0].status, hist[0].versionNo], ['FAIL', 1]);
  });

  it('Gherkin-Testfall wird schrittweise ausgeführt', async () => {
    const execs = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body.items;
    const e2 = execs.find((e: any) => e.testCaseKey === 'EX-T2');
    const detail = (await env.call('GET', `/api/executions/${e2.id}`)).body;
    assert.equal(detail.steps.length, 3);
    const r = await env.call('POST', `/api/executions/${e2.id}/result`, {
      status: 'PASS', stepResults: detail.steps.map((s: any) => ({ stepId: s.id, status: 'PASS' })),
    });
    assert.equal(r.status, 200);
  });

  it('filtert Zyklen und Ausführungen serverseitig, mit Kennzahlen und Facetten', async () => {
    const plan = (await env.call('GET', '/api/projects/EX/plans')).body[0];
    assert.equal(plan.cycleCount, 1);
    assert.deepEqual(plan.byStatus, { FAIL: 1, PASS: 1 });
    await env.call('POST', '/api/projects/EX/cycles', { name: 'Smoke Oracle', environment: 'ORA', build: '7.4.1', startDate: '2026-11-01' });
    const byText = (await env.call('GET', '/api/projects/EX/cycles?q=oracle')).body;
    assert.deepEqual(byText.items.map((c: any) => c.name), ['Smoke Oracle']);
    assert.equal((await env.call('GET', '/api/projects/EX/cycles?environment=ORA')).body.total, 1);
    assert.equal((await env.call('GET', '/api/projects/EX/cycles?state=failed')).body.items[0].name, 'Regression');
    assert.equal((await env.call('GET', '/api/projects/EX/cycles?planId=none')).body.total, 1);
    const facets = (await env.call('GET', '/api/projects/EX/cycle-facets')).body;
    assert.deepEqual(facets.environments, [{ value: 'ORA', count: 1 }]);

    const failed = (await env.call('GET', `/api/cycles/${cycleId}/executions?status=FAIL`)).body;
    assert.equal(failed.total, 1);
    assert.deepEqual(failed.byStatus, { FAIL: 1, PASS: 1 });
    assert.equal((await env.call('GET', `/api/cycles/${cycleId}/executions?withDefects=true`)).body.total, 1);
    assert.equal((await env.call('GET', `/api/cycles/${cycleId}/executions?q=hängt`)).body.total, 1, 'Suche im Kommentar');
    assert.equal((await env.call('GET', `/api/cycles/${cycleId}/executions?outdated=true`)).body.total, 1);
  });

  it('weist Ausführungen massenhaft zu und findet "meine" offenen Ausführungen', async () => {
    const cycle = (await env.call('GET', '/api/projects/EX/cycles?q=oracle')).body.items[0];
    await env.call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: ['EX-T1', 'EX-T2'] });
    const ids = (await env.call('GET', `/api/cycles/${cycle.id}/executions`)).body.items.map((e: any) => e.id);
    assert.equal((await env.call('POST', '/api/executions/bulk-assign', { ids, assignee: 'dora' })).body.updated, 2);
    const mine = (await env.call('GET', '/api/projects/EX/executions?assignee=me&status=NOT_EXECUTED', undefined, 'dora')).body;
    assert.equal(mine.total, 2);
    assert.equal(mine.items[0].cycleName, 'Smoke Oracle');
    const byAssignee = (await env.call('GET', `/api/cycles/${cycle.id}/executions?assignee=dora`)).body;
    assert.deepEqual(byAssignee.byAssignee, { dora: 2 });
  });

  it('ändert Testpläne und löscht nur leere', async () => {
    const plan = (await env.call('GET', '/api/projects/EX/plans')).body[0];
    const changed = await env.call('PUT', `/api/plans/${plan.id}`, { name: 'Release 7.4 (LTS)', release: '7.4', description: 'Langzeitversion' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.name, 'Release 7.4 (LTS)');
    assert.equal((await env.call('DELETE', `/api/plans/${plan.id}`)).status, 409);
    const empty = (await env.call('POST', '/api/projects/EX/plans', { name: 'Leer' })).body;
    assert.equal((await env.call('DELETE', `/api/plans/${empty.id}`)).status, 204);
    assert.equal((await env.call('GET', `/api/plans/${empty.id}`)).status, 404);
  });

  it('liefert die Ergebnis-Matrix eines Testplans (Testfall × Zyklus)', async () => {
    const plan = (await env.call('GET', '/api/projects/EX/plans')).body[0];
    const m = (await env.call('GET', `/api/plans/${plan.id}/matrix`)).body;
    assert.equal(m.cycles.length, 1);
    assert.equal(m.rows.length, 2);
    const problems = (await env.call('GET', `/api/plans/${plan.id}/matrix?onlyProblems=true`)).body;
    assert.deepEqual(problems.rows.map((r: any) => r.key), ['EX-T1']);
  });

  it('übergreifende Suche findet Testfälle, Zyklen, Kommentare, Defects', async () => {
    const r = (await env.call('GET', '/api/search?q=EX-99')).body;
    const ref = r.groups.find((g: any) => g.type === 'reference');
    assert.equal(ref.total, 1);
    assert.ok(ref.items[0].target.executionId);
    const byKey = (await env.call('GET', '/api/search?q=ex-t1&types=testcase')).body;
    assert.equal(byKey.groups[0].items[0].target.testCase, 'EX-T1');
    const cyc = (await env.call('GET', '/api/search?q=Oracle&types=cycle')).body;
    assert.equal(cyc.groups[0].items[0].title, 'Smoke Oracle');
    const comment = (await env.call('GET', '/api/search?q=Abmelden hängt&types=execution')).body;
    assert.equal(comment.groups[0].total, 1);
    assert.equal((await env.call('GET', '/api/search?q=x')).status, 400);
  });
});
