import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BASE, toast, watchErrors } from './helpers.ts';

test('K5: Projekt exportieren, Paket herunterladen, als neues Projekt einspielen (Probelauf, Einspielen, Bericht)', async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.goto('/#/transfer');
  await expect(page.getByRole('heading', { name: 'Projekte übertragen' })).toBeVisible();

  // Export anfordern: Auswahl per Schlüssel, nur aktuelle Versionen
  await page.getByLabel('Quellprojekt').selectOption('DEMO');
  await page.getByLabel('Auswahl').check();
  await page.getByLabel('Testfälle (Schlüssel)').fill('DEMO-T1');
  await page.getByLabel('Versionen').selectOption('current');
  await page.getByLabel('Anlass (für die Freigabe und das Protokoll)').fill('E2E-Umzug');
  await page.getByRole('button', { name: 'Export anfordern' }).click();
  await expect(toast(page, /Export DEMO wird erstellt/)).toBeVisible();

  const vorgaenge = page.getByRole('region', { name: 'Vorgänge' });
  const row = vorgaenge.getByRole('row').filter({ hasText: 'E2E-Umzug' });
  await expect(row.getByText('Auswahl (')).toBeVisible();
  const link = row.getByRole('link', { name: 'Herunterladen' });
  await expect(link).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^Projekt-DEMO-Auswahl-.*\.anemo\.zip$/);
  const path = await download.path();

  // Import als neues Projekt
  await page.getByRole('button', { name: 'Paket hochladen …' }).click();
  await page.getByLabel('Projektpaket (*.anemo.zip)').setInputFiles({ name: 'paket.anemo.zip', mimeType: 'application/zip', buffer: readFileSync(path!) });
  await expect(page.getByText(/Paket DEMO – /)).toBeVisible();
  await page.getByLabel('Projektschlüssel').fill('DEMOK');
  await page.getByLabel('Name', { exact: true }).fill('Demo (Kopie)');
  await page.getByRole('button', { name: 'Probelauf' }).click();
  await expect(page.getByText('Probelauf: DEMO → DEMOK (neues Projekt)')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Testfälle', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Einspielen', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Paket einspielen' }).getByRole('button', { name: 'Einspielen' }).click();
  await expect(page.getByText('Ergebnis: DEMO → DEMOK (neues Projekt)')).toBeVisible({ timeout: 20_000 });
  await expect(toast(page, 'Projekt DEMOK eingespielt')).toBeVisible();
  await page.getByRole('link', { name: 'Zum Projekt DEMOK' }).click();
  await expect(page).toHaveURL(/#\/p\/DEMOK\/repo/);
  const t1 = await (await request.get('/api/test-cases/DEMOK-T1')).json();
  expect(t1.key).toBe('DEMOK-T1');

  // Administration: Protokoll aller Vorgänge
  await page.goto('/#/admin/transfers');
  await page.getByLabel('Filter').selectOption('');
  await expect(page.getByRole('region', { name: 'Vorgänge' }).getByText('E2E-Umzug')).toBeVisible();
  expect(errors).toEqual([]);
});

test('K1: Recht „Projekte übertragen“ im Benutzerdialog vergeben', async ({ page, request }) => {
  const user = (await (await request.post('/api/admin/users', { data: { username: `k1-${Date.now()}`, displayName: 'K1 Übertragung', generatePassword: true } })).json());
  await page.goto('/#/admin/users');
  await page.getByRole('button', { name: `${user.username} bearbeiten` }).click();
  await page.getByLabel(/Projekte übertragen \(ganze Projekte/).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('row').filter({ hasText: user.username }).getByText('Projekte übertragen')).toBeVisible();
  const grants = await (await request.get('/api/admin/permissions')).json();
  expect(grants.grants.some((g: { principalId: string }) => g.principalId === user.id)).toBe(true);
});

test('K5: ohne Administration – „Übertragen“ erscheint nur mit dem Recht', async ({ browser, request }) => {
  const password = `Umzug-${Math.random().toString(36).slice(2)}-Sicher!9`;
  const created = await request.post('/api/admin/users', { data: { username: `pl${Date.now()}`, displayName: 'K5 Projektleitung', password, mustChangePassword: false } });
  expect(created.status(), await created.text()).toBe(201);
  const user = await created.json();
  await request.put('/api/projects/DEMO/members', { data: { principalType: 'user', principalId: user.id, role: 'PROJECT_ADMIN' } });
  const ctx = await browser.newContext({ baseURL: BASE, locale: 'de-DE', storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  const login = await page.request.post('/api/auth/login', { data: { username: user.username, password } });
  expect(login.status(), await login.text()).toBe(200);
  await page.goto('/#/p/DEMO/start');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Mitglieder' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Übertragen' })).toHaveCount(0);
  await request.put('/api/admin/permissions', { data: { principalType: 'user', principalId: user.id, permission: 'PROJECT_TRANSFER', granted: true } });
  await page.reload();
  await page.getByRole('link', { name: 'Übertragen' }).click();
  await expect(page.getByRole('heading', { name: 'Projekte übertragen' })).toBeVisible();
  await expect(page.getByLabel('Quellprojekt')).toHaveValue('DEMO');
  await ctx.close();
});

test('K5: liegendes Paket fortsetzen; Testpläne als Auswahl', async ({ page, request }) => {
  const t = await (await request.post('/api/projects/DEMO/exports', { data: { scope: { kind: 'selection', testCases: ['DEMO-T2'] }, note: 'E2E-Fortsetzen' } })).json();
  let pkg: Buffer | null = null;
  for (let i = 0; i < 50 && !pkg; i++) {
    const r = await request.get(`/api/project-transfers/${t.id}/download`);
    if (r.status() === 200) pkg = Buffer.from(await r.body()); else await page.waitForTimeout(200);
  }
  const up = await request.post('/api/package-imports', { headers: { 'content-type': 'application/zip' }, data: pkg! });
  expect(up.status(), await up.text()).toBe(201);
  await page.goto('/#/transfer');
  const row = page.getByRole('region', { name: 'Vorgänge' }).getByRole('row').filter({ hasText: 'hochgeladen' }).first();
  await row.getByRole('button', { name: 'Fortsetzen' }).click();
  await expect(page.getByText(/Paket DEMO – /)).toBeVisible();
  await page.getByLabel('in ein bestehendes Projekt').check();
  await page.getByLabel('Zielprojekt').selectOption('DEMO');
  await page.getByRole('button', { name: 'Probelauf' }).click();
  await expect(page.getByText('Probelauf: DEMO → DEMO (bestehendes Projekt)')).toBeVisible();
  await page.getByRole('button', { name: 'Verwerfen', exact: true }).first().click();

  await page.getByLabel('Quellprojekt').selectOption('DEMO');
  await page.getByLabel('Auswahl').check();
  await page.getByText(/^Testpläne \(mit allen Zyklen/).click();
  await expect(page.locator('details').filter({ hasText: 'Testpläne' }).getByRole('checkbox').first()).toBeVisible();
});
