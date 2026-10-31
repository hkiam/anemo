import { expect, test } from '@playwright/test';

test('Kontextsensitive Hilfe: F1 zur Ansicht, folgt dem Seitenwechsel, Hilfe-Knopf im Dialog, Themensuche, Kapitel mit Sprungmarke', async ({ page, context }) => {
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('heading', { name: 'Ordner' }).waitFor();
  await page.keyboard.press('F1');
  const help = page.getByRole('complementary', { name: 'Testfälle finden und filtern' });
  await expect(help).toBeVisible();
  await expect(help.getByText('Abfragesprache').first()).toBeVisible();
  

  // folgt der Ansicht
  await page.getByRole('link', { name: 'Planung & Ausführung' }).click();
  await expect(page.getByRole('complementary', { name: 'Aufbau der Planung' })).toBeVisible();

  // Themensuche und verwandte Themen
  await page.getByLabel('Hilfethema suchen').fill('Excel-Rund');
  await page.getByRole('button', { name: 'Excel-Rundlauf' }).click();
  await expect(page.getByRole('complementary', { name: 'Excel-Rundlauf' })).toBeVisible();
  await page.getByRole('button', { name: 'Zur Ansicht' }).click();
  await expect(page.getByRole('complementary', { name: 'Aufbau der Planung' })).toBeVisible();

  // Kapitel im Handbuch mit Sprungmarke (neuer Tab, Eingaben bleiben erhalten)
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: /Ganzes Kapitel/ }).click()]);
  await expect(tab).toHaveURL(/#\/hilfe\/03-planung-durchfuehrung\?a=aufbau/);
  await expect(tab.locator('#aufbau')).toBeFocused();
  await tab.close();

  // Hilfe-Knopf im Dialog: Thema des Dialogs, Hilfe bleibt neben dem Dialog bedienbar
  await page.keyboard.press('F1');
  await expect(page.getByRole('complementary')).toHaveCount(0);
  const cycle = (await (await page.request.post('/api/projects/DEMO/cycles', { data: { name: 'Hilfe E2E' } })).json()).id;
  await page.goto(`/#/p/DEMO/cycles/${cycle}`);
  await page.getByRole('button', { name: 'Risikobasiert auswählen …' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hilfe: Risikobasierte Testauswahl' }).click();
  const riskHelp = page.getByRole('complementary', { name: 'Risikobasierte Testauswahl' });
  await expect(riskHelp).toBeVisible();
  
  await riskHelp.getByRole('button', { name: 'Hilfe schließen' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  // Knopf in der Kopfzeile
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Hilfe zu dieser Ansicht' }).click();
  await expect(page.getByRole('complementary', { name: 'Zyklen anlegen und finden' })).toBeVisible();
});
