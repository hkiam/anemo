import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Testfälle und Versionen (API)', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'QA', name: 'QA' });
  });
  after(() => env.close());

  const classic = {
    title: 'Akte öffnen',
    preconditions: 'Benutzer angemeldet',
    priority: 'Kritisch',
    labels: ['Akte'],
    steps: [
      { action: 'Benutzer anmelden', data: 'Admin', expected: 'Dashboard erscheint' },
      { action: 'Akte öffnen', data: '12345', expected: 'Akte wird angezeigt' },
    ],
  };

  it('legt einen Testfall mit Version 1 und Schlüssel an', async () => {
    const r = await env.call('POST', '/api/projects/QA/test-cases', { content: classic }, 'anna');
    assert.equal(r.status, 201);
    assert.equal(r.body.key, 'QA-T1');
    assert.equal(r.body.currentVersion, 1);
    assert.equal(r.body.createdBy, 'anna');
    assert.equal(r.body.version.steps.length, 2);
    assert.ok(r.body.version.steps.every((s: any) => s.id), 'Schritte erhalten stabile IDs');
  });

  it('erzeugt bei Inhaltsänderung eine neue Version, alte bleibt unverändert', async () => {
    const tc = (await env.call('GET', '/api/test-cases/QA-T1')).body;
    const steps = tc.version.steps.map((s: any, i: number) => (i === 1 ? { ...s, expected: 'Akte mit Dokumenten wird angezeigt' } : s));
    const r = await env.call('PUT', '/api/test-cases/QA-T1/content', {
      content: { ...tc.version, steps }, changeNote: 'Erwartung präzisiert', expectedVersion: 1,
    }, 'bert');
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, true);
    assert.equal(r.body.testCase.currentVersion, 2);
    assert.equal(r.body.testCase.version.steps[0].id, tc.version.steps[0].id, 'Schritt-ID bleibt erhalten');
    const v1 = (await env.call('GET', '/api/test-cases/QA-T1/versions/1')).body;
    assert.equal(v1.steps[1].expected, 'Akte wird angezeigt');
    const history = (await env.call('GET', '/api/test-cases/QA-T1/versions')).body;
    assert.deepEqual(history.map((h: any) => [h.versionNo, h.createdBy]), [[2, 'bert'], [1, 'anna']]);
  });

  it('erzeugt keine Version, wenn sich nichts geändert hat', async () => {
    const tc = (await env.call('GET', '/api/test-cases/QA-T1')).body;
    const r = await env.call('PUT', '/api/test-cases/QA-T1/content', { content: tc.version });
    assert.equal(r.body.changed, false);
    assert.equal(r.body.testCase.currentVersion, 2);
  });

  it('erkennt konkurrierende Änderungen (optimistische Sperre)', async () => {
    const tc = (await env.call('GET', '/api/test-cases/QA-T1')).body;
    const r = await env.call('PUT', '/api/test-cases/QA-T1/content', { content: { ...tc.version, title: 'X' }, expectedVersion: 1 });
    assert.equal(r.status, 400);
  });

  it('Verwaltungsdaten ändern erzeugt keine Version, aber ein Event', async () => {
    const r = await env.call('PATCH', '/api/test-cases/QA-T1', { status: 'READY', owner: 'anna' });
    assert.equal(r.body.status, 'READY');
    assert.equal(r.body.currentVersion, 2);
    const events = (await env.call('GET', `/api/events?aggregateId=${r.body.id}`)).body;
    assert.deepEqual(events.map((e: any) => e.type), ['TestCaseCreated', 'TestCaseChanged', 'TestCaseMetaChanged']);
  });

  it('unterstützt Gherkin-Testfälle mit Validierung', async () => {
    const bad = await env.call('POST', '/api/projects/QA/test-cases', { content: { title: 'G', format: 'GHERKIN', gherkin: 'Funktionalität: X\n  Szenario: A\n    Unsinn' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.issues.some((i: any) => /Zeile 3/.test(i.message)));

    const gherkin = '# language: de\nFunktionalität: Ablage\n  Szenario: PDF ablegen\n    Angenommen eine geöffnete Akte\n    Wenn ein PDF hochgeladen wird\n    Dann liegt das Dokument in der Akte\n';
    const ok = await env.call('POST', '/api/projects/QA/test-cases', { content: { title: 'PDF ablegen', format: 'GHERKIN', gherkin } });
    assert.equal(ok.status, 201);
    const detail = (await env.call('GET', `/api/test-cases/${ok.body.key}`)).body;
    assert.equal(detail.executionSteps.length, 3);
    assert.match(detail.executionSteps[2].expected, /liegt das Dokument/);
  });

  it('wandelt klassisch in Gherkin um, ohne zu speichern', async () => {
    const r = await env.call('POST', '/api/gherkin/from-classic', classic);
    assert.equal(r.status, 200);
    assert.match(r.body.gherkin, /Szenario: Akte öffnen/);
    const tc = (await env.call('GET', '/api/test-cases/QA-T1')).body;
    assert.equal(tc.version.format, 'CLASSIC');
  });

  it('sucht per Volltext, Schlüssel und Label', async () => {
    const byText = (await env.call('GET', '/api/projects/QA/test-cases?q=Dashboard')).body;
    assert.deepEqual(byText.items.map((i: any) => i.key), ['QA-T1']);
    const stemmed = (await env.call('GET', '/api/projects/QA/test-cases?q=Dokumenten')).body;
    assert.deepEqual(stemmed.items.map((i: any) => i.key).sort(), ['QA-T1', 'QA-T2'], 'deutsches Stemming: Dokumenten ≈ Dokument');
    const byKey = (await env.call('GET', '/api/projects/QA/test-cases?q=qa-t2')).body;
    assert.equal(byKey.total, 1);
    const byLabel = (await env.call('GET', '/api/projects/QA/test-cases?label=Akte')).body;
    assert.equal(byLabel.total, 1);
  });

  it('Ordner, Klonen und Massenbearbeitung', async () => {
    const folder = (await env.call('POST', '/api/projects/QA/folders', { name: 'Regression' })).body;
    const sub = (await env.call('POST', '/api/projects/QA/folders', { name: 'Akte', parentId: folder.id })).body;
    const clone = (await env.call('POST', '/api/test-cases/QA-T1/clone')).body;
    assert.match(clone.version.title, /\(Kopie\)/);
    assert.equal(clone.version.changeNote, 'Kopie von QA-T1@v2');
    const bulk = await env.call('POST', '/api/test-cases/bulk', { ids: ['QA-T1', clone.key], folderId: sub.id, addLabels: ['Regression'] });
    assert.equal(bulk.body.updated, 2);
    const inTree = (await env.call('GET', `/api/projects/QA/test-cases?folderId=${folder.id}&recursive=true`)).body;
    assert.equal(inTree.total, 2);
    const t1 = (await env.call('GET', '/api/test-cases/QA-T1')).body;
    assert.deepEqual(t1.version.labels, ['Akte', 'Regression']);
    assert.equal(t1.currentVersion, 3);
  });

  it('liefert 404 und OpenAPI', async () => {
    assert.equal((await env.call('GET', '/api/test-cases/QA-T999')).status, 404);
    const doc = (await env.call('GET', '/api/openapi.json')).body;
    assert.ok(doc.paths['/api/test-cases/{id}/content'].put);
  });
});
