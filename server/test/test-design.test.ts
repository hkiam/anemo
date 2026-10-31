import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Testdesign: Vorbedingungen, Aufrufe, Schritt-Anhänge, Diskussion, Datensatz-Überschreibung', () => {
  let env: TestEnv;
  let login: any;
  let print: any;
  let pre: any;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'TD', name: 'Testdesign' });
  });
  after(() => env.close());

  it('Vorbedingungen: anlegen, versioniert ändern, in Testfällen verwenden, archivieren', async () => {
    pre = (await env.call('POST', '/api/projects/TD/preconditions', { title: 'Testmandant vorbereitet', content: 'Mandant *M1* mit Akte 4711' })).body;
    assert.equal(pre.key, 'TD-P1');
    login = (await env.call('POST', '/api/projects/TD/test-cases', { content: { title: 'Anmelden', preconditionIds: [pre.id], steps: [{ action: 'Login', expected: 'Start' }, { action: 'Menü öffnen', expected: 'Menü' }] } })).body;
    const changed = (await env.call('PUT', `/api/preconditions/${pre.id}`, { title: 'Testmandant vorbereitet', content: 'Mandant M1 mit Akte 4711 und 4712', changeNote: 'zweite Akte' })).body;
    assert.equal(changed.currentVersion, 2);
    const detail = (await env.call('GET', `/api/preconditions/${pre.key}`)).body;
    assert.deepEqual(detail.usedBy.map((u: any) => u.key), ['TD-T1']);
    assert.equal(detail.versions.length, 2);
    assert.equal((await env.call('GET', '/api/projects/TD/preconditions')).body[0].usage, 1);
    assert.equal((await env.call('DELETE', `/api/preconditions/${pre.id}`)).status, 400, 'verwendet → archivieren');
    const other = (await env.call('POST', '/api/projects/TD/preconditions', { title: 'Alt' })).body;
    await env.call('POST', `/api/preconditions/${other.id}/archive`, { archived: true });
    const bad = await env.call('POST', '/api/projects/TD/test-cases', { content: { title: 'x', preconditionIds: [other.id] } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.detail, /Archivierte/);
  });

  it('Aufrufbare Tests: Schritte werden eingesetzt, Version festgeschrieben, Ringaufrufe verhindert', async () => {
    print = (await env.call('POST', '/api/projects/TD/test-cases', { content: { title: 'Drucken', steps: [
      { action: '', call: { testCaseId: login.id } },
      { action: 'Drucken klicken', expected: 'Druckdialog' },
    ] } })).body;
    assert.equal(print.version.steps[0].call.versionNo, 1, 'aktuelle Version des aufgerufenen Testfalls festgeschrieben');
    assert.match(print.version.steps[0].action, /TD-T1/);
    const full = (await env.call('GET', `/api/test-cases/${print.key}`)).body;
    assert.deepEqual(full.executionSteps.map((s: any) => s.action), ['Login', 'Menü öffnen', 'Drucken klicken']);
    assert.equal(full.executionSteps[0].origin.key, 'TD-T1');
    assert.match(full.executionSteps[0].id, />/);
    // Ring: Anmelden ruft Drucken auf → abgelehnt
    const ring = await env.call('PUT', `/api/test-cases/${login.key}/content`, { content: { title: 'Anmelden', steps: [{ action: '', call: { testCaseId: print.id } }] } });
    assert.equal(ring.status, 400);
    assert.match(ring.body.detail, /Ringaufrufe/);
    const self = await env.call('PUT', `/api/test-cases/${print.key}/content`, { content: { title: 'Drucken', steps: [{ action: '', call: { testCaseId: print.id } }] } });
    assert.match(self.body.detail, /selbst/);
    // Durchführung: Schrittergebnisse für eingesetzte Schritte
    const cyc = (await env.call('POST', '/api/projects/TD/cycles', { name: 'Lauf' })).body;
    await env.call('POST', `/api/cycles/${cyc.id}/executions`, { testCaseIds: [print.key] });
    const [e] = (await env.call('GET', `/api/cycles/${cyc.id}/executions`)).body.items;
    const ex = (await env.call('GET', `/api/executions/${e.id}`)).body;
    assert.equal(ex.steps.length, 3);
    assert.deepEqual(ex.preconditions, [], 'Vorbedingungen stehen am aufrufenden Testfall');
    const r = await env.call('POST', `/api/executions/${e.id}/result`, { status: 'PASS', stepResults: ex.steps.map((s: any) => ({ stepId: s.id, status: 'PASS' })) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // neue Version des aufgerufenen Testfalls ändert bestehende Ausführungen nicht
    await env.call('PUT', `/api/test-cases/${login.key}/content`, { content: { title: 'Anmelden', preconditionIds: [pre.id], steps: [{ action: 'Login neu', expected: 'Start' }] } });
    assert.equal((await env.call('GET', `/api/executions/${e.id}`)).body.steps[0].action, 'Login');
  });

  it('Anhänge an Schritten', async () => {
    const step = login.version.steps[0];
    const r = await env.call('POST', '/api/attachments/base64', { ownerType: 'TEST_CASE', ownerId: login.id, fileName: 'login.png', contentType: 'image/png', contentBase64: Buffer.from('png').toString('base64'), stepId: step.id });
    assert.equal(r.status, 201);
    assert.equal(r.body.stepId, step.id);
    const list = (await env.call('GET', `/api/attachments?ownerType=TEST_CASE&ownerId=${login.id}`)).body;
    assert.equal(list[0].stepId, step.id);
  });

  it('Diskussion: Anmerkung, Antwort, erledigt, Rechte', async () => {
    await env.call('POST', '/api/users', { username: 'qa-lea', displayName: 'Lea', password: 'geheim-12345' }).catch(() => null);
    const c = (await env.call('POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: print.id, versionNo: 1, body: 'Schritt 2: Erwartung präzisieren @qa-lea' })).body;
    assert.equal(c.versionNo, 1);
    const reply = await env.call('POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: print.id, parentId: c.id, body: 'Erledigt in v2' }, 'qa-lea');
    assert.equal(reply.status, 201);
    assert.equal((await env.call('POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: print.id, parentId: reply.body.id, body: 'zu tief' })).status, 400);
    assert.equal((await env.call('PATCH', `/api/comments/${c.id}`, { body: 'fremd' }, 'qa-lea')).status, 403, 'nur eigene ändern');
    const done = (await env.call('PATCH', `/api/comments/${c.id}`, { resolved: true })).body;
    assert.ok(done.resolvedAt);
    const list = (await env.call('GET', `/api/comments?ownerType=TEST_CASE&ownerId=${print.id}`)).body;
    assert.equal(list.length, 2);
    const ev = (await env.call('GET', `/api/events?aggregateId=${print.id}`)).body.find((x: any) => x.type === 'CommentAdded');
    assert.ok(ev, 'Ereignis für Webhooks/Benachrichtigung');
  });

  it('Datensatz je Testplan bzw. Zyklus überschreiben (Zyklus vor Plan vor Testfall)', async () => {
    const tc = (await env.call('POST', '/api/projects/TD/test-cases', { content: { title: 'Je Rolle', steps: [{ action: 'Als ${rolle} anmelden', expected: 'ok' }],
      dataset: { columns: ['rolle'], rows: [['Admin'], ['Leser']] } } })).body;
    const plan = (await env.call('POST', '/api/projects/TD/plans', { name: 'R1' })).body;
    const cyc = (await env.call('POST', '/api/projects/TD/cycles', { name: 'Lauf R1', planId: plan.id })).body;
    await env.call('POST', `/api/cycles/${cyc.id}/executions`, { testCaseIds: [tc.key] });
    const [e] = (await env.call('GET', `/api/cycles/${cyc.id}/executions`)).body.items;
    assert.equal((await env.call('GET', `/api/executions/${e.id}`)).body.datasetSource, 'testcase');
    const bad = await env.call('PUT', '/api/dataset-overrides', { scope: 'plan', scopeId: plan.id, testCaseId: tc.id, dataset: { columns: ['user'], rows: [['x']] } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.detail, /rolle/);
    await env.call('PUT', '/api/dataset-overrides', { scope: 'plan', scopeId: plan.id, testCaseId: tc.id, dataset: { columns: ['rolle'], rows: [['Admin'], ['Leser'], ['Gast']] } });
    let ex = (await env.call('GET', `/api/executions/${e.id}`)).body;
    assert.equal(ex.datasetSource, 'plan');
    assert.equal(ex.dataset.rows.length, 3);
    await env.call('PUT', '/api/dataset-overrides', { scope: 'cycle', scopeId: cyc.id, testCaseId: tc.id, dataset: { columns: ['rolle'], rows: [['Prüfer']] } });
    ex = (await env.call('GET', `/api/executions/${e.id}`)).body;
    assert.equal(ex.datasetSource, 'cycle');
    assert.deepEqual(ex.dataset.rows, [['Prüfer']]);
    const ds = (await env.call('GET', `/api/executions/${e.id}/datasets`)).body;
    assert.equal(ds.testCase.rows.length, 2);
    assert.equal(ds.plan.rows.length, 3);
    await env.call('PUT', '/api/dataset-overrides', { scope: 'cycle', scopeId: cyc.id, testCaseId: tc.id, dataset: null });
    assert.equal((await env.call('GET', `/api/executions/${e.id}`)).body.datasetSource, 'plan');
  });
});
