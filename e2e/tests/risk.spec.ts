import { expect, test } from '@playwright/test';
import { STATE, toast } from './helpers.ts';

test('Risikobasierte Auswahl: Vorschlag im Budget berechnen, Gründe sehen, aufnehmen', async ({ page, request }) => {
  const cycle = (await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'Risiko E2E' } })).json()).id;
  await page.goto(`/#/p/DEMO/cycles/${cycle}`);
  await page.getByRole('button', { name: 'Tests aufnehmen', exact: true }).click();
  await page.getByRole('button', { name: '⚖ Risikobasiert …' }).click();
  const dlg = page.getByRole('dialog', { name: 'Risikobasierte Testauswahl' });
  await dlg.getByLabel('Budgetart').selectOption('count');
  await dlg.getByLabel('Anzahl Tests').fill('2');
  await dlg.getByText('Änderungsumfang des Release (optional)').click();
  await dlg.getByLabel('Änderungsbeschreibung').fill('Aktenanlage überarbeitet');
  await dlg.getByRole('button', { name: 'Vorschlag berechnen' }).click();
  await expect(dlg.locator('.notice.info')).toContainText(/Vorschlag: 2 Tests/);
  await expect(dlg.locator('tbody input[type=checkbox]:checked')).toHaveCount(2);
  // Gründe aufklappen
  await dlg.locator('tbody tr').first().getByRole('button').click();
  await expect(dlg.locator('.risk-factors').first()).toContainText(/\+\d+/);
  await page.screenshot({ path: `${STATE}shots/risikoauswahl.png` });
  await dlg.getByRole('button', { name: 'Auswahl aufnehmen (2)' }).click();
  await expect(toast(page, '2 Tests risikobasiert aufgenommen')).toBeVisible();
  const ex = await (await request.get(`/api/cycles/${cycle}/executions`)).json();
  expect(ex.items).toHaveLength(2);
});
