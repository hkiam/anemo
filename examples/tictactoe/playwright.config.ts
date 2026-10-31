import { defineConfig, devices } from '@playwright/test';

/** BDD-Beispiel: Gherkin-Szenarien (features/) → Playwright-Tests; Ergebnis als JUnit für Anemo. */
export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['junit', { outputFile: 'results/junit.xml' }]],
  use: { baseURL: 'http://localhost:8111', locale: 'de-DE', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node bdd/serve.ts', url: 'http://localhost:8111', reuseExistingServer: true },
  outputDir: 'results/artefakte',
});
