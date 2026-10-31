import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

const step = [{ action: 'Anmelden', expected: 'Startseite erscheint' }];

describe('Stufe H: Felder, Prioritäten, Abfrage, Massenbearbeitung, Archivieren/Löschen', () => {
  let env: TestEnv;
  let cycleId: string;
  const tc = async (title: string, extra: Record<string, unknown> = {}) =>
    (await env.call('POST', '/api/projects/HH/test-cases', { content: { title, steps: step, ...extra } }));
  const keys = async (aql: string, extra = '') =>
    (await env.call('GET', `/api/projects/HH/test-cases?limit=100&aql=${encodeURIComponent(aql)}${extra}`)).body.items.map((t: any) => t.key).sort();
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'HH', name: 'Stufe H' });
  });
  after(() => env.close());

  it('Prioritäten als Werteliste; übernommene Werte bleiben, neue müssen in der Liste stehen', async () => {
    const list = (await env.call('GET', '/api/priorities')).body;
    assert.deepEqual(list.map((p: any) => p.code), ['Blocker', 'Kritisch', 'Schwer', 'Unwesentlich', 'Trivial']);
    assert.equal(list.find((p: any) => p.isDefault).code, 'Schwer');
    const bad = await tc('Prio falsch', { priority: 'Hoch' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.detail, /Werteliste/);
    assert.equal((await tc('Anmelden Admin', { priority: 'kritisch', labels: ['smoke'] })).body.version.priority, 'Kritisch', 'Groß-/Kleinschreibung wird angeglichen');
    assert.equal((await env.call('PUT', '/api/admin/priorities/Hoch', { color: '#ff0000', sortOrder: 15, isDefault: false, active: true })).status, 204);
    assert.equal((await tc('Anmelden Gast', { priority: 'Hoch', labels: ['smoke', 'gast'] })).status, 201);
    assert.equal((await env.call('DELETE', '/api/admin/priorities/Hoch')).status, 400, 'verwendet → nur deaktivieren');
  });

  it('eigene Felder: Typen, Auswahlwerte, Pflicht; Kandidaten aus übernommenen Werten', async () => {
    const team = (await env.call('POST', '/api/admin/fields', { scope: 'test_case', key: 'Team', name: 'Team', type: 'select', options: ['Alpha', 'Beta'], required: true })).body;
    await env.call('POST', '/api/admin/fields', { scope: 'test_case', key: 'Plattform', name: 'Plattform', type: 'multiselect', options: ['Web', 'Windows'] });
    await env.call('POST', '/api/admin/fields', { scope: 'test_case', key: 'Aufwand', name: 'Aufwand (h)', type: 'number' });
    const missing = await tc('Ohne Team');
    assert.equal(missing.status, 400);
    assert.match(missing.body.detail, /Team.*Pflichtfeld/);
    assert.equal((await tc('Falsches Team', { customFields: { Team: 'Gamma' } })).status, 400);
    const ok = await tc('Drucken', { customFields: { Team: 'alpha', Plattform: 'web, Windows', Aufwand: '1,5', Zielversion: '7.4' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.version.customFields, { Team: 'Alpha', Plattform: ['Web', 'Windows'], Aufwand: 1.5, Zielversion: '7.4' });
    const cands = (await env.call('GET', '/api/admin/field-candidates')).body;
    const zv = cands.find((c: any) => c.key === 'Zielversion');
    assert.ok(zv, 'nicht definierter Schlüssel ist Kandidat');
    assert.equal(zv.suggestedType, 'select');
    assert.ok(!cands.some((c: any) => c.key === 'Team'), 'definierte Felder sind keine Kandidaten');
    // Pflichtfeld nachträglich: bestehende Testfälle ohne Wert lassen sich erst nach Ergänzung ändern
    assert.equal((await env.call('PUT', `/api/admin/fields/${team.id}`, { scope: 'test_case', key: 'Team', name: 'Team', type: 'select', options: ['Alpha', 'Beta'], required: false })).status, 200);
  });

  it('Zyklus- und Ausführungsfelder', async () => {
    await env.call('POST', '/api/admin/fields', { scope: 'cycle', key: 'Testumgebung', name: 'Testumgebung', type: 'select', options: ['QS', 'Abnahme'] });
    await env.call('POST', '/api/admin/fields', { scope: 'execution', key: 'Datenstand', name: 'Datenstand', type: 'date' });
    const c = await env.call('POST', '/api/projects/HH/cycles', { name: 'Lauf H', customFields: { Testumgebung: 'qs' } });
    assert.equal(c.status, 201);
    cycleId = c.body.id;
    assert.deepEqual(c.body.customFields, { Testumgebung: 'QS' });
    const all = (await env.call('GET', '/api/projects/HH/test-cases?limit=100')).body.items.map((t: any) => t.key);
    await env.call('POST', `/api/cycles/${cycleId}/executions`, { testCaseIds: all });
    const [e] = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body.items;
    const r = await env.call('PUT', `/api/executions/${e.id}/fields`, { values: { Datenstand: '01.10.2026' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.customFields.Datenstand, '2026-10-01');
    assert.equal((await env.call('PUT', `/api/executions/${e.id}/fields`, { values: { Datenstand: 'gestern' } })).status, 400);
  });

  it('Abfragesprache für Testfälle', async () => {
    assert.deepEqual(await keys('priorität = Kritisch'), ['HH-T1']);
    assert.deepEqual(await keys('label IN (gast, nichtda)'), ['HH-T2']);
    assert.deepEqual(await keys('label = smoke UND NICHT label = gast'), ['HH-T1']);
    assert.deepEqual(await keys('feld.Team = alpha'), ['HH-T3']);
    assert.deepEqual(await keys('feld.Aufwand > 1'), ['HH-T3']);
    assert.deepEqual(await keys('feld.Plattform = Windows'), ['HH-T3']);
    assert.deepEqual(await keys('titel ~ anmelden ODER titel = drucken'), ['HH-T1', 'HH-T2', 'HH-T3']);
    assert.deepEqual(await keys('priorität >= Hoch'), ['HH-T2'], 'Hoch (Sortierung 15) und wichtiger (Blocker)');
    assert.deepEqual(await keys('priorität > Schwer'), ['HH-T1', 'HH-T2']);
    assert.deepEqual(await keys('kategorie = Entwurf UND erstellt > -1d UND ersteller = ich()'), ['HH-T1', 'HH-T2', 'HH-T3']);
    assert.deepEqual(await keys('Gast'), ['HH-T2'], 'freies Wort = Volltext');
    const sorted = (await env.call('GET', `/api/projects/HH/test-cases?aql=${encodeURIComponent('label = smoke SORTIERT NACH titel AB')}`)).body.items.map((t: any) => t.key);
    assert.deepEqual(sorted, ['HH-T2', 'HH-T1']);
    const err = await env.call('GET', `/api/projects/HH/test-cases?aql=${encodeURIComponent('sttus = Entwurf')}`);
    assert.equal(err.status, 400);
    assert.match(err.body.detail, /meinten Sie „status“/);
    assert.deepEqual(err.body.aql, { pos: 0, end: 5, message: 'Unbekanntes Feld „sttus“ – meinten Sie „status“?' });
    const err2 = await env.call('GET', `/api/projects/HH/test-cases?aql=${encodeURIComponent('label = smoke UND (status = x')}`);
    assert.equal(err2.status, 400);
    const ids = (await env.call('GET', `/api/projects/HH/test-cases?idsOnly=true&limit=5000&aql=${encodeURIComponent('label = smoke')}`)).body;
    assert.equal(ids.total, 2);
    assert.equal(ids.ids.length, 2);
  });

  it('Massenbearbeitung von Ausführungen und projektweite Suche', async () => {
    const all = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body.items;
    const ids = all.map((e: any) => e.id);
    const noEvidence = (await env.call('POST', '/api/executions/bulk', { ids: ids.slice(0, 2), status: 'FAIL' })).body;
    assert.equal(noEvidence.updated, 0);
    assert.equal(noEvidence.skipped.length, 2);
    assert.match(noEvidence.skipped[0].reason, /Nachweis/);
    const r = (await env.call('POST', '/api/executions/bulk', { ids: ids.slice(0, 2), status: 'FAIL', comment: 'Login hängt', addDefects: [{ provider: 'jira', key: 'HH-1' }], assignee: 'qa-lea' })).body;
    assert.equal(r.updated, 2, JSON.stringify(r));
    const search = async (aql: string) => (await env.call('GET', `/api/projects/HH/execution-search?aql=${encodeURIComponent(aql)}`, undefined, 'qa-lea')).body;
    assert.equal((await search('status = Fehlgeschlagen UND zugewiesen = ich() UND fehler = HH-1 UND ausgeführt >= heute()')).total, 2);
    assert.equal((await search('kategorie = offen')).total, ids.length - 2);
    assert.equal((await search('zyklus ~ "Lauf" UND feld.Testumgebung = QS')).total, ids.length);
    const history = (await env.call('GET', `/api/executions/${ids[0]}/results`)).body;
    assert.equal(history[0].note, 'Massenbearbeitung');
    // Entfernen: ausgeführte bleiben, offene gehen
    const rem = (await env.call('POST', '/api/executions/bulk', { ids: ids.slice(0, 3), remove: true })).body;
    assert.equal(rem.removed, 1);
    assert.equal(rem.skipped.length, 2);
    // Verschieben in einen anderen Zyklus
    const other = (await env.call('POST', '/api/projects/HH/cycles', { name: 'Lauf H2' })).body;
    const mv = (await env.call('POST', '/api/executions/bulk', { ids: [ids[0]], moveToCycleId: other.id })).body;
    assert.equal(mv.moved, 1);
    assert.equal((await env.call('GET', `/api/cycles/${other.id}/executions`)).body.total, 1);
  });

  it('Massenbearbeitung von Testfällen: eine neue Version je Testfall, Fehler einzeln gesammelt', async () => {
    const ids = (await env.call('GET', `/api/projects/HH/test-cases?idsOnly=true&limit=5000&aql=${encodeURIComponent('label = smoke')}`)).body.ids;
    const r = (await env.call('POST', '/api/test-cases/bulk', { ids, priority: 'Blocker', addComponents: ['Login'], removeLabels: ['gast'], fields: { Plattform: ['web'] }, owner: 'qa-lea' })).body;
    assert.equal(r.updated, 2, JSON.stringify(r));
    const t3 = (await env.call('GET', '/api/test-cases/HH-T2')).body;
    assert.equal(t3.version.priority, 'Blocker');
    assert.deepEqual(t3.version.components, ['Login']);
    assert.deepEqual(t3.version.labels, ['smoke']);
    assert.deepEqual(t3.version.customFields.Plattform, ['Web']);
    assert.equal(t3.owner, 'qa-lea');
    assert.equal(t3.currentVersion, 2, 'genau eine neue Version');
    const bad = await env.call('POST', '/api/test-cases/bulk', { ids, fields: { Plattform: ['Mac'] } });
    assert.equal(bad.status, 400);
    const wf = (await env.call('POST', '/api/test-cases/bulk', { ids, status: 'APPROVED' })).body;
    assert.equal(wf.skipped.length, 2, 'Workflow verbietet Entwurf → Freigegeben');
  });

  it('Archivieren und Löschen von Testfällen', async () => {
    assert.equal((await env.call('POST', '/api/test-cases/archive', { ids: ['HH-T1'], archived: true })).body.updated, 1);
    assert.ok(!(await keys('label = smoke')).includes('HH-T1'), 'archiviert ausgeblendet');
    assert.deepEqual(await keys('archiviert = ja'), ['HH-T1']);
    assert.equal((await env.call('GET', '/api/projects/HH/test-cases?archived=only')).body.total, 1);
    const c = (await env.call('POST', '/api/projects/HH/cycles', { name: 'Lauf Archiv' })).body;
    const add = (await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['HH-T1'] })).body;
    assert.equal(add.added, 0);
    assert.match(add.warnings[0], /archivierte/);
    assert.equal((await env.call('DELETE', '/api/test-cases/HH-T1')).status, 400, 'eingeplant → nur archivieren');
    const fresh = (await tc('Wegwerf', { customFields: { Team: 'Beta' } })).body;
    await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: fresh.id, provider: 'jira', externalKey: 'REQ-9', relation: 'REQUIREMENT' });
    assert.equal((await env.call('DELETE', `/api/test-cases/${fresh.key}`)).status, 200);
    assert.equal((await env.call('GET', `/api/test-cases/${fresh.key}`)).status, 404);
    const events = (await env.call('GET', `/api/events?aggregateId=${fresh.id}`)).body.map((e: any) => e.type);
    assert.ok(events.includes('TestCaseDeleted'));
  });

  it('Ordner umbenennen, verschieben, löschen', async () => {
    const a = (await env.call('POST', '/api/projects/HH/folders', { name: 'A' })).body;
    const b = (await env.call('POST', '/api/projects/HH/folders', { name: 'B', parentId: a.id })).body;
    await env.call('PATCH', '/api/test-cases/HH-T2', { folderId: b.id });
    assert.equal((await env.call('POST', `/api/folders/${a.id}/move`, { parentId: b.id })).status, 400, 'nicht in eigenen Unterordner');
    assert.deepEqual(await keys('ordner = A'), ['HH-T2'], 'Ordner inkl. Unterordner');
    assert.deepEqual(await keys('ordner = "A/B"'), ['HH-T2']);
    assert.equal((await env.call('PATCH', `/api/folders/${b.id}`, { name: 'B neu' })).status, 204);
    assert.equal((await env.call('POST', `/api/folders/${b.id}/move`, { parentId: null })).status, 204);
    assert.equal((await env.call('DELETE', `/api/folders/${b.id}`)).status, 400, 'nicht leer');
    const del = await env.call('DELETE', `/api/folders/${b.id}?moveContents=true`);
    assert.equal(del.status, 200);
    assert.equal(del.body.movedTestCases, 1);
    assert.equal((await env.call('GET', '/api/test-cases/HH-T2')).body.folderId, null);
    assert.equal((await env.call('DELETE', `/api/folders/${a.id}`)).status, 200);
  });

  it('Zyklen archivieren und löschen', async () => {
    assert.equal((await env.call('DELETE', `/api/cycles/${cycleId}`)).status, 409, 'mit Ergebnissen → archivieren');
    const arch = (await env.call('POST', `/api/cycles/${cycleId}/archive`, { archived: true })).body;
    assert.equal(arch.state, 'closed');
    assert.ok(!(await env.call('GET', '/api/projects/HH/cycles')).body.items.some((c: any) => c.id === cycleId));
    assert.ok((await env.call('GET', '/api/projects/HH/cycles?archived=all')).body.items.some((c: any) => c.id === cycleId));
    const empty = (await env.call('POST', '/api/projects/HH/cycles', { name: 'Leer' })).body;
    await env.call('POST', `/api/cycles/${empty.id}/executions`, { testCaseIds: ['HH-T3'] });
    assert.equal((await env.call('DELETE', `/api/cycles/${empty.id}`)).status, 200);
    assert.equal((await env.call('GET', `/api/cycles/${empty.id}`)).status, 404);
  });

  it('Projekt umbenennen und löschen', async () => {
    assert.equal((await env.call('PATCH', '/api/projects/HH', { name: 'Stufe H (neu)' })).body.name, 'Stufe H (neu)');
    assert.equal((await env.call('DELETE', '/api/projects/HH', { confirmKey: 'hh' })).status, 400);
    const r = await env.call('DELETE', '/api/projects/HH', { confirmKey: 'HH' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.testCases >= 3);
    assert.equal((await env.call('GET', '/api/projects/HH')).status, 404);
  });
});
