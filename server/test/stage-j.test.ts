import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { groupSteps } from '../src/modules/migration/grouping.ts';
import { testLog } from '../src/modules/reports/data.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const ARROW = '{color:#b3c3d3}-------------------------------------->{color}';
const BACK = '{color:#b3c3d3}<--------------------------------------{color}';

describe('Stufe J1: Abschnitte', () => {
  let env: TestEnv;
  let cycle: string;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'GJ', name: 'Gruppen' });
  });
  after(() => env.close());

  it('Abschnitt speichern: keine Prüffelder, Titel bleibt; Ergebnisse auf Abschnitten werden ignoriert, Ableitung ohne Abschnitte', async () => {
    const r = await env.call('POST', '/api/projects/GJ/test-cases', { content: { title: 'Mit Abschnitten', steps: [
      { kind: 'group', title: 'Einstellungen', action: 'wird geleert', expected: 'x' },
      { action: 'Option setzen', expected: 'gesetzt' },
      { kind: 'group', title: 'Test' },
      { action: 'Prüfen', expected: 'ok' },
    ] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const steps = r.body.version.steps;
    assert.deepEqual(steps.map((s: { kind?: string; title?: string; action: string }) => [s.kind ?? 'step', s.title ?? null, s.action]),
      [['group', 'Einstellungen', ''], ['step', null, 'Option setzen'], ['group', 'Test', ''], ['step', null, 'Prüfen']]);
    const plan = (await env.call('POST', '/api/projects/GJ/plans', { name: 'R' })).body.id;
    cycle = (await env.call('POST', '/api/projects/GJ/cycles', { name: 'Z', planId: plan })).body.id;
    await env.call('POST', `/api/cycles/${cycle}/executions`, { testCaseIds: [r.body.id] });
    const exec = (await env.call('GET', `/api/cycles/${cycle}/executions`)).body.items[0].id;
    const e = (await env.call('GET', `/api/executions/${exec}`)).body;
    const ids = e.steps.map((s: { id: string }) => s.id);
    // Status auf einem Abschnitt wird nicht übernommen; „bestanden“ passt zu den zwei Prüfschritten
    const res = await env.call('POST', `/api/executions/${exec}/result`, { status: 'PASS', stepResults: [
      { stepId: ids[0], status: 'FAIL', comment: 'gehört nicht hierher' }, { stepId: ids[1], status: 'PASS' }, { stepId: ids[3], status: 'PASS' },
    ] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after1 = (await env.call('GET', `/api/executions/${exec}`)).body;
    assert.equal(after1.stepResults.find((x: { stepId: string }) => x.stepId === ids[0]), undefined);
    // Berichte: Abschnittszeile ohne Nummer, Prüfschritte 1 und 2
    const json = await testLog(env.db, cycle, 'admin', { steps: true });
    const rows = json.executions[0]!.steps.map((s) => [s.no, s.group ?? null]);
    assert.deepEqual(rows, [[0, 'Einstellungen'], [1, null], [0, 'Test'], [2, null]]);
  });

  it('Umstellung im Bestand: Probelauf ändert nichts, Umstellung ohne neue Version, Alt-Ergebnis bleibt, Rücknahme stellt Original her', async () => {
    const r = await env.call('POST', '/api/projects/GJ/test-cases', { content: { title: 'Aus Zephyr', steps: [
      { action: ARROW, expected: BACK, data: 'h6. Vorbereitung' }, { action: 'Anmelden', expected: 'angemeldet' },
    ] } });
    const tcId = r.body.id;
    const sepId = r.body.version.steps[0].id;
    // vor der Umstellung: Ergebnis auf dem Trennschritt (wie aus Zephyr übernommen)
    const plan = (await env.call('POST', '/api/projects/GJ/plans', { name: 'Alt' })).body.id;
    const c = (await env.call('POST', '/api/projects/GJ/cycles', { name: 'Alt', planId: plan })).body.id;
    await env.call('POST', `/api/cycles/${c}/executions`, { testCaseIds: [tcId] });
    const exec = (await env.call('GET', `/api/cycles/${c}/executions`)).body.items[0].id;
    const ids = (await env.call('GET', `/api/executions/${exec}`)).body.steps.map((s: { id: string }) => s.id);
    await env.call('POST', `/api/executions/${exec}/result`, { status: 'PASS', stepResults: [{ stepId: ids[0], status: 'PASS', comment: 'Zephyr' }, { stepId: ids[1], status: 'PASS' }] });

    const dry = await groupSteps(env.db, { mode: 'dry-run', projects: ['GJ'] });
    assert.equal(dry.projects[0]!.groups, 1);
    assert.equal((await env.call('GET', `/api/test-cases/${tcId}`)).body.version.steps[0].kind ?? null, null, 'Probelauf ändert nichts');

    await groupSteps(env.db, { mode: 'apply', projects: ['GJ'], actor: 'admin' });
    const tc = (await env.call('GET', `/api/test-cases/${tcId}`)).body;
    assert.equal(tc.currentVersion, 1, 'keine neue Version');
    assert.deepEqual([tc.version.steps[0].id, tc.version.steps[0].kind, tc.version.steps[0].title, tc.version.steps[0].legacy.action], [sepId, 'group', 'Vorbereitung', ARROW]);
    const e = (await env.call('GET', `/api/executions/${exec}`)).body;
    assert.equal(e.steps[0].kind, 'group');
    assert.equal(e.stepResults.find((x: { stepId: string }) => x.stepId === sepId)?.comment, 'Zephyr', 'Alt-Ergebnis bleibt erhalten');
    // erneut speichern: Alt-Ergebnis bleibt, auch wenn der Client es nicht mitschickt
    await env.call('POST', `/api/executions/${exec}/result`, { status: 'PASS', stepResults: [{ stepId: ids[1], status: 'PASS' }] });
    assert.equal((await env.call('GET', `/api/executions/${exec}`)).body.stepResults.find((x: { stepId: string }) => x.stepId === sepId)?.status, 'PASS');
    const events = await env.db`select payload from domain_event where type = 'StepsGrouped'`;
    assert.equal(events.length, 1);
    // zweiter Lauf: nichts mehr zu tun
    assert.equal((await groupSteps(env.db, { mode: 'apply', projects: ['GJ'] })).projects.length, 0);

    await groupSteps(env.db, { mode: 'revert', projects: ['GJ'] });
    const back = (await env.call('GET', `/api/test-cases/${tcId}`)).body.version.steps[0];
    assert.deepEqual([back.kind ?? null, back.action, back.data], [null, ARROW, 'h6. Vorbereitung']);
  });

});

describe('Stufe J2: Versionstreue laufender Ausführungen', () => {
  let env: TestEnv;
  let tcId: string;
  let cycle: string;
  let exec: string;
  let ids: string[];
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'VT', name: 'Versionstreue' });
    const pre = (await env.call('POST', '/api/projects/VT/preconditions', { title: 'Datenbank leer', content: 'Fassung 1' })).body;
    tcId = (await env.call('POST', '/api/projects/VT/test-cases', { content: { title: 'Ablage', preconditionIds: [pre.id], steps: [
      { action: 'Öffnen', expected: 'offen' }, { action: 'Knopf A drücken', expected: 'A' }, { action: 'Alt-Schritt', expected: 'weg' },
    ] } })).body.id;
    const plan = (await env.call('POST', '/api/projects/VT/plans', { name: 'R' })).body.id;
    cycle = (await env.call('POST', '/api/projects/VT/cycles', { name: 'Z', planId: plan })).body.id;
    await env.call('POST', `/api/cycles/${cycle}/executions`, { testCaseIds: [tcId] });
    exec = (await env.call('GET', `/api/cycles/${cycle}/executions`)).body.items[0].id;
    ids = (await env.call('GET', `/api/executions/${exec}`)).body.steps.map((s: { id: string }) => s.id);
    // begonnen: zwei Schritte bewertet, Gesamtstatus in Arbeit
    await env.call('POST', `/api/executions/${exec}/result`, { status: 'WIP', stepResults: [
      { stepId: ids[0], status: 'PASS' }, { stepId: ids[1], status: 'FAIL', comment: 'Knopf fehlt' }, { stepId: ids[2], status: 'PASS' },
    ] });
    // Testfall und Vorbedingung weiterentwickeln: Schritt 2 geändert, Schritt 3 entfernt, neuer Schritt
    const tc = (await env.call('GET', `/api/test-cases/${tcId}`)).body;
    const steps = tc.version.steps;
    await env.call('PUT', `/api/test-cases/${tcId}/content`, { content: { ...tc.version, steps: [steps[0], { ...steps[1], action: 'Knopf B drücken' }, { action: 'Neu', expected: 'neu' }] } });
    await env.call('PUT', `/api/preconditions/${pre.id}`, { title: 'Datenbank leer', content: 'Fassung 2' });
  });
  after(() => env.close());

  it('laufende Ausführung bleibt bei ihrer Fassung – auch bei wiederverwendbaren Vorbedingungen', async () => {
    const e = (await env.call('GET', `/api/executions/${exec}`)).body;
    assert.equal(e.version.versionNo, 1);
    assert.deepEqual([e.preconditions[0].content, e.preconditions[0].versionNo, e.preconditions[0].currentVersion], ['Fassung 1', 1, 2]);
    const older = (await env.call('GET', `/api/test-cases/${tcId}/older-executions`)).body;
    assert.deepEqual(older, { total: 1, byVersion: [{ versionNo: 1, n: 1 }] });
  });

  it('Vorschau und Umstellung: unverändert bleibt, geändert wird offen (mit vorherigem Ergebnis), entfernt entfällt, Historie bleibt', async () => {
    const p = (await env.call('GET', `/api/executions/${exec}/update-preview`)).body;
    assert.deepEqual([p.from, p.to, p.canUpdate], [1, 2, true]);
    assert.deepEqual(p.results, { kept: 1, reset: 1, dropped: 1 });
    assert.deepEqual([p.added.length, p.changed.map((x: { text: string }) => x.text), p.removed.map((x: { text: string }) => x.text)], [1, ['Knopf B drücken'], ['Alt-Schritt']]);
    assert.deepEqual(p.preconditions, [{ key: 'VT-P1', from: 1, to: 2 }]);
    const r = await env.call('POST', `/api/executions/${exec}/update-version`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.version.versionNo, 2);
    assert.equal(r.body.preconditions[0].content, 'Fassung 2', 'Vorbedingung in der neuen Fassung');
    const byId = new Map(r.body.stepResults.map((x: { stepId: string }) => [x.stepId, x]));
    assert.equal((byId.get(ids[0]) as { status: string }).status, 'PASS');
    assert.deepEqual(byId.get(ids[1]), { stepId: ids[1], status: 'NOT_EXECUTED', previous: { status: 'FAIL', comment: 'Knopf fehlt', versionNo: 1 } });
    assert.equal(byId.has(ids[2]), false);
    const hist = (await env.call('GET', `/api/executions/${exec}/results`)).body;
    assert.match(hist[0].note, /Stand vor Umstellung v1 → v2/);
    // „vor Umstellung“ bleibt beim Zwischenspeichern, verschwindet nach neuer Bewertung
    await env.call('POST', `/api/executions/${exec}/result`, { status: 'WIP', stepResults: [{ stepId: ids[0], status: 'PASS' }, { stepId: ids[1], status: 'NOT_EXECUTED' }] });
    let e = (await env.call('GET', `/api/executions/${exec}`)).body;
    assert.equal(e.stepResults.find((x: { stepId: string }) => x.stepId === ids[1]).previous.status, 'FAIL');
    await env.call('POST', `/api/executions/${exec}/result`, { status: 'WIP', stepResults: [{ stepId: ids[0], status: 'PASS' }, { stepId: ids[1], status: 'PASS' }] });
    e = (await env.call('GET', `/api/executions/${exec}`)).body;
    assert.equal(e.stepResults.find((x: { stepId: string }) => x.stepId === ids[1]).previous, undefined);
  });

  it('Durchläufe mit Datensatz: zurückgesetzter Schritt öffnet den Durchlauf wieder (Review K5)', async () => {
    const id = (await env.call('POST', '/api/projects/VT/test-cases', { content: { title: 'Je Rolle', steps: [{ action: 'Anmelden', expected: 'ok' }, { action: 'Menü', expected: 'sichtbar' }],
      dataset: { columns: ['rolle'], rows: [['Admin'], ['Leser']] } } })).body.id;
    await env.call('POST', `/api/cycles/${cycle}/executions`, { testCaseIds: [id] });
    const e = (await env.call('GET', `/api/cycles/${cycle}/executions`)).body.items.find((x: { testCaseId: string }) => x.testCaseId === id);
    const s = (await env.call('GET', `/api/executions/${e.id}`)).body.steps.map((x: { id: string }) => x.id);
    const done = (i: number) => ({ index: i, status: 'PASS', stepResults: [{ stepId: s[0], status: 'PASS' }, { stepId: s[1], status: 'PASS' }] });
    // ein Durchlauf fertig, einer offen: Gesamtstatus in Arbeit
    assert.equal((await env.call('POST', `/api/executions/${e.id}/result`, { status: 'WIP', iterations: [done(0)] })).status, 200);
    const tc = (await env.call('GET', `/api/test-cases/${id}`)).body;
    await env.call('PUT', `/api/test-cases/${id}/content`, { content: { ...tc.version, steps: [tc.version.steps[0], { ...tc.version.steps[1], action: 'Menü öffnen' }] } });
    const p = (await env.call('GET', `/api/executions/${e.id}/update-preview`)).body;
    assert.deepEqual(p.results, { kept: 1, reset: 1, dropped: 0 });
    const r = (await env.call('POST', `/api/executions/${e.id}/update-version`)).body;
    assert.equal(r.iterations[0].status, 'WIP', 'Schritt 2 ist wieder offen – der Durchlauf ist nicht mehr bestanden');
  });

  it('gleichzeitiges Speichern und Umstellen: kein Ergebnis geht verloren (Review K4)', async () => {
    const id = (await env.call('POST', '/api/projects/VT/test-cases', { content: { title: 'Parallel', steps: [{ action: 'A', expected: 'a' }, { action: 'B', expected: 'b' }] } })).body.id;
    await env.call('POST', `/api/cycles/${cycle}/executions`, { testCaseIds: [id] });
    const e = (await env.call('GET', `/api/cycles/${cycle}/executions`)).body.items.find((x: { testCaseId: string }) => x.testCaseId === id);
    const s = (await env.call('GET', `/api/executions/${e.id}`)).body.steps.map((x: { id: string }) => x.id);
    await env.call('POST', `/api/executions/${e.id}/result`, { status: 'WIP', stepResults: [{ stepId: s[0], status: 'PASS' }] });
    const tc = (await env.call('GET', `/api/test-cases/${id}`)).body;
    await env.call('PUT', `/api/test-cases/${id}/content`, { content: { ...tc.version, title: 'Parallel v2' } });
    const [save, upd] = await Promise.all([
      env.call('POST', `/api/executions/${e.id}/result`, { status: 'WIP', stepResults: [{ stepId: s[0], status: 'PASS' }, { stepId: s[1], status: 'FAIL', comment: 'parallel' }] }),
      env.call('POST', `/api/executions/${e.id}/update-version`),
    ]);
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const after = (await env.call('GET', `/api/executions/${e.id}`)).body;
    assert.equal(after.version.versionNo, 2);
    assert.equal(after.stepResults.find((x: { stepId: string }) => x.stepId === s[1])?.status, 'FAIL', 'Ergebnis des Testers bleibt');
  });

  it('abgeschlossene Ergebnisse werden nicht umgestellt; Sammelumstellung zählt und überspringt mit Grund', async () => {
    await env.call('POST', `/api/cycles/${cycle}/executions`, { testCaseIds: [tcId] }).catch(() => undefined);
    const tc = (await env.call('GET', `/api/test-cases/${tcId}`)).body;
    await env.call('PUT', `/api/test-cases/${tcId}/content`, { content: { ...tc.version, title: 'Ablage v3' } });
    await env.call('POST', `/api/executions/${exec}/result`, { status: 'PASS', stepResults: [{ stepId: ids[0], status: 'PASS' }, { stepId: ids[1], status: 'PASS' }], overrideReason: 'Test' });
    const p = (await env.call('GET', `/api/executions/${exec}/update-preview`)).body;
    assert.equal(p.canUpdate, false);
    assert.match(p.reason, /abgeschlossen/);
    assert.equal((await env.call('POST', `/api/executions/${exec}/update-version`)).status, 400);
    const bulk = (await env.call('POST', `/api/cycles/${cycle}/update-versions`, { dryRun: true })).body;
    assert.equal(bulk.skipped.length >= 1, true);
    assert.match(bulk.skipped[0].reason, /abgeschlossen/);
  });
});


describe('Stufe J3: Zellhistorie', () => {
  let env: TestEnv;
  let tc: { id: string; version: { steps: { id: string }[] } };
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'ZH', name: 'Zellen' });
    tc = (await env.call('POST', '/api/projects/ZH/test-cases', { content: { title: 'Z', steps: [{ action: 'A1', expected: 'E1' }, { action: 'B1', expected: 'F1' }] } }, 'erika')).body;
    const v1 = (await env.call('GET', `/api/test-cases/${tc.id}`)).body.version;
    await env.call('PUT', `/api/test-cases/${tc.id}/content`, { content: { ...v1, steps: [{ ...v1.steps[0], expected: 'E2' }, v1.steps[1]] } }, 'max');
    const v2 = (await env.call('GET', `/api/test-cases/${tc.id}`)).body.version;
    await env.call('PUT', `/api/test-cases/${tc.id}/content`, { content: { ...v2, steps: [v2.steps[0], { ...v2.steps[1], data: 'neu' }] } }, 'erika');
  });
  after(() => env.close());

  it('letzte Änderung je Zelle, Verlauf einer Zelle, Stand einer älteren Version', async () => {
    const [s1, s2] = tc.version.steps.map((s) => s.id);
    const sum = (await env.call('GET', `/api/test-cases/${tc.id}/cells`)).body;
    assert.equal(sum.versionNo, 3);
    assert.deepEqual([sum.cells[s1!].action.versionNo, sum.cells[s1!].action.by], [1, 'erika']);
    assert.deepEqual([sum.cells[s1!].expected.versionNo, sum.cells[s1!].expected.by, sum.cells[s1!].expected.changes], [2, 'max', 2]);
    assert.deepEqual([sum.cells[s2!].data.versionNo, sum.cells[s2!].data.by], [3, 'erika']);
    const hist = (await env.call('GET', `/api/test-cases/${tc.id}/cells/${s1}/expected`)).body;
    assert.deepEqual(hist.map((h: { versionNo: number; value: string }) => [h.versionNo, h.value]), [[2, 'E2'], [1, 'E1']]);
    const old = (await env.call('GET', `/api/test-cases/${tc.id}/cells?version=1`)).body;
    assert.equal(old.cells[s1!].expected.versionNo, 1);
    assert.equal(old.cells[s2!].data, undefined, 'leeres Feld ist keine Änderung');
    assert.equal((await env.call('GET', `/api/test-cases/${tc.id}/cells/${s1}/kaputt`)).status, 400);
  });
});

describe('Stufe J5: Feldvorlagen', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'FV', name: 'Vorlagen' });
  });
  after(() => env.close());

  it('Startvorlagen, Projekt ergänzt System, Standard je Feld eindeutig, Name je Ebene eindeutig', async () => {
    const sys = (await env.call('GET', '/api/field-templates?field=action')).body;
    assert.deepEqual(sys.map((t: { name: string }) => t.name), ['Vorbedingung / Vorgehen', 'Vorbedingung / Vorgehen (mit Überschriften)']);
    const a = await env.call('POST', '/api/field-templates', { name: 'Prüfpunkte', fields: ['expected'], content: '* Prüfpunkt …', isDefault: true, project: 'FV' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.projectKey, 'FV');
    const b = await env.call('POST', '/api/field-templates', { name: 'Prüfpunkte 2', fields: ['expected', 'data'], content: '# …', isDefault: true, project: 'FV' });
    assert.equal(b.status, 201);
    assert.equal((await env.call('GET', `/api/field-templates?project=FV&scope=project`)).body.find((t: { id: string }) => t.id === a.body.id).isDefault, false, 'nur ein Standard je Feld');
    assert.equal((await env.call('POST', '/api/field-templates', { name: 'prüfpunkte', fields: ['action'], content: 'x', project: 'FV' })).status, 409);
    assert.equal((await env.call('POST', '/api/field-templates', { name: 'Prüfpunkte', fields: ['action'], content: 'x' })).status, 201, 'gleicher Name systemweit erlaubt');
    const both = (await env.call('GET', '/api/field-templates?project=FV&field=expected')).body;
    assert.deepEqual(both.map((t: { name: string; projectKey: string | null }) => [t.name, t.projectKey]), [['Erwartet als Liste', null], ['Prüfpunkte', 'FV'], ['Prüfpunkte 2', 'FV']]);
    assert.equal((await env.call('PUT', `/api/field-templates/${a.body.id}`, { name: 'Prüfpunkte neu', fields: ['expected'], content: '* neu' })).body.name, 'Prüfpunkte neu');
    assert.equal((await env.call('DELETE', `/api/field-templates/${a.body.id}`)).status, 204);
    assert.equal((await env.call('POST', '/api/field-templates', { name: 'leer', fields: ['action'], content: '   ' })).status, 400);
  });
});
