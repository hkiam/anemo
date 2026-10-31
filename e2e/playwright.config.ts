import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8097);

/** Ende-zu-Ende-Tests gegen einen eigenen Anemo-Server mit frischer Datenbank (siehe server.ts). */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'setup', testMatch: /setup\.ts/ },
    { name: 'desktop', dependencies: ['setup'], testIgnore: /setup\.ts|mobile\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: '.state/admin.json' } },
    { name: 'laptop', dependencies: ['setup'], testMatch: /layout\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, storageState: '.state/admin.json' } },
    { name: 'mobile', dependencies: ['setup'], testMatch: /(layout|mobile)\.spec\.ts/, use: { ...devices['Pixel 7'], storageState: '.state/admin.json' } },
  ],
  webServer: {
    command: 'node server.ts',
    url: `http://localhost:${port}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
