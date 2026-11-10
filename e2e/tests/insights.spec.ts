import { expect, test } from '@playwright/test';
import { watchErrors } from './helpers.ts';

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

test('Test-Health: Wechsel zwischen den Analysen zeigt nie die Daten der vorigen Analyse (Absturz bei langsamer Antwort)', async ({ page }) => {
  const errors = watchErrors(page);
  // Ähnliche Testfälle mit Kandidaten, die anderen Analysen antworten absichtlich langsam
  await page.route('**/api/projects/DEMO/assist/similar*', (r) => r.fulfill({ json: [{ a: 'DEMO-T1', b: 'DEMO-T2', aTitle: 'A', bTitle: 'B', score: 0.9, title: 0.8, content: 0.95 }] }));
  await page.route(/\/assist\/(clusters|coverage)/, async (r) => { await new Promise((res) => setTimeout(res, 800)); await r.continue(); });
  await page.goto('/#/p/DEMO/health?check=similar');
  await expect(page.getByText('Titel 80 · Inhalt 95')).toBeVisible();
  for (const [link, heading] of [['Fehlerursachen', 'Fehlerursachen-Cluster'], ['Ähnliche Testfälle', 'Ähnliche Testfälle'], ['Anforderungsabdeckung', 'Anforderungsabdeckung']] as const) {
    await page.getByRole('link', { name: new RegExp(`^${link}`) }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await page.waitForTimeout(1000);
  await expect(page.getByText('Hier ist etwas schiefgegangen')).toHaveCount(0);
  expect(errors).toEqual([]);
});
