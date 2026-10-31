import { expect, test } from '@playwright/test';
import { toast, watchErrors } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
let key = '';

test('Testfall anlegen: Editor, Schritte, Speichern, erscheint in Liste und Detail', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: '+ Testfall' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Titel').fill('E2E: Bescheid drucken');
  await dlg.locator('[aria-label="Aktion 1"]').click();
  await page.keyboard.type('Bescheid öffnen und Drucken wählen');
  await dlg.locator('[aria-label="Erwartung 1"]').click();
  await page.keyboard.type('Druckvorschau erscheint');
  await dlg.getByRole('button', { name: '+ Schritt' }).click();
  await dlg.locator('[aria-label="Aktion 2"]').click();
  await page.keyboard.type('Drucken bestätigen');
  await expect(dlg.getByText('ungespeichert')).toBeVisible();
  await dlg.getByRole('button', { name: 'Speichern', exact: true }).click();

  const t = toast(page, /angelegt/);
  await expect(t).toBeVisible();
  key = (await t.textContent())!.match(/DEMO-T\d+/)![0];
  await expect(page).toHaveURL(new RegExp(`tc=${key}`));
  await expect(page.locator('.detail-title')).toHaveText('E2E: Bescheid drucken');
  await expect(page.locator('tr.clickable', { hasText: 'E2E: Bescheid drucken' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('ungespeicherte Änderungen: Esc fragt nach, Abbrechen behält den Editor', async ({ page }) => {
  await page.goto(`/#/p/DEMO/repo?tc=${key}`);
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Titel').fill('E2E: geändert, aber nicht gespeichert');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('alertdialog', { name: 'Ungespeicherte Eingaben' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dlg.getByLabel('Titel')).toHaveValue('E2E: geändert, aber nicht gespeichert');
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Verwerfen' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.detail-title')).toHaveText('E2E: Bescheid drucken');
});

test('Bearbeiten im eigenen Fenster: Strg+S speichert neue Version, Hauptfenster aktualisiert sich', async ({ page }) => {
  await page.goto(`/#/p/DEMO/repo?tc=${key}`);
  const popupP = page.waitForEvent('popup');
  await page.getByTitle(/Im eigenen Fenster bearbeiten/).first().click();
  const win = await popupP;
  await expect(win).toHaveTitle(new RegExp(`${key} bearbeiten`));
  await expect(win.locator('.focus-bar')).toBeVisible();
  await expect(win.locator('.topbar')).toHaveCount(0);
  await win.getByLabel('Titel').fill('E2E: Bescheid drucken (Fenster)');
  await win.keyboard.press('Control+s');
  await expect(toast(win, /gespeichert \(v2\)/)).toBeVisible();
  // ohne Neuladen im Hauptfenster sichtbar (fensterübergreifende Aktualisierung)
  await expect(page.locator('.detail-title')).toHaveText('E2E: Bescheid drucken (Fenster)');
  await expect(page.locator('tr.clickable', { hasText: 'E2E: Bescheid drucken (Fenster)' })).toBeVisible();
  await win.locator('.focus-bar').getByRole('button', { name: 'Schließen' }).click();
  await expect.poll(() => win.isClosed()).toBeTruthy();
});

test('Schnellsuche findet den Testfall', async ({ page }) => {
  await page.goto('/#/p/DEMO/repo');
  await page.keyboard.press('Control+k');
  await page.getByLabel('Übergreifende Suche').fill('Bescheid drucken');
  const hit = page.locator('.qs-item', { hasText: 'Bescheid drucken' }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`tc=${key}`));
});
