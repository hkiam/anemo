import { expect, test } from '@playwright/test';
import { loginAs } from './helpers.ts';

test('Startseite: meine Aufgaben, Weiter testen, persönlich anpassen', async ({ browser, request }) => {
  // Admin weist Tina zwei Ausführungen in einem neuen Zyklus zu
  const cycle = (await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'Start E2E' } })).json()).id;
  const tcs = (await (await request.get('/api/projects/DEMO/test-cases?limit=2')).json()).items.map((t: { key: string }) => t.key);
  await request.post(`/api/cycles/${cycle}/executions`, { data: { testCaseIds: tcs } });
  const ex = (await (await request.get(`/api/cycles/${cycle}/executions`)).json()).items.map((e: { id: string }) => e.id);
  expect((await request.post('/api/executions/bulk-assign', { data: { ids: ex, assignee: 'tina.tester' } })).ok()).toBeTruthy();

  const page = await loginAs(browser, 'tina.tester');
  await page.goto('/');
  const tasks = page.getByRole('region', { name: 'Meine Aufgaben' });
  await expect(tasks).toContainText(/\d+ offene Ausführungen? in \d+ Zykl/);
  await expect(tasks.getByText('Start E2E').first()).toBeVisible();
  const popupP = page.waitForEvent('popup');
  await tasks.getByRole('link', { name: '▶ Weiter testen' }).click();
  const win = await popupP;
  await expect(win.getByRole('group', { name: 'Gesamtergebnis' })).toBeVisible();
  await win.close();

  // Anpassen: Kachel ausblenden und verschieben – bleibt nach Neuladen erhalten
  await page.getByRole('button', { name: '⚙ Anpassen' }).click();
  await page.getByRole('button', { name: 'Zuletzt fehlgeschlagen ausblenden' }).click();
  await page.getByRole('button', { name: 'Schnellzugriff nach oben' }).click();
  await page.getByRole('button', { name: 'Fertig' }).click();
  await expect(page.getByRole('region', { name: 'Zuletzt fehlgeschlagen' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Meine Aufgaben' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Zuletzt fehlgeschlagen' })).toHaveCount(0);
  const order = await page.locator('.start-card h3').allTextContents();
  expect(order.slice(0, 3)).toEqual(['Meine Aufgaben', 'Aktive Testzyklen', 'Schnellzugriff']);
  // Standard wiederherstellen
  await page.getByRole('button', { name: '⚙ Anpassen' }).click();
  await page.getByRole('button', { name: 'Standard wiederherstellen' }).click();
  await page.getByRole('button', { name: 'Fertig' }).click();
  await expect(page.getByRole('region', { name: 'Zuletzt fehlgeschlagen' })).toBeVisible();
  await page.context().close();
});
