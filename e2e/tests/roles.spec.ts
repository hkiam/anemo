import { expect, test } from '@playwright/test';
import { loginAs, toast } from './helpers.ts';

test('Leser sieht Inhalte, aber keine Pflege- oder Ausführungsaktionen', async ({ browser }) => {
  const page = await loginAs(browser, 'lena.leser');
  await page.goto('/#/p/DEMO/repo');
  await expect(page.locator('tr.clickable').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Testfall' })).toHaveCount(0);
  await page.locator('tr.clickable').first().click();
  await expect(page.locator('.detail-title')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bearbeiten', exact: true })).toHaveCount(0);

  await page.goto('/#/p/DEMO/cycles');
  await expect(page.getByRole('button', { name: '+ Plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Testzyklus' })).toHaveCount(0);
  await page.locator('tbody tr.clickable').first().click();
  await expect(page.getByRole('link', { name: /Durchführen/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tests aufnehmen', exact: true })).toHaveCount(0);
  // Schreibversuch über die API wird abgelehnt
  const r = await page.request.post('/api/projects/DEMO/plans', { data: { name: 'darf nicht' } });
  expect(r.status()).toBe(403);
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  await page.context().close();
});

test('Eingeschränktes Projekt: Nichtmitglieder sehen es nirgends, Gruppenmitglieder schon', async ({ browser }) => {
  const outsider = await loginAs(browser, 'lena.leser');
  await outsider.goto('/#/p/DEMO/repo');
  await expect(outsider.getByLabel('Projekt')).toBeVisible();
  await expect(outsider.getByLabel('Projekt').locator('option', { hasText: 'GEHEIM' })).toHaveCount(0);
  expect((await outsider.request.get('/api/projects/GEHEIM')).status()).toBe(404);
  const search = await (await outsider.request.get('/api/search?q=Vertraulicher')).json() as { groups: { total: number }[] };
  expect(search.groups.reduce((a, g) => a + g.total, 0)).toBe(0);
  await outsider.context().close();

  const member = await loginAs(browser, 'gerd.geheim');
  await member.goto('/#/p/GEHEIM/repo');
  await expect(member.locator('tr.clickable', { hasText: 'Vertraulicher Ablauf' })).toBeVisible();
  await member.context().close();
});

test('Admin: Projekt anlegen, gesammelt einschränken mit Warnung, Mitglieder zuordnen', async ({ page }) => {
  await page.goto('/#/admin/projects');
  await page.getByRole('button', { name: '+ Projekt' }).click();
  const dlg = page.getByRole('dialog', { name: undefined }).filter({ hasText: 'Neues Projekt' });
  await dlg.getByLabel('Schlüssel').fill('pol');
  await expect(dlg.getByLabel('Schlüssel')).toHaveValue('POL');
  await dlg.getByLabel('Name').fill('Schutzbedarf Pilot');
  await dlg.getByRole('button', { name: 'Anlegen' }).click();
  await expect(toast(page, 'Projekt POL angelegt')).toBeVisible();
  // neues Projekt erscheint sofort in der Projektauswahl
  await expect(page.getByLabel('Projekt').locator('option', { hasText: 'POL' })).toHaveCount(1);

  await page.getByPlaceholder('Schlüssel oder Name filtern …').fill('');
  await page.getByLabel('POL auswählen').check();
  await page.getByRole('button', { name: 'Einschränken', exact: true }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Ohne Mitglieder: POL');
  await ask.getByRole('button', { name: 'Einschränken' }).click();
  await expect(page.getByLabel('Sichtbarkeit POL')).toHaveValue('restricted');
  await expect(page.locator('tr', { hasText: 'Schutzbedarf Pilot' }).locator('.badge.warn')).toBeVisible();
  await expect(page.getByLabel('Externe Dienste POL')).toHaveValue('blocked');

  await page.locator('tr', { hasText: 'Schutzbedarf Pilot' }).getByRole('button', { name: /^Mitglieder/ }).click();
  const members = page.getByRole('dialog');
  await members.getByLabel('Benutzer oder Gruppe').selectOption({ label: 'Ermittlung' });
  await members.getByLabel('Rolle', { exact: true }).selectOption({ label: 'Pflegen' });
  await members.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(members.locator('td', { hasText: 'Ermittlung' })).toBeVisible();
  await members.getByRole('button', { name: 'Schließen' }).last().click();
  await expect(page.locator('tr', { hasText: 'Schutzbedarf Pilot' }).locator('.badge.warn')).toHaveCount(0);
});

test('Klick auf „Anemo“ führt zur Startseite; Kacheln je Rolle', async ({ browser, page }) => {
  await page.goto('/#/p/DEMO/cycles');
  await page.getByRole('link', { name: 'Anemo – zur Startseite' }).click();
  await expect(page).toHaveURL(/#\/p\/DEMO\/start/);
  await expect(page.getByRole('region', { name: 'Aufgaben der Testleitung' })).toBeVisible();

  const tester = await loginAs(browser, 'tina.tester');
  await tester.goto('/#/p/DEMO/health');
  await tester.getByRole('link', { name: 'Anemo – zur Startseite' }).click();
  await expect(tester).toHaveURL(/#\/p\/DEMO\/start/);
  await expect(tester.getByRole('region', { name: 'Meine Aufgaben' })).toBeVisible();
  await expect(tester.getByRole('region', { name: 'Aufgaben der Testleitung' })).toHaveCount(0);
  await tester.context().close();
});
