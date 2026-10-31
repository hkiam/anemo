import { expect, test } from '@playwright/test';

test('Auswertungen: Cockpit mit Verlauf, Team und Top-Fehlern; Portfolio und Startseiten-Kacheln', async ({ page, request }) => {
  const plans = await (await request.get('/api/projects/DEMO/plans')).json();
  const plan = plans[0].id as string;
  await page.goto(`/#/p/DEMO/cycles?plan=${plan}&tab=cockpit`);
  await expect(page.getByRole('heading', { name: 'Abdeckung der Anforderungen im Verlauf' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team & Aufwand' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Top-Fehler/ })).toBeVisible();
  // Stichtag → Link zum Rückverfolgbarkeitsbericht mit asOf
  await page.getByLabel('Stichtag').fill('2026-01-15');
  await expect(page.getByRole('link', { name: 'Bericht zum Stichtag' })).toHaveAttribute('href', /asOf=2026-01-15/);

  // Exporte liefern Excel
  const x = await request.get(`/api/projects/DEMO/workload?planId=${plan}&format=xlsx`);
  expect(x.ok()).toBeTruthy();
  expect(x.headers()['content-type']).toContain('spreadsheetml');

  // Portfolio über die Navigation
  await page.getByRole('link', { name: 'Portfolio' }).click();
  await expect(page).toHaveURL(/#\/portfolio/);
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await expect(page.locator('tr', { hasText: 'DEMO' }).first()).toBeVisible();

  // Startseite der Testleitung zeigt die neuen Kacheln
  await page.goto('/#/p/DEMO/start');
  await expect(page.getByRole('region', { name: 'Team & Aufwand' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Top-Fehler' })).toBeVisible();
});
