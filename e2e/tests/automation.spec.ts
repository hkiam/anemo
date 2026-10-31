/**
 * Durchgängiger BDD-Ablauf mit dem Beispiel examples/tictactoe: Gherkin-Testfälle in Anemo, automatischer
 * Lauf mit Playwright, JUnit-Ergebnis per API-Token an Anemo – Ergebnisse landen im Zyklus.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parseFeature } from '../../examples/tictactoe/bdd/gherkin.ts';

const root = new URL('../../', import.meta.url).pathname;

test('Gherkin-Testfälle → Playwright-Lauf → Ergebnisse in Anemo', async ({ page }) => {
  test.setTimeout(120_000);
  const api = page.request;
  expect((await api.post('/api/projects', { data: { key: 'TTT', name: 'Tic-Tac-Toe (Beispiel)' } })).status()).toBe(201);
  // Testfälle aus der Feature-Datei (je Szenario bzw. Grundriss einer), Format Gherkin
  const text = readFileSync(`${root}examples/tictactoe/features/spiel.feature`, 'utf8');
  const seen = new Set<string>();
  for (const s of parseFeature(text).scenarios) {
    const key = s.tags.find((t) => /^@TTT-T\d+$/.test(t))!;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await api.post('/api/projects/TTT/test-cases', { data: { content: { title: s.name.replace(/ \(\d+\)$/, ''), format: 'GHERKIN', gherkin: `# language: de\nFunktionalität: Tic-Tac-Toe\n  Szenario: ${s.name}\n${s.steps.map((x) => `    ${x}`).join('\n')}\n`, steps: [] } } });
    expect(r.status(), await r.text()).toBe(201);
  }

  // Automatischer Lauf (wie in der CI)
  execFileSync('npx', ['playwright', 'test', '-c', 'examples/tictactoe', '--reporter=junit'], { cwd: root, env: { ...process.env, PLAYWRIGHT_JUNIT_OUTPUT_NAME: 'examples/tictactoe/results/junit.xml' }, stdio: 'ignore' });
  const xml = readFileSync(`${root}examples/tictactoe/results/junit.xml`, 'utf8');

  // Übergabe wie in der Pipeline: API-Token + automation-results
  const token = (await (await api.post('/api/auth/tokens', { data: { name: 'CI Tic-Tac-Toe', expiresDays: 1 } })).json()).token as string;
  const res = await api.post('/api/projects/TTT/automation-results?cycle=Nightly%20E2E&build=42', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/xml' }, data: xml,
  });
  expect(res.status(), await res.text()).toBe(201);
  const r = await res.json();
  expect(r.total).toBe(8);
  expect(r.mapped).toBe(8);
  expect(r.testCases).toBe(6);
  expect(r.unmapped).toEqual([]);

  await page.goto(`/#/p/TTT/cycles/${r.cycleId}`);
  await expect(page.getByRole('heading', { name: 'Nightly E2E' })).toBeVisible();
  await expect(page.locator('.chip-btn', { hasText: 'Bestanden (6)' })).toBeVisible();
});
