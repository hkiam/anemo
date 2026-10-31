import { expect, test } from '@playwright/test';
import { toast } from './helpers.ts';

test('Einstellungen: Wert festlegen, Herkunft sehen, zurücksetzen; Geheimnisse bleiben verborgen', async ({ page }) => {
  // Suche unter System → Allgemein führt zur Seite, auf der die Einstellung gepflegt wird
  await page.goto('/#/admin/settings');
  await page.getByLabel('Einstellungen suchen').fill('SMTP_HOST');
  await page.getByRole('link', { name: /Benachrichtigungen → E-Mail/ }).click();
  await expect(page).toHaveURL(/#\/admin\/mail/);
  const smtp = page.locator('#einstellung-smtp');
  await expect(smtp.getByRole('heading', { name: 'Versand (SMTP)' })).toBeVisible();
  const host = smtp.locator('.setting', { hasText: 'SMTP_HOST' });
  await expect(host.locator('.badge')).toHaveText('nicht gesetzt');
  await host.getByRole('textbox').fill('smtp.e2e.test');
  await smtp.locator('.setting', { hasText: 'SMTP_PASSWORD' }).locator('input').fill('streng-geheim');
  await smtp.locator('.setting', { hasText: 'SMTP_FROM' }).getByRole('textbox').fill('Anemo <anemo@e2e.test>');
  await smtp.getByRole('button', { name: 'Speichern' }).click();
  await expect(toast(page, 'Versand (SMTP) gespeichert')).toBeVisible();
  await expect(host.locator('.badge').first()).toHaveText('Oberfläche');
  const pw = smtp.locator('.setting', { hasText: 'SMTP_PASSWORD' });
  await expect(pw.locator('input')).toHaveValue('');
  await expect(pw.locator('input')).toHaveAttribute('placeholder', /gesetzt/);
  expect(await page.content()).not.toContain('streng-geheim');

  await host.getByRole('button', { name: /zurücksetzen/ }).click();
  await expect(host.locator('.badge').first()).toHaveText('nicht gesetzt');
  // aufräumen
  for (const k of ['SMTP_PASSWORD', 'SMTP_FROM']) await smtp.locator('.setting', { hasText: k }).getByRole('button', { name: /zurücksetzen/ }).click();
});

test('KI: Hauptschalter aus/an, Funktionsübersicht und Prompts', async ({ page }) => {
  await page.goto('/#/admin/ai');
  const sw = page.getByLabel('KI-Funktionen ein/aus');
  await expect(sw).toBeChecked();
  await expect(page.getByRole('heading', { name: 'Wo KI in Anemo wirkt' })).toBeVisible();
  await expect(page.locator('tr', { hasText: 'Testfall-Entwurf aus Anforderung' }).locator('.badge')).toHaveText('aktiv');
  await sw.click(); // fragt erst nach – Zustand ändert sich nach Bestätigung
  await page.getByRole('alertdialog').getByRole('button', { name: 'Ausschalten' }).click();
  await expect(toast(page, 'KI-Funktionen ausgeschaltet')).toBeVisible();
  await expect(page.locator('tr', { hasText: 'Testfall-Entwurf aus Anforderung' }).locator('.badge')).toHaveText('aus');
  // im Projekt keine KI-Schaltfläche
  await page.goto('/#/p/DEMO/repo');
  await expect(page.getByRole('button', { name: /Aus Anforderung/ })).toHaveCount(0);
  await page.goto('/#/admin/ai');
  await page.getByLabel('KI-Funktionen ein/aus').click();
  await expect(toast(page, 'KI-Funktionen eingeschaltet')).toBeVisible();

  await page.getByText('Testfall aus Anforderung').click();
  const editor = page.locator('.prompt-editor', { hasText: 'Testfall aus Anforderung' });
  await editor.locator('textarea').fill('Du bist QA-Analyst. Eigener Prompt für den E2E-Test, antworte mit JSON.');
  await editor.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('.prompt-editor', { hasText: 'Testfall aus Anforderung' }).locator('.badge', { hasText: 'angepasst' })).toBeVisible();
  await page.locator('.prompt-editor', { hasText: 'Testfall aus Anforderung' }).getByRole('button', { name: 'Standard wiederherstellen' }).click();
  await expect(page.locator('.prompt-editor', { hasText: 'Testfall aus Anforderung' }).locator('.badge', { hasText: 'angepasst' })).toHaveCount(0);
});
