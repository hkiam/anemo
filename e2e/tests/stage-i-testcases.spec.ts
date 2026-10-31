/** Stufe I – Testfälle: unstrukturierter Test (Freitext), Schrittbibliothek, Beobachten. */
import { expect, test } from '@playwright/test';
import { toast, watchErrors } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
const stamp = Date.now().toString(36);
let blockKey = '';

test('Freitext-Testfall anlegen und Testanweisung anzeigen', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: '+ Testfall' }).click();
  const dlg = page.getByRole('dialog').first();
  await dlg.getByLabel('Titel').fill(`Freitext-Prüfung ${stamp}`);
  await dlg.locator('[aria-label="Aktion 1"]').click();
  await page.keyboard.type('Formular öffnen');
  // Wechsel zu Freitext: Schritte übernehmen
  await dlg.getByRole('button', { name: 'Freitext', exact: true }).click();
  const ask = page.getByRole('alertdialog', { name: 'Zu Freitext wechseln' });
  await ask.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(dlg.getByRole('button', { name: '+ Schritt' })).toHaveCount(0);
  await dlg.locator('[aria-label="Testanweisung"]').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' und Pflichtfelder prüfen');
  await dlg.getByRole('button', { name: 'Speichern', exact: true }).click();
  const t = toast(page, /DEMO-T\d+ angelegt/).last();
  await expect(t).toBeVisible();
  const key = (await t.textContent())!.match(/DEMO-T\d+/)![0];
  const head = page.locator('.detail-head');
  await expect(head.getByText('Freitext', { exact: true })).toBeVisible();
  const section = page.locator('.section.plain-text');
  await expect(section).toContainText('Testanweisung');
  await expect(section).toContainText('Formular öffnen');
  await expect(section).toContainText('Pflichtfelder prüfen');
  await expect(page.locator('table.steps')).toHaveCount(0);
  const tc = await (await page.request.get(`/api/test-cases/${key}`)).json();
  expect(tc.version.format).toBe('PLAIN');
  expect(tc.version.steps).toEqual([]);
  expect(errors).toEqual([]);
});

test('Baustein anlegen, in neuen Testfall einfügen, Verwendung sehen', async ({ page, request }) => {
  const errors = watchErrors(page);
  const name = `Anmelden ${stamp}`;
  const r = await request.post('/api/projects/DEMO/step-blocks', {
    data: { name, tags: ['anmeldung'], steps: [{ action: 'Startseite öffnen', data: '', expected: 'Anmeldemaske sichtbar' }, { action: 'Als Testnutzer anmelden', data: 'demo', expected: 'Startseite erscheint' }] },
  });
  expect(r.status()).toBe(201);
  const block = await r.json();

  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: '+ Testfall' }).click();
  const dlg = page.getByRole('dialog').first();
  await dlg.getByLabel('Titel').fill(`Mit Baustein ${stamp}`);
  await dlg.getByRole('button', { name: '📚 Aus Bibliothek …' }).click();
  const picker = page.getByRole('dialog', { name: 'Schritte aus der Bibliothek einfügen' });
  await picker.getByLabel('Baustein suchen').fill(stamp);
  await picker.locator('tr.clickable', { hasText: name }).click();
  await expect(picker.locator('.block-preview')).toContainText('Anmeldemaske sichtbar');
  await picker.getByRole('button', { name: /^Einfügen/ }).click();
  await expect(dlg.locator('.block-mark')).toHaveCount(2);
  await dlg.getByRole('button', { name: 'Speichern', exact: true }).click();
  const t = toast(page, /DEMO-T\d+ angelegt/).last();
  await expect(t).toBeVisible();
  blockKey = (await t.textContent())!.match(/DEMO-T\d+/)![0];
  await expect(page.locator('tr.from-block')).toHaveCount(2);
  const tc = await (await page.request.get(`/api/test-cases/${blockKey}`)).json();
  expect(tc.version.steps.map((s: { blockId?: string }) => s.blockId)).toEqual([block.id, block.id]);

  // Verwaltung: Verwendung in der Schrittbibliothek
  await page.getByRole('button', { name: 'Bausteine' }).click();
  await page.getByRole('menuitem', { name: /Schrittbibliothek/ }).click();
  const lib = page.getByRole('dialog', { name: 'Schrittbibliothek' });
  await lib.getByLabel('Bausteine suchen').fill(stamp);
  const row = lib.locator('tr.clickable', { hasText: name });
  await expect(row).toContainText('1 Testfall');
  await row.click();
  const detail = page.getByRole('dialog', { name: `Baustein „${name}“` });
  await expect(detail).toContainText('Verwendet in 1 Testfall');
  await expect(detail).toContainText(blockKey);
  expect(errors).toEqual([]);
});

test('Als Baustein speichern aus markierten Schritten', async ({ page }) => {
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: '+ Testfall' }).click();
  const dlg = page.getByRole('dialog').first();
  await dlg.getByLabel('Titel').fill(`Baustein-Quelle ${stamp}`);
  await dlg.locator('[aria-label="Aktion 1"]').click();
  await page.keyboard.type('Suche öffnen');
  await dlg.getByLabel('Schritt 1 markieren').check();
  await dlg.getByRole('button', { name: 'Als Baustein speichern …' }).click();
  const ed = page.getByRole('dialog', { name: 'Neuer Baustein' });
  await ed.getByLabel('Name').fill(`Suche ${stamp}`);
  await ed.getByLabel('Schlagworte (Komma-getrennt)').fill('suche');
  await ed.getByRole('button', { name: 'Speichern' }).click();
  await expect(toast(page, `Baustein „Suche ${stamp}“ angelegt`)).toBeVisible();
  await expect(dlg.locator('.block-mark')).toHaveCount(1);
  await dlg.getByRole('button', { name: 'Abbrechen' }).click();
  await page.getByRole('alertdialog', { name: 'Ungespeicherte Eingaben' }).getByRole('button', { name: 'Verwerfen' }).click();
});

test('Testfall beobachten an und aus', async ({ page }) => {
  await page.goto(`/#/p/DEMO/repo?tc=${blockKey || 'DEMO-T1'}`);
  const head = page.locator('.detail-head');
  const on = head.getByRole('button', { name: /^Beobachten/ });
  await on.click();
  await expect(toast(page, 'Testfall wird beobachtet')).toBeVisible();
  const off = head.getByRole('button', { name: /^Beobachtet/ });
  await expect(off).toHaveAttribute('aria-pressed', 'true');
  await off.click();
  await expect(toast(page, 'Testfall wird nicht mehr beobachtet')).toBeVisible();
  await expect(head.getByRole('button', { name: /^Beobachten/ })).toHaveAttribute('aria-pressed', 'false');
});
