import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { writeCsv } from '../src/platform/csv.ts';
import { readXlsx, writeXlsx } from '../src/platform/xlsx.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const b64 = (b: Buffer) => b.toString('base64');

describe('Export und Import von Testfällen (Excel/CSV), Ausführungsexport, PDF', () => {
  let env: TestEnv;
  const raw = async (path: string) => {
    const res = await env.app.request(path, { headers: { 'x-anemo-user': 'tester' } });
    return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), body: Buffer.from(await res.arrayBuffer()) };
  };
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'IO', name: 'Import/Export' });
    await env.call('POST', '/api/admin/fields', { scope: 'test_case', key: 'Team', name: 'Team', type: 'select', options: ['Alpha', 'Beta'] });
    await env.call('POST', '/api/projects/IO/test-cases', { content: { title: 'Akte öffnen', priority: 'Kritisch', labels: ['smoke'], customFields: { Team: 'Alpha' },
      steps: [{ action: 'Anmelden', expected: 'Start' }, { action: 'Akte „4711“ öffnen', data: 'Az 4711', expected: 'Akte sichtbar' }] } });
    await env.call('POST', '/api/projects/IO/test-cases', { content: { title: 'Gherkin', format: 'GHERKIN', gherkin: 'Funktionalität: X\n  Szenario: Y\n    Angenommen a\n    Dann b' } });
  });
  after(() => env.close());

  it('Export als Excel: je Schritt eine Zeile, Felder als Spalten', async () => {
    const r = await raw('/api/projects/IO/test-cases/export?format=xlsx');
    assert.equal(r.status, 200);
    assert.match(r.disposition!, /Testfaelle-IO-.*\.xlsx/);
    const [sheet] = readXlsx(r.body);
    const h = sheet!.rows[0]!;
    assert.ok(h.includes('Feld: Team') && h.includes('Aktion') && h.includes('Erwartetes Ergebnis'));
    const col = (n: string) => h.indexOf(n);
    assert.equal(sheet!.rows.length, 1 + 2 + 1, 'Kopf + 2 Schritte + Gherkin-Testfall');
    assert.equal(sheet!.rows[1]![col('Titel')], 'Akte öffnen');
    assert.equal(sheet!.rows[1]![col('Feld: Team')], 'Alpha');
    assert.equal(sheet!.rows[2]![col('Schlüssel')], 'IO-T1', 'Folgezeile trägt den Schlüssel');
    assert.equal(sheet!.rows[2]![col('Titel')] ?? '', '');
    assert.equal(sheet!.rows[2]![col('Aktion')], 'Akte „4711“ öffnen');
    const csv = await raw('/api/projects/IO/test-cases/export?format=csv&aql=' + encodeURIComponent('label = smoke'));
    assert.match(csv.type!, /text\/csv/);
    assert.equal(csv.body.toString('utf8').replace(/^﻿/, '').trim().split('\r\n').length, 3);
  });

  it('Import: Vorschau erkennt Zephyr-/Xray-Spalten', async () => {
    const file = writeCsv(['Name', 'Objective', 'Priority', 'Folder', 'Test Script (Step-by-Step) - Step', 'Test Script (Step-by-Step) - Expected Result', 'Team', 'Sonstiges'],
      [['Drucken', 'Druck prüfen', 'Schwer', 'Druck/Basis', 'Drucken klicken', 'Dialog erscheint', 'beta', 'x'], ['', '', '', '', 'Drucker wählen', 'PDF entsteht', '', '']]);
    const p = (await env.call('POST', '/api/projects/IO/test-cases/import/preview', { fileName: 'zephyr.csv', contentBase64: b64(file) })).body;
    assert.deepEqual(p.mapping, { 0: 'title', 1: 'objective', 2: 'priority', 3: 'folder', 4: 'step.action', 5: 'step.expected', 6: 'field:Team' });
    assert.equal(p.rowCount, 2);
    // Probelauf speichert nichts
    const dry = (await env.call('POST', '/api/projects/IO/test-cases/import', { fileName: 'zephyr.csv', contentBase64: b64(file), mapping: p.mapping, dryRun: true })).body;
    assert.equal(dry.created, 1);
    assert.equal((await env.call('GET', '/api/projects/IO/test-cases')).body.total, 2, 'Probelauf ändert nichts');
    const real = (await env.call('POST', '/api/projects/IO/test-cases/import', { fileName: 'zephyr.csv', contentBase64: b64(file), mapping: p.mapping })).body;
    assert.equal(real.created, 1);
    const tc = (await env.call('GET', `/api/test-cases/${real.items[0].key}`)).body;
    assert.equal(tc.version.title, 'Drucken');
    assert.equal(tc.version.priority, 'Schwer');
    assert.deepEqual(tc.version.steps.map((s: any) => s.action), ['Drucken klicken', 'Drucker wählen']);
    assert.equal(tc.version.customFields.Team, 'Beta');
    const folders = (await env.call('GET', '/api/projects/IO/folders')).body.map((f: any) => f.name).sort();
    assert.deepEqual(folders, ['Basis', 'Druck']);
  });

  it('Import aus Excel: Aktualisieren per Schlüssel, Fehlerzeilen einzeln gemeldet', async () => {
    const xlsx = await writeXlsx([{ name: 'Testfälle', header: ['Schlüssel', 'Titel', 'Priorität', 'Aktion', 'Erwartetes Ergebnis'], rows: [
      ['IO-T1', '', 'Blocker', '', ''],
      ['', 'Neu aus Excel', 'Gibtsnicht', 'a', 'b'],
      ['', 'Noch einer', '', 'c', 'd'],
      ['IO-T999', '', '', '', ''],
    ] }]);
    const p = (await env.call('POST', '/api/projects/IO/test-cases/import/preview', { fileName: 't.xlsx', contentBase64: b64(xlsx) })).body;
    assert.deepEqual(p.sheets, ['Testfälle']);
    const r = (await env.call('POST', '/api/projects/IO/test-cases/import', { fileName: 't.xlsx', contentBase64: b64(xlsx), mapping: p.mapping, mode: 'upsert' })).body;
    assert.equal(r.updated, 1);
    assert.equal(r.created, 1);
    assert.equal(r.failed, 2);
    assert.match(r.items.find((i: any) => i.row === 3).message, /Werteliste/);
    assert.match(r.items.find((i: any) => i.row === 5).message, /nicht gefunden/);
    const t1 = (await env.call('GET', '/api/test-cases/IO-T1')).body;
    assert.equal(t1.version.priority, 'Blocker');
    assert.equal(t1.version.steps.length, 2, 'ohne Schrittzeilen bleiben die Schritte');
    assert.equal(t1.version.title, 'Akte öffnen', 'leere Zelle ändert nichts');
    assert.match(t1.version.changeNote, /Import aus t\.xlsx/);
  });

  it('Rundlauf: exportieren, in Excel ändern, wieder importieren', async () => {
    const exp = await raw('/api/projects/IO/test-cases/export?format=xlsx&aql=' + encodeURIComponent('schlüssel = IO-T1'));
    const [sheet] = readXlsx(exp.body);
    const h = sheet!.rows[0]!;
    sheet!.rows[2]![h.indexOf('Erwartetes Ergebnis')] = 'Akte wird angezeigt (geändert)';
    const back = await writeXlsx([{ name: 'Testfälle', header: h, rows: sheet!.rows.slice(1) }]);
    const p = (await env.call('POST', '/api/projects/IO/test-cases/import/preview', { fileName: 'rund.xlsx', contentBase64: b64(back) })).body;
    const r = (await env.call('POST', '/api/projects/IO/test-cases/import', { fileName: 'rund.xlsx', contentBase64: b64(back), mapping: p.mapping, mode: 'upsert' })).body;
    assert.equal(r.updated, 1, JSON.stringify(r.items));
    const t1 = (await env.call('GET', '/api/test-cases/IO-T1')).body;
    assert.equal(t1.version.steps[1].expected, 'Akte wird angezeigt (geändert)');
    assert.equal(t1.version.steps[0].id, (await env.call('GET', '/api/test-cases/IO-T1/versions/1')).body.steps[0].id, 'Schritt-IDs bleiben (Ergebnisse zuordenbar)');
    const again = (await env.call('POST', '/api/projects/IO/test-cases/import', { fileName: 'rund.xlsx', contentBase64: b64(back), mapping: p.mapping, mode: 'upsert' })).body;
    assert.equal(again.unchanged, 1, 'zweiter Import ohne Änderung');
  });

  it('Ausführungen exportieren (mit Schrittergebnissen) und Berichte als PDF', async () => {
    const c = (await env.call('POST', '/api/projects/IO/cycles', { name: 'Lauf Export' })).body;
    await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['IO-T1'] });
    const [e] = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items;
    const d = (await env.call('GET', `/api/executions/${e.id}`)).body;
    await env.call('POST', `/api/executions/${e.id}/result`, { status: 'FAIL', comment: 'Akte fehlt', stepResults: [{ stepId: d.steps[0].id, status: 'PASS' }, { stepId: d.steps[1].id, status: 'FAIL', comment: 'leer' }] });
    const x = await raw(`/api/projects/IO/execution-export?format=xlsx&cycleId=${c.id}`);
    const sheets = readXlsx(x.body);
    assert.deepEqual(sheets.map((s) => s.name), ['Ausführungen', 'Schrittergebnisse']);
    assert.equal(sheets[0]!.rows[1]![sheets[0]!.rows[0]!.indexOf('Status')], 'Fehlgeschlagen');
    assert.equal(sheets[1]!.rows.length, 3);
    const pdf = await raw(`/api/reports/test-log/${c.id}?format=pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
    const spec = await raw('/api/reports/specification/IO?format=pdf');
    assert.equal(spec.body.subarray(0, 5).toString(), '%PDF-');
  });
});
