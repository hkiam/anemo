import { expect, test } from '@playwright/test';
import { toast } from './helpers.ts';

test('Administration Stufe I: nur Zuständige, Jira-Zuordnung, Benachrichtigung „Beobachtet“, OpenProject-Hinweis', async ({ page, request }) => {
  await page.goto('/#/admin/projects');
  const box = page.getByLabel('Nur Zuständige DEMO');
  await box.click();
  await expect(toast(page, /DEMO: Ergebnisse nur noch durch die zuständige Person/)).toBeVisible();
  expect((await (await request.get('/api/projects/DEMO')).json()).executeOnlyAssignee).toBe(true);
  await expect(box).toBeChecked();
  await box.click();
  await expect(toast(page, /DEMO: Ergebnisse durch alle/)).toBeVisible();

  await page.goto('/#/admin/jira');
  await page.getByLabel('Anemo-Projekt für Jira').selectOption('DEMO');
  await page.getByLabel('Jira-Projektschlüssel').fill('qa');
  await page.getByLabel('Jira-Priorität für Hoch').fill('Hoch');
  await page.getByRole('button', { name: 'Speichern' }).last().click();
  await expect(toast(page, 'DEMO: Fehler gehen nach Jira QA')).toBeVisible();
  const links = await (await request.get('/api/projects/DEMO/integrations')).json();
  expect(links.find((l: { provider: string }) => l.provider === 'jira')).toMatchObject({ externalProject: 'QA', settings: { issueType: 'Bug', priorities: { Hoch: 'Hoch' } } });
  await page.getByRole('button', { name: 'Zuordnung entfernen …' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Zuordnung entfernen' }).click();
  await expect(toast(page, 'Jira-Zuordnung von DEMO entfernt')).toBeVisible();

  await page.goto('/#/admin/openproject');
  await expect(page.getByText('Erst Zugang einrichten – dann lassen sich Anemo-Projekte OpenProject-Projekten zuordnen.')).toBeVisible();

  await page.goto('/#/p/DEMO/start');
  await page.locator('.account-btn').click();
  await page.getByRole('button', { name: /Benachrichtigungen/ }).click();
  await expect(page.getByRole('dialog').getByText(/die ich beobachte/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
  // Beobachtet-Liste im Kontomenü
  const cycle = (await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'Beobachtet E2E' } })).json()).id;
  await request.put(`/api/watch/TEST_CYCLE/${cycle}`);
  await page.locator('.account-btn').click();
  await page.getByRole('button', { name: /Beobachtet/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Beobachtet' });
  await expect(dlg.getByRole('link', { name: 'Beobachtet E2E' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Nicht mehr beobachten' }).first().click();
  await expect(dlg.getByRole('link', { name: 'Beobachtet E2E' })).toHaveCount(0);
});
