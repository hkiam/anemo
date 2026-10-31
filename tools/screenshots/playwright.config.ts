import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SHOWCASE_PORT ?? 8098);

/**
 * Screenshots für README und Website (docs/bilder/screenshots): fiktive Daten, frische Datenbank.
 *   npm run screenshots
 */
export default defineConfig({
  testDir: '.',
  testMatch: /showcase\.spec\.ts/,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: '.state/results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${port}`,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    // Datumsfelder u. Ä. folgen der Sprache des Browsers, nicht nur der Locale
    launchOptions: { args: ['--lang=de-DE'] },
  },
  webServer: {
    command: 'node server.ts',
    url: `http://localhost:${port}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
