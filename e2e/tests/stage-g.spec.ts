/** Stufe G im Durchlauf: parametrisierte Tests, Testsets, explorative Sitzung, Rückverfolgbarkeit, KI-Skills. */
import { expect, test } from '@playwright/test';
import { toast, watchErrors } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
let tcKey = '';
let cycleId = '';
let planId = '';

test('Parametrisierter Testfall: Datensatz im Editor anlegen', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: '+ Testfall' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Titel').fill('Anmelden je Rolle');
  await dlg.locator('[aria-label="Aktion 1"]').click();
  await page.keyboard.type('Als ${rolle} anmelden');
  await dlg.locator('[aria-label="Erwartung 1"]').click();
  await page.keyboard.type('Startseite für ${rolle} erscheint');
  await dlg.getByRole('button', { name: '+ Datensatz' }).click();
  await dlg.getByLabel('Spaltenname 1').fill('rolle');
  await dlg.getByLabel('Zeile 1, rolle').fill('Admin');
  await dlg.getByLabel('Zeile 2, rolle').fill('Leser');
  await dlg.getByRole('button', { name: '+ Durchlauf' }).click();
  await dlg.getByLabel('Zeile 3, rolle').fill('Gast');
  await dlg.getByRole('button', { name: 'Speichern', exact: true }).click();
  const t = toast(page, /angelegt/);
  await expect(t).toBeVisible();
  tcKey = (await t.textContent())!.match(/DEMO-T\d+/)![0];
  await expect(page.getByRole('heading', { name: 'Datensatz – 3 Durchläufe' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Testset aus Auswahl speichern und in einen neuen Zyklus aufnehmen', async ({ page }) => {
  await page.goto('/#/p/DEMO/repo');
  await page.getByLabel(`${tcKey} auswählen`).check();
  await page.getByLabel('DEMO-T1 auswählen').check();
  await page.getByRole('toolbar', { name: 'Massenbearbeitung' }).getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('menuitem', { name: /Als Testset speichern/ }).click();
  await page.getByRole('alertdialog').getByLabel('Name').fill('Kern E2E');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(toast(page, 'Testset „Kern E2E“ gespeichert')).toBeVisible();

  const api = page.request;
  planId = (await (await api.post('/api/projects/DEMO/plans', { data: { name: 'Release G' } })).json()).id;
  await api.post(`/api/references`, { data: { ownerType: 'TEST_PLAN', ownerId: planId, provider: 'jira', externalKey: 'REQG-1', relation: 'REQUIREMENT', title: 'Rollenabhängige Startseite' } });
  cycleId = (await (await api.post('/api/projects/DEMO/cycles', { data: { name: 'Lauf G', planId } })).json()).id;
  await page.goto(`/#/p/DEMO/cycles/${cycleId}`);
  await page.getByRole('button', { name: 'Tests aufnehmen', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Aus Testset').selectOption({ label: 'Kern E2E (2)' });
  await page.getByRole('alertdialog').getByRole('button', { name: 'Aufnehmen' }).click();
  // ganzes Testset wird serverseitig direkt aufgenommen
  await expect(toast(page, '„Kern E2E“: 2 von 2 Testfällen aufgenommen')).toBeVisible();
  await expect(page.locator('tr.clickable')).toHaveCount(2);
});

test('Durchläufe im Fokusfenster: Werte eingesetzt, Ergebnis je Durchlauf, Gesamtergebnis, Dauer', async ({ page }) => {
  await page.goto(`/#/p/DEMO/cycles/${cycleId}`);
  const row = page.locator('tr.clickable', { hasText: 'Anmelden je Rolle' });
  const popupP = page.waitForEvent('popup');
  await row.getByTitle(/Im eigenen Fenster durchführen/).click();
  const win = await popupP;
  const tabs = win.getByRole('tablist', { name: 'Durchläufe' }).getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(win.getByText('Als Admin anmelden')).toBeVisible();
  const passIter = async () => {
    await win.locator('[data-step-row]').first().click();
    await win.keyboard.press('p');
  };
  await passIter();
  await expect(win.getByRole('group', { name: 'Ergebnis Durchlauf 1' }).getByRole('button', { name: 'Bestanden', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await tabs.nth(1).click();
  await expect(win.getByText('Als Leser anmelden')).toBeVisible();
  await passIter();
  await tabs.nth(2).click();
  await win.getByRole('group', { name: 'Status Schritt 1' }).getByRole('button', { name: 'Fehlgeschlagen' }).click();
  await win.getByLabel('Befund Durchlauf 3').fill('Gast sieht das Admin-Menü');
  await expect(win.getByLabel('Gesamtergebnis')).toContainText('Fehlgeschlagen');
  await win.keyboard.press('Control+s');
  await expect(toast(win, /gespeichert: Fehlgeschlagen/)).toBeVisible();
  const ex = await (await win.request.get(`/api/executions/${new URL(win.url()).hash.split('/').pop()}`)).json();
  expect(ex.iterations.map((i: any) => [i.values.rolle, i.status])).toEqual([['Admin', 'PASS'], ['Leser', 'PASS'], ['Gast', 'FAIL']]);
  expect(ex.status).toBe('FAIL');
  expect(ex.startedAt).toBeTruthy();

  // ✨ Fehlermeldung formulieren (Schein-Modell)
  await win.getByRole('toolbar', { name: 'Aktionen zum Ergebnis' }).getByRole('button', { name: 'Fehler melden' }).click();
  await win.getByRole('dialog').getByRole('button', { name: 'Formulieren' }).click();
  await expect(win.getByRole('dialog').getByLabel('Titel')).toHaveValue('Gast sieht Admin-Menü');
  await win.close();
});

test('Explorative Sitzung: planen, Zeitnahme, Protokoll, Funde, Testfall übernehmen, abschließen', async ({ page }) => {
  await page.goto(`/#/p/DEMO/cycles/${cycleId}`);
  await page.getByRole('button', { name: '+ Explorative Sitzung' }).click();
  await page.getByRole('dialog').getByLabel('Auftrag (Charter): Ziel der Sitzung').fill('Erkunde Rollenwechsel, um Rechtefehler zu finden');
  await page.getByRole('dialog').getByLabel('Zeitrahmen (Timebox, Minuten)').fill('30');
  await page.getByRole('dialog').getByRole('button', { name: 'Planen' }).click();
  const item = page.locator('.session-item', { hasText: 'Erkunde Rollenwechsel' });
  await expect(item.locator('.badge')).toHaveText('geplant');
  await expect(item).toContainText('/ 30 min');
  const popupP = page.waitForEvent('popup');
  await item.getByRole('link', { name: '⧉ Öffnen' }).click();
  const win = await popupP;
  await win.getByRole('button', { name: '▶ Start' }).click();
  await expect(win.locator('.badge', { hasText: 'läuft' })).toBeVisible();
  await win.locator('[aria-label="Protokoll der Sitzung"]').click();
  await win.keyboard.type('Rollenwechsel ohne Abmelden getestet');
  await win.getByLabel('Beobachtung', { exact: true }).fill('Nach Rollenwechsel bleibt altes Menü sichtbar');
  await win.keyboard.press('Enter');
  await win.getByRole('radio', { name: /Idee/ }).click();
  await win.getByLabel('Beobachtung', { exact: true }).fill('Rollenanzeige im Kopf');
  await win.keyboard.press('Enter');
  await expect(win.locator('.findings li')).toHaveCount(2);
  await win.locator('.findings li').first().getByRole('button', { name: '→ Testfall' }).click();
  await win.getByRole('alertdialog').getByRole('button', { name: 'Testfall anlegen' }).click();
  await expect(toast(win, /Testfall DEMO-T\d+ angelegt/)).toBeVisible();
  await win.locator('#session-summary').fill('Rechte beim Rollenwechsel unzuverlässig, weiter vertiefen.');
  await win.getByRole('button', { name: '■ Abschließen' }).click();
  await expect(win.locator('.badge', { hasText: 'abgeschlossen' })).toBeVisible();
  await win.close();
  await expect(item.locator('.badge')).toHaveText('abgeschlossen');
  const log = await (await page.request.get(`/api/reports/test-log/${cycleId}?format=json`)).json();
  expect(log.sessions[0].findings.length).toBe(2);
});

test('Cockpit: Abdeckung, Aufwand, ✨ Fazit; Rückverfolgbarkeitsbericht', async ({ page }) => {
  await page.goto(`/#/p/DEMO/cycles?plan=${planId}&tab=cockpit`);
  await expect(page.getByRole('heading', { name: 'Abdeckung der Anforderungen', exact: true })).toBeVisible();
  await expect(page.locator('.kpi', { hasText: 'ohne Testfall' })).toContainText('1');
  // ohne Fazit entsteht der Entwurf beim Öffnen direkt
  await page.getByRole('button', { name: '✨ Fazit entwerfen' }).click();
  await expect(page.getByRole('dialog').getByText(/Entwurf von schein-modell/)).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '✨ Neu entwerfen' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Der Teststand ist überwiegend gut.')).toBeVisible();
  const r = await page.request.get(`/api/reports/traceability/${planId}`);
  expect(await r.text()).toContain('REQG-1');
  const cr = await page.request.get(`/api/reports/completion/${planId}`);
  expect(await cr.text()).toContain('Fazit des Testmanagements');

  // Ausstiegskriterien festlegen und Freigabe entscheiden
  await page.getByRole('button', { name: '+ Kriterien festlegen' }).click();
  await page.getByRole('dialog').getByLabel('Bestehensquote mindestens').fill('90');
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('cell', { name: 'Bestehensquote' })).toBeVisible();
  await page.getByRole('button', { name: 'Freigabe entscheiden …' }).click();
  await page.getByRole('dialog').getByRole('radio', { name: 'Freigegeben mit Auflagen' }).check();
  await page.getByRole('dialog').getByLabel(/Begründung, Auflagen/).fill('Gast-Rechte im Hotfix beheben');
  await page.getByRole('dialog').getByRole('button', { name: 'Entscheidung festhalten' }).click();
  await expect(page.getByText('Entscheidung: Freigegeben mit Auflagen')).toBeVisible();
  const cr2 = await page.request.get(`/api/reports/completion/${planId}`);
  expect(await cr2.text()).toContain('Gast-Rechte im Hotfix beheben');
});

test('✨ Testfall prüfen im Editor', async ({ page }) => {
  await page.goto(`/#/p/DEMO/repo?tc=${tcKey}`);
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '✨ Prüfen' }).click();
  await expect(page.getByRole('dialog').getByText('Erwartung nicht beobachtbar')).toBeVisible();
});
