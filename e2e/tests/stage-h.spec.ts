/** Stufe H im Durchlauf: Felder & Prioritäten, Abfragesprache, Massenbearbeitung, Schnellausführung, Archiv, Ordner. */
import { expect, test } from '@playwright/test';
import { toast, watchErrors } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
let cycleId = '';

test('Administration: Auswahlfeld und Priorität anlegen', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/admin/fields');
  await expect(page.getByRole('heading', { name: 'Felder & Prioritäten' })).toBeVisible();
  await page.getByRole('button', { name: '+ Feld' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Team');
  await dlg.getByLabel('Typ').selectOption('select');
  await dlg.getByLabel('Werte (je Zeile einer)').fill('Alpha\nBeta');
  await dlg.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(toast(page, 'Feld „Team“ gespeichert')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Alpha, Beta' })).toBeVisible();
  await page.getByLabel('Neue Priorität').fill('Hoch');
  await page.getByRole('button', { name: '+ Priorität' }).click();
  await expect(page.getByLabel('Hoch aktiv')).toBeChecked();
  expect(errors).toEqual([]);
});

test('Testfall mit Priorität und Feld; Abfrage findet ihn; Massenbearbeitung', async ({ page }) => {
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: '+ Testfall' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Titel').fill('Export nach PDF');
  await dlg.getByLabel('Priorität').selectOption('Hoch');
  await dlg.getByLabel('Team').selectOption('Beta');
  await dlg.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(toast(page, /angelegt/)).toBeVisible();
  await expect(page.locator('.field-values', { hasText: 'Team' })).toContainText('Beta');
  // Abfragesprache mit Fehlermarkierung und Vorschlag
  await page.getByRole('button', { name: 'Abfrage', exact: true }).click();
  const q = page.getByRole('combobox', { name: 'Abfrage' });
  await q.fill('feld.Team = Beta UND priorität = Hoch');
  await q.press('Enter');
  await expect(page.locator('tbody tr.clickable')).toHaveCount(1);
  await expect(page.locator('tbody tr.clickable')).toContainText('Export nach PDF');
  await q.fill('prioritet = Hoch');
  await expect(page.locator('.aql-msg')).toContainText('meinten Sie „priorität“');
  // Massenbearbeitung: alle DEMO-Testfälle der Priorität „Kritisch“ setzen, dann wieder zurück
  await q.fill('');
  await q.press('Enter');
  await page.getByLabel('Alle auf dieser Seite auswählen').check();
  await page.getByLabel('Priorität setzen').selectOption('Kritisch');
  await page.getByRole('button', { name: 'Priorität übernehmen' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Übernehmen' }).click();
  await expect(toast(page, /Testfälle mit neuer Priorität/)).toBeVisible();
  await q.fill('priorität = Kritisch');
  await q.press('Enter');
  expect(await page.locator('tbody tr.clickable').count()).toBeGreaterThan(3);
});

test('Archivieren blendet aus, Archivfilter zeigt wieder', async ({ page }) => {
  await page.goto(`/#/p/DEMO/repo?aql=${encodeURIComponent('titel = "Export nach PDF"')}`);
  await page.locator('tbody tr.clickable').first().click();
  await page.locator('.detail-head').getByRole('button', { name: /Weitere Aktionen/ }).click();
  await page.getByRole('menuitem', { name: /Archivieren/ }).click();
  await expect(toast(page, /archiviert/)).toBeVisible();
  await expect(page.locator('.detail-head .notice.warn')).toContainText('Archiviert');
  await page.goto('/#/p/DEMO/repo');
  await expect(page.locator('tbody')).not.toContainText('Export nach PDF');
  await page.getByLabel('Archiv').selectOption('only');
  await expect(page.locator('tbody')).toContainText('Export nach PDF');
});

test('Ordner anlegen, umbenennen, löschen', async ({ page }) => {
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: 'Ordner anlegen' }).or(page.getByTitle('Ordner anlegen (unter dem gewählten)')).first().click();
  await page.getByPlaceholder('Ordnername').fill('Temporär E2E');
  await page.getByPlaceholder('Ordnername').press('Enter');
  await page.locator('.tree-item', { hasText: 'Temporär E2E' }).click();
  await page.locator('.pane-head').first().getByRole('button', { name: /weitere Aktionen/ }).click();
  await page.getByRole('menuitem', { name: /Umbenennen/ }).click();
  await page.getByRole('alertdialog').getByLabel('Name').fill('Weg damit');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Umbenennen' }).click();
  await expect(page.locator('.tree-item', { hasText: 'Weg damit' })).toBeVisible();
  await page.locator('.pane-head').first().getByRole('button', { name: /weitere Aktionen/ }).click();
  await page.getByRole('menuitem', { name: /Löschen/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Ordner löschen' }).click();
  await expect(toast(page, /gelöscht/)).toBeVisible();
  await expect(page.locator('.tree-item', { hasText: 'Weg damit' })).toHaveCount(0);
});

test('Ausführungen: Schnellausführung, projektweite Suche, Massenbearbeitung', async ({ page, request }) => {
  const c = await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'Lauf H E2E' } })).json();
  cycleId = c.id;
  const tcs = (await (await request.get('/api/projects/DEMO/test-cases?limit=3')).json()).items.map((t: { key: string }) => t.key);
  await request.post(`/api/cycles/${cycleId}/executions`, { data: { testCaseIds: tcs } });
  await page.goto(`/#/p/DEMO/cycles/${cycleId}`);
  const first = page.locator('tbody tr.clickable').first();
  await first.hover();
  await first.getByRole('button', { name: /bestanden$/ }).click();
  await expect(toast(page, /Bestanden/)).toBeVisible();
  await expect(first.locator('td').nth(2)).toContainText('Bestanden');
  // Fehlgeschlagen fragt nach dem Befund
  const second = page.locator('tbody tr.clickable').nth(1);
  await second.hover();
  await second.getByRole('button', { name: /fehlgeschlagen$/ }).click();
  await page.getByRole('alertdialog').locator('textarea').fill('Export bricht ab');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(toast(page, /Fehlgeschlagen/)).toBeVisible();
  // projektweite Suche und Massenbearbeitung
  await page.goto(`/#/p/DEMO/cycles?view=search&aql=${encodeURIComponent('zyklus = "Lauf H E2E" UND kategorie = offen')}`);
  await expect(page.locator('tbody tr.clickable')).toHaveCount(1);
  await page.getByLabel('Alle auf dieser Seite auswählen').check();
  await page.getByRole('button', { name: 'Ergebnis setzen …' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Blockiert' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: /Befund/ }).fill('Testsystem nicht erreichbar');
  await page.getByRole('dialog').getByRole('button', { name: 'Übernehmen' }).click();
  await expect(toast(page, /1 Ausführung auf „Blockiert“ gesetzt/)).toBeVisible();
  await expect(page.locator('tbody tr.clickable')).toHaveCount(0);
  const r = await (await request.get(`/api/projects/DEMO/execution-search?aql=${encodeURIComponent('zyklus = "Lauf H E2E" UND status = Blockiert')}`)).json();
  expect(r.total).toBe(1);
});

test('Zyklus löschen nur ohne Ergebnisse – sonst archivieren', async ({ page, request }) => {
  await page.goto(`/#/p/DEMO/cycles/${cycleId}`);
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('menuitem', { name: /Löschen/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Endgültig löschen' }).click();
  await expect(page.locator('.error, .notice.bad').first()).toContainText('archivieren');
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('menuitem', { name: /Archivieren/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Archivieren' }).click();
  await expect(toast(page, 'Zyklus archiviert')).toBeVisible();
  const list = await (await request.get('/api/projects/DEMO/cycles?limit=100')).json();
  expect(list.items.some((c: { id: string }) => c.id === cycleId)).toBe(false);
});

test('Import aus CSV mit Vorschau, Probelauf und Import; Export als Excel', async ({ page }) => {
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: 'Austausch' }).click();
  await page.getByRole('menuitem', { name: /Import aus Excel\/CSV/ }).click();
  const dlg = page.getByRole('dialog');
  const csv = '﻿Name;Priority;Test Script (Step-by-Step) - Step;Test Script (Step-by-Step) - Expected Result\r\nAus CSV importiert;Schwer;Öffnen;Geöffnet\r\n;;Schließen;Geschlossen\r\n';
  await dlg.locator('input[type=file]').setInputFiles({ name: 'zephyr.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await expect(dlg.getByLabel('Zuordnung Name')).toHaveValue('title');
  await expect(dlg.getByLabel('Zuordnung Test Script (Step-by-Step) - Step')).toHaveValue('step.action');
  await dlg.getByRole('button', { name: 'Probelauf' }).click();
  await expect(dlg.locator('.notice')).toContainText('Probelauf – nichts gespeichert');
  await dlg.getByRole('button', { name: 'Importieren' }).click();
  await expect(toast(page, /Import: 1 neu/)).toBeVisible();
  await dlg.getByRole('button', { name: 'Fertig' }).click();
  await expect(page.locator('tbody')).toContainText('Aus CSV importiert');
  // Export der aktuellen Liste
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Austausch' }).click();
  await page.getByRole('menuitem', { name: /Export Excel/ }).click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^Testfaelle-DEMO-.*\.xlsx$/);
});

test('Jetzt ausführen am Testfall öffnet die Durchführung; Schätzung setzen', async ({ page }) => {
  await page.goto('/#/p/DEMO/repo?tc=DEMO-T1');
  await page.locator('.detail-head').getByRole('button', { name: 'schätzen' }).or(page.locator('.detail-head').getByRole('button', { name: 'ändern' })).first().click();
  await page.getByRole('alertdialog').getByLabel('Geplanter Aufwand').fill('1h 30m');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('.detail-head')).toContainText('1 h 30 min');
  const popup = page.waitForEvent('popup');
  await page.locator('.detail-head').getByRole('button', { name: '▶ Jetzt ausführen' }).click();
  const win = await popup;
  await expect(win.getByRole('group', { name: 'Gesamtergebnis' }).or(win.getByLabel('Gesamtergebnis')).first()).toBeVisible();
  await win.close();
});

test('Automatisierte Ergebnisse als Datei übernehmen, nicht erkannte zuordnen', async ({ page, request }) => {
  const c = await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'CI E2E' } })).json();
  await page.goto(`/#/p/DEMO/cycles/${c.id}`);
  await page.getByRole('button', { name: 'Austausch' }).click();
  await page.getByRole('menuitem', { name: /Automatisierte Ergebnisse/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Ergebnisse automatisierter Tests übernehmen' });
  const xml = '<testsuite name="ui"><testcase classname="Akte" name="DEMO-T1 oeffnen" time="0.4"/><testcase classname="Akte" name="unbekannt"><failure message="kaputt"/></testcase></testsuite>';
  await dlg.getByLabel('Ergebnisdatei').setInputFiles({ name: 'junit.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await dlg.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(dlg.locator('.notice').first()).toContainText('JUnit: 1 von 2 Ergebnissen übernommen');
  await dlg.getByLabel('Testfall zuordnen').fill('Akte');
  await dlg.locator('.aql-suggest li').first().click();
  await expect(dlg.locator('.badge.ok')).toContainText('→ DEMO-');
  await dlg.getByRole('button', { name: 'Zum Zyklus' }).click();
  await expect(page.locator('tbody tr.clickable')).toHaveCount(1);
});
