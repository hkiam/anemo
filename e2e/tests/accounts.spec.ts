import { expect, test } from '@playwright/test';
import { toast } from './helpers.ts';

test('Konto mit Einmal-Kennwort: Pflichtwechsel beim ersten Anmelden, danach Zurücksetzen durch die Administration', async ({ page, browser }) => {
  // Administration legt ein Konto an – das Einmal-Kennwort erscheint genau einmal
  await page.goto('/#/admin/users');
  await page.getByRole('button', { name: '+ Benutzer' }).click();
  const dlg = page.getByRole('dialog', { name: 'Neuer Benutzer' });
  await dlg.getByLabel('Benutzername').fill('erika.e2e');
  await dlg.getByLabel('Anzeigename').fill('Erika E2E');
  await dlg.getByRole('button', { name: 'Anlegen' }).click();
  const once = page.getByRole('dialog', { name: 'Einmal-Kennwort für erika.e2e' });
  const temp = (await once.getByLabel('Einmal-Kennwort').textContent())!.trim();
  expect(temp).toMatch(/^[A-Za-z2-9-]{23}$/);
  await once.getByRole('button', { name: 'Fertig' }).click();
  await expect(page.locator('tr', { hasText: 'erika.e2e' }).getByText('Kennwortwechsel ausstehend')).toBeVisible();

  // Person meldet sich an und muss zuerst ein eigenes Kennwort festlegen
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p2 = await ctx.newPage();
  await p2.goto('/');
  await p2.getByLabel('Benutzername').fill('erika.e2e');
  await p2.getByLabel('Kennwort', { exact: true }).fill(temp);
  await p2.getByRole('button', { name: 'Anmelden' }).click();
  await expect(p2.getByRole('heading', { name: 'Neues Kennwort festlegen' })).toBeVisible();
  await p2.getByLabel('Bisheriges bzw. Einmal-Kennwort').fill(temp);
  await p2.getByLabel('Neues Kennwort', { exact: true }).fill('kurz1');
  await expect(p2.getByText(/Noch nicht erfüllt: mindestens 12 Zeichen/)).toBeVisible();
  await p2.getByLabel('Neues Kennwort', { exact: true }).fill('Eigenes-Kennwort-77');
  await p2.getByLabel('Neues Kennwort wiederholen').fill('Eigenes-Kennwort-77');
  await p2.getByRole('button', { name: 'Kennwort festlegen' }).click();
  await expect(p2.getByRole('heading', { name: 'Neues Kennwort festlegen' })).toHaveCount(0);
  await expect(p2.locator('.account-btn')).toContainText('Erika E2E');

  // Administration setzt zurück (vorgegeben, ohne Pflichtwechsel) – die Sitzung der Person endet
  await page.reload();
  await page.locator('tr', { hasText: 'erika.e2e' }).getByRole('button', { name: 'erika.e2e bearbeiten' }).click();
  const ed = page.getByRole('dialog', { name: 'Benutzer erika.e2e' });
  await expect(ed.getByText('Angemeldete Sitzungen (1)')).toBeVisible();
  await ed.getByRole('button', { name: 'Kennwort zurücksetzen …' }).click();
  const rs = page.getByRole('dialog', { name: 'Kennwort von erika.e2e zurücksetzen' });
  await rs.getByLabel('Kennwort festlegen').check();
  await rs.getByLabel('Neues Kennwort').fill('Vorgabe-Kennwort-55');
  await rs.getByLabel('Beim nächsten Anmelden ändern').uncheck();
  await rs.getByRole('button', { name: 'Zurücksetzen' }).click();
  await expect(toast(page, 'Kennwort von erika.e2e zurückgesetzt')).toBeVisible();
  await p2.reload();
  await expect(p2.getByRole('button', { name: 'Anmelden' })).toBeVisible();
  await ctx.close();
});
