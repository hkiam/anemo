import { expect, type Page, test } from '@playwright/test';
import { toast, watchErrors } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
let cycleUrl = '';

test('Testplan anlegen und bearbeiten', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/p/DEMO/cycles');
  await page.getByRole('button', { name: '+ Plan' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Release E2E');
  await dlg.getByLabel('Release / Version').fill('9.9');
  await dlg.getByRole('button', { name: 'Anlegen' }).click();
  await expect(toast(page, 'Testplan „Release E2E“ angelegt')).toBeVisible();
  await expect(page).toHaveURL(/plan=/);
  await expect(page.getByRole('heading', { name: 'Testplan Release E2E' })).toBeVisible();

  await page.getByRole('button', { name: '✎ Plan bearbeiten' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Release E2E 9.9');
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('heading', { name: 'Testplan Release E2E 9.9' })).toBeVisible();
  await expect(page.locator('.plan-item', { hasText: 'Release E2E 9.9' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Testzyklus anlegen, Tests aufnehmen, Zyklus bearbeiten', async ({ page }) => {
  await page.goto('/#/p/DEMO/cycles');
  await page.locator('.plan-item', { hasText: 'Release E2E 9.9' }).click();
  await page.getByRole('button', { name: '+ Testzyklus' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Testplan (Release)')).toHaveValue(/.+/); // gewählter Plan ist vorbelegt
  await dlg.getByLabel('Name', { exact: true }).fill('Regression E2E');
  await dlg.getByLabel('Build').fill('9.9.0.1');
  await dlg.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByRole('heading', { name: 'Regression E2E' })).toBeVisible();
  cycleUrl = page.url();

  await page.getByRole('button', { name: 'Tests aufnehmen', exact: true }).click();
  const add = page.getByRole('dialog');
  await add.getByRole('button', { name: 'alle Treffer auswählen' }).click();
  await add.getByRole('button', { name: 'Aufnehmen' }).click();
  await expect(page.locator('tr.clickable')).not.toHaveCount(0);

  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Umgebung').fill('Oracle 19c / Windows 11');
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('.chip', { hasText: 'Oracle 19c / Windows 11' })).toBeVisible();
});

/** Eine Ausführung im Fokusfenster abschließen: Schritte per Tastatur bzw. Gesamtergebnis, dann Strg+Enter. */
async function passCurrent(win: Page) {
  const steps = win.locator('[data-step-row]');
  await expect(win.getByRole('group', { name: 'Gesamtergebnis' })).toBeVisible();
  const n = await steps.count();
  if (n > 0) {
    await steps.first().click();
    for (let i = 0; i < n; i++) await win.keyboard.press('p');
  } else {
    await win.getByRole('group', { name: 'Gesamtergebnis' }).getByRole('button', { name: 'Bestanden', exact: true }).click();
  }
  await expect(win.getByRole('group', { name: 'Gesamtergebnis' }).getByRole('button', { name: 'Bestanden', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(win.getByText('ungespeichert')).toBeVisible();
}

test('Zyklus im Fokusfenster durchführen: Fortschritt, Speichern & weiter, Hauptfenster aktualisiert sich', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(cycleUrl);
  await expect(page.locator('tr.clickable').first()).toBeVisible();
  const total = await page.locator('tr.clickable').count();
  const popupP = page.waitForEvent('popup');
  await page.getByRole('link', { name: /^Durchführen/ }).click();
  const win = await popupP;
  const winErrors = watchErrors(win);
  await expect(win.getByText(`0 / ${total} erledigt`)).toBeVisible();
  await expect(win).toHaveTitle(/Regression E2E/);

  for (let i = 1; i <= total; i++) {
    await passCurrent(win);
    if (i < total) {
      await win.keyboard.press('Control+Enter');
      await expect(win.getByText(`${i} / ${total} erledigt`)).toBeVisible();
    } else {
      await win.keyboard.press('Control+s');
    }
  }
  await expect(win.getByText(`${total} / ${total} erledigt`)).toBeVisible();
  await expect(win.getByText('Alle Ausführungen dieses Zyklus sind erledigt.')).toBeVisible();
  // Hauptfenster zeigt die Ergebnisse ohne Neuladen
  await expect(page.locator('.chip-btn', { hasText: `Bestanden (${total})` })).toBeVisible();
  await win.close();
  expect([...errors, ...winErrors]).toEqual([]);
});

test('Wechsel mit ungespeichertem Ergebnis fragt nach', async ({ page }) => {
  await page.goto(cycleUrl);
  const rows = page.locator('tr.clickable');
  await rows.nth(0).click();
  await page.getByRole('group', { name: 'Gesamtergebnis' }).getByRole('button', { name: 'Fehlgeschlagen' }).click();
  await rows.nth(1).click();
  await expect(page.getByRole('alertdialog', { name: 'Ungespeicherte Eingaben' })).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.getByRole('group', { name: 'Gesamtergebnis' }).getByRole('button', { name: 'Fehlgeschlagen' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Durchführung schließen' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Verwerfen' }).click();
  await expect(page.getByRole('group', { name: 'Gesamtergebnis' })).toHaveCount(0);
});

test('Mehr-Menü, Vergleich und Testprotokoll', async ({ page }) => {
  await page.goto(cycleUrl);
  await page.getByRole('button', { name: 'Austausch' }).click();
  for (const name of [/Export Excel/, /Excel-Rundlauf/, /CI-Pipeline starten/, /Automatisierte Ergebnisse/]) await expect(page.getByRole('menuitem', { name })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  for (const name of [/Vergleichen/, /Wiederholen/, /Zyklus abschließen/, /Archivieren/]) await expect(page.getByRole('menuitem', { name })).toBeVisible();
  await page.getByRole('menuitem', { name: /Vergleichen/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  const cycleId = new URL(cycleUrl).hash.split('/')[4]!.split('?')[0];
  const html = await page.request.get(`/api/reports/test-log/${cycleId}`);
  expect(html.status()).toBe(200);
  expect(await html.text()).toContain('Regression E2E');
});
