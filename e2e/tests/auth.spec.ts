import { expect, test } from '@playwright/test';
import { secret } from './helpers.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test('falsches Passwort wird verständlich abgelehnt, richtiges meldet an, Abmelden führt zurück', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Benutzername').fill('lena.leser');
  await page.getByLabel('Kennwort', { exact: true }).fill('falsch-falsch-1');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.notice.bad')).toBeVisible();

  await page.getByLabel('Kennwort', { exact: true }).fill(secret('lena.leser'));
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page).toHaveURL(/#\/p\/DEMO\/start/);
  await expect(page).toHaveTitle(/Start · DEMO/);

  await page.locator('.account-btn').click();
  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
});

test('ohne Anmeldung liefert die API 401', async ({ request }) => {
  expect((await request.get('/api/projects')).status()).toBe(401);
});
