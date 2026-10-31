/** Testdesign im Durchlauf: Vorbedingung, aufrufbarer Test, Diskussion, Kombinationen, Datensatz je Zyklus. */
import { expect, test } from '@playwright/test';
import { toast, watchErrors } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
let callerKey = '';

test('Vorbedingung im Editor anlegen und verknüpfen; Testfall ruft einen anderen auf', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: '+ Testfall' }).click();
  const dlg = page.getByRole('dialog').first();
  await dlg.getByLabel('Titel').fill('Akte drucken (modular)');
  await dlg.getByLabel('Vorbedingung suchen').fill('Druckertreiber');
  await page.getByText('+ Neue Vorbedingung „Druckertreiber“ anlegen …').click();
  const pre = page.getByRole('dialog', { name: 'Neue Vorbedingung' });
  await pre.getByRole('button', { name: 'Speichern' }).click();
  await expect(toast(page, /Vorbedingung DEMO-P\d+ angelegt/)).toBeVisible();
  await expect(dlg.locator('.precondition-chips')).toContainText('Druckertreiber');
  await dlg.getByRole('button', { name: '↪ Testfall aufrufen …' }).click();
  const picker = page.getByRole('dialog', { name: 'Testfall aufrufen' });
  await picker.locator('tr.clickable').first().click();
  await expect(dlg.locator('.call-cell')).toContainText('Aufruf DEMO-');
  await dlg.getByRole('button', { name: '+ Schritt' }).click();
  await dlg.locator('[aria-label="Aktion 2"]').click();
  await page.keyboard.type('Drucken wählen');
  await dlg.getByRole('button', { name: 'Speichern', exact: true }).click();
  const t = toast(page, /DEMO-T\d+/).last();
  await expect(t).toBeVisible();
  callerKey = (await t.textContent())!.match(/DEMO-T\d+/)![0];
  await expect(page.locator('.precondition-list')).toContainText('Druckertreiber');
  await expect(page.locator('tr.call-step')).toContainText(/Schritte?/);
  expect(errors).toEqual([]);
});

test('Diskussion: Anmerkung schreiben und erledigen', async ({ page }) => {
  await page.goto(`/#/p/DEMO/repo?tc=${callerKey}`);
  await page.getByLabel('Neue Anmerkung').fill('Bitte Erwartung in Schritt 2 ergänzen @admin');
  await page.getByRole('button', { name: 'Anmerken' }).click();
  await expect(page.locator('.discussion .comment')).toContainText('Erwartung in Schritt 2');
  await expect(page.locator('.detail-head').getByTitle('Offene Anmerkungen')).toContainText('1');
  await page.getByRole('button', { name: '✓ erledigt' }).click();
  await expect(page.locator('.discussion')).toContainText('Keine offenen Anmerkungen');
});

test('Durchführung: eingesetzte Schritte mit Herkunft, Vorbedingung sichtbar', async ({ page, request }) => {
  const c = await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'Lauf Testdesign' } })).json();
  await request.post(`/api/cycles/${c.id}/executions`, { data: { testCaseIds: [callerKey] } });
  const [e] = (await (await request.get(`/api/cycles/${c.id}/executions`)).json()).items;
  await page.goto(`/#/f/DEMO/run/${e.id}`);
  await expect(page.locator('.precondition')).toContainText('Druckertreiber');
  await expect(page.locator('tr.origin-row')).toContainText('aufgerufen');
  expect(await page.locator('tr.from-call').count()).toBeGreaterThan(0);
});

test('Datensatz: Kombinationen paarweise erzeugen', async ({ page }) => {
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: '+ Testfall' }).click();
  const dlg = page.getByRole('dialog').first();
  await dlg.getByLabel('Titel').fill('Browser-Matrix');
  await dlg.getByRole('button', { name: '⚙ Kombinationen …' }).click();
  const combo = page.getByRole('dialog', { name: 'Durchläufe kombinatorisch erzeugen' });
  await combo.getByLabel('Werte 1').fill('Chrome, Firefox, Edge');
  await combo.getByLabel('Werte 2').fill('Admin, Leser, Gast');
  await combo.getByRole('button', { name: '+ Parameter' }).click();
  await combo.getByLabel('Parameter 3', { exact: true }).fill('os');
  await combo.getByLabel('Werte 3').fill('Windows, Linux');
  await expect(combo).toContainText('Alle zulässigen Wertepaare abgedeckt');
  await expect(combo).toContainText('statt 18');
  await combo.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(dlg.getByText(/parametrisiert · \d+ Durchläufe/)).toBeVisible();
});
