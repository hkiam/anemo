import { expect, test } from '@playwright/test';
import { toast } from './helpers.ts';

test('Freie Links: in der Administration einschalten, Fehler als Link mit Kurznamen an einem Schritt verknüpfen, Status von Hand', async ({ page, request }) => {
  await page.goto('/#/admin/integrations');
  const card = page.locator('section, .card', { hasText: 'Freie Links (URL mit Kurznamen)' }).last();
  await card.getByLabel('Freie Links erlauben').check();
  await card.getByRole('button', { name: 'Speichern' }).click();
  await expect(toast(page, /gespeichert/)).toBeVisible();

  const cycle = (await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'Links E2E' } })).json()).id;
  await request.post(`/api/cycles/${cycle}/executions`, { data: { testCaseIds: ['DEMO-T1'] } });
  const exec = (await (await request.get(`/api/cycles/${cycle}/executions`)).json()).items[0].id;
  await page.goto(`/#/p/DEMO/cycles/${cycle}?exec=${exec}`);
  await page.getByRole('toolbar', { name: 'Aktionen zu Schritt 1' }).getByRole('button', { name: 'Fehler mit Schritt 1 verknüpfen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Fehler mit Schritt 1 verknüpfen' });
  await dlg.getByRole('tab', { name: 'Link (URL)' }).click();
  await dlg.getByLabel('Adresse (URL)').fill('https://bugs.example.net/show?id=4711');
  await dlg.getByLabel('Kurzname (wird angezeigt)').fill('Altsystem-Bug 4711');
  await dlg.getByRole('button', { name: 'Verknüpfen' }).click();
  await expect(toast(page, 'Altsystem-Bug 4711 verknüpft')).toBeVisible();
  await expect(page.locator('.step-defect-badge', { hasText: 'Altsystem-Bug 4711' })).toBeVisible();
  const refs = await (await request.get(`/api/references?ownerType=TEST_EXECUTION&ownerId=${exec}`)).json();
  expect(refs[0]).toMatchObject({ provider: 'url', title: 'Altsystem-Bug 4711', status: 'offen', url: 'https://bugs.example.net/show?id=4711' });
  // Werkzeugleiste: einheitliche Knöpfe unter dem Ergebnis
  await expect(page.getByRole('toolbar', { name: 'Aktionen zum Ergebnis' }).getByRole('button', { name: /Fehler melden/ })).toBeVisible();
});
