import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page } from '@playwright/test';

export const STATE = new URL('../.state/', import.meta.url).pathname;
export const BASE = `http://localhost:${process.env.E2E_PORT ?? 8097}`;

/** Zugangsdaten der Testkonten (nur in e2e/.state, zufällig je Lauf). */
export function secret(user: string): string {
  if (user === 'admin') return readFileSync(`${STATE}admin-password`, 'utf8');
  return (JSON.parse(readFileSync(`${STATE}secrets.json`, 'utf8')) as Record<string, string>)[user]!;
}

/** Eigener Browserkontext, per API angemeldet – für Rollen-Tests. */
export async function loginAs(browser: Browser, user: string, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport, locale: 'de-DE', storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  const r = await page.request.post('/api/auth/login', { data: { username: user, password: secret(user) } });
  expect(r.ok(), `Anmeldung ${user}`).toBeTruthy();
  return page;
}

/** Laufzeitfehler der Seite sammeln (Netzwerkfehler wie 401/404 sind teils erwartet und zählen nicht). */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

export const toast = (page: Page, text: string | RegExp) => page.locator('.toast').filter({ hasText: text });
