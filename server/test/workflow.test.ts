import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { updateTestCaseMeta } from '../src/modules/testcases/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Status & Workflow (A4)', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'WF', name: 'Workflow' });
    for (const title of ['Eins', 'Zwei']) await env.call('POST', '/api/projects/WF/test-cases', { content: { title, steps: [{ action: 'a', expected: 'b' }] } });
  });
  after(() => env.close());

  const patch = (key: string, status: string, user = 'tester') => env.call('PATCH', `/api/test-cases/${key}`, { status }, user);

  it('neue Testfälle starten im Ausgangsstatus; Übergänge folgen dem Workflow', async () => {
    assert.equal((await env.call('GET', '/api/test-cases/WF-T1')).body.status, 'DRAFT');
    const skip = await patch('WF-T1', 'APPROVED');
    assert.equal(skip.status, 400, 'Entwurf → Freigegeben ohne Review ist nicht vorgesehen');
    assert.match(skip.body.detail, /Erlaubt: Bereit zum Review/);
    assert.equal((await patch('WF-T1', 'READY')).status, 200);
    const self = await patch('WF-T1', 'APPROVED');
    assert.equal(self.status, 400, 'Vier-Augen-Prinzip: keine Selbstfreigabe');
    assert.match(self.body.detail, /Vier-Augen/);
    assert.equal((await patch('WF-T1', 'APPROVED', 'qa-lea')).status, 200);
    const tc = (await env.call('GET', '/api/test-cases/WF-T1')).body;
    assert.deepEqual([tc.approvedVersion, tc.approvedBy], [1, 'qa-lea']);
    // neue Version eines freigegebenen Testfalls → zurück in den Review, Freigabe entfällt
    await env.call('PUT', `/api/test-cases/WF-T1/content`, { content: { title: 'Eins geändert', steps: [{ action: 'a', expected: 'b' }] } });
    const after = (await env.call('GET', '/api/test-cases/WF-T1')).body;
    assert.equal(after.status, 'READY');
    assert.equal(after.approvedVersion, null);
    assert.equal((await patch('WF-T1', 'APPROVED', 'qa-lea')).status, 200);
    assert.equal((await patch('WF-T1', 'GIBTSNICHT')).status, 400);
  });

  it('migrierte Status landen im Katalog, Wechsel daraus ist frei', async () => {
    await updateTestCaseMeta(env.db, 'WF-T2', { status: 'Review!' }, 'migration');
    const wf = (await env.call('GET', '/api/test-case-workflow')).body;
    const s = wf.statuses.find((x: any) => x.code === 'Review!');
    assert.ok(s, 'Status registriert');
    assert.equal(s.inUse, 1);
    assert.equal((await patch('WF-T2', 'DEPRECATED')).status, 200, 'keine Regeln für migrierten Status → frei');
  });

  it('Administration: Status deaktivieren und Übergänge ersetzen', async () => {
    const wf = (await env.call('GET', '/api/test-case-workflow')).body;
    const ready = wf.statuses.find((x: any) => x.code === 'READY');
    assert.equal((await env.call('PUT', '/api/admin/test-case-statuses/READY', { ...ready, active: false, inUse: undefined, code: undefined })).status, 204);
    assert.equal((await patch('WF-T2', 'READY')).status, 400, 'deaktiviert');
    assert.equal((await env.call('PUT', '/api/admin/test-case-transitions', { transitions: [{ from: 'DEPRECATED', to: 'APPROVED' }] })).status, 204);
    assert.equal((await patch('WF-T2', 'DRAFT')).status, 400);
    assert.equal((await patch('WF-T2', 'APPROVED', 'qa-lea')).status, 200);
    const bulk = await env.call('POST', '/api/test-cases/bulk', { ids: ['WF-T1', 'WF-T2'], status: 'GIBTSNICHT' });
    assert.equal(bulk.status, 400, 'Massenbearbeitung prüft ebenso');
  });

  it('eigene Ausführungsstatus mit Kategorie wirken auf Ereignisse, Filter und Zulässigkeit', async () => {
    const put = (code: string, body: object) => env.call('PUT', `/api/admin/execution-statuses/${code}`, {
      name: code, color: '#aa3300', category: 'FAILED', appliesTo: 'both', active: true, sortOrder: 20, description: null, ...body,
    });
    assert.equal((await put('NACHTEST_NOETIG', { appliesTo: 'execution' })).status, 204);
    assert.equal((await put('NOT_EXECUTED', { category: 'PASSED' })).status, 400, 'Ausgangsstatus bleibt offen');
    const cycle = (await env.call('POST', '/api/projects/WF/cycles', { name: 'Lauf' })).body;
    await env.call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: ['WF-T1'] });
    const [exec] = (await env.call('GET', `/api/cycles/${cycle.id}/executions`)).body.items;
    const detail = (await env.call('GET', `/api/executions/${exec.id}`)).body;
    const stepOnly = await env.call('POST', `/api/executions/${exec.id}/result`, { status: 'PASS', stepResults: [{ stepId: detail.steps[0].id, status: 'NACHTEST_NOETIG' }] });
    assert.equal(stepOnly.status, 400, 'nur für Ausführungen zugelassen');
    assert.equal((await env.call('POST', `/api/executions/${exec.id}/result`, { status: 'NACHTEST_NOETIG', comment: 'Nachtest nötig' })).status, 200);
    const events = (await env.call('GET', `/api/events?aggregateId=${exec.id}`)).body.map((e: any) => e.type);
    assert.ok(events.includes('TestFailed'), 'Kategorie FAILED löst TestFailed aus');
    const failed = (await env.call('GET', '/api/projects/WF/cycles?state=failed')).body.items;
    assert.equal(failed.length, 1);
    assert.equal((await put('NACHTEST_NOETIG', { appliesTo: 'execution', active: false })).status, 204);
    assert.equal((await env.call('POST', `/api/executions/${exec.id}/result`, { status: 'NACHTEST_NOETIG', comment: 'bleibt' })).status, 200, 'bestehender Wert bleibt gültig');
    assert.equal((await env.call('POST', `/api/executions/${exec.id}/result`, { status: 'PASS' })).status, 200);
    assert.equal((await env.call('POST', `/api/executions/${exec.id}/result`, { status: 'NACHTEST_NOETIG' })).status, 400, 'deaktiviert');
    const list = (await env.call('GET', '/api/execution-statuses')).body;
    assert.equal(list.find((s: any) => s.code === 'BLOCKED').category, 'BLOCKED');
  });
});
