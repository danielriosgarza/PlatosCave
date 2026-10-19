import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);

/**
 * The browser suite of a level 0 site (docs/design/open-site.md §10): the tests of `open/` against
 * the two static hosts of `static-server.ts`, which builds the school fixture first. No global
 * setup, no database and no API server; the suite of `playwright.config.ts` is not collected.
 */
export default defineConfig({
  testDir: 'open',
  testMatch: /\.e2e\.ts$/,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  workers: 2,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: 'http://127.0.0.1:4175', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'node --import tsx static-server.ts',
    url: 'http://127.0.0.1:4175/',
    // The build converts two courses and compiles the shell first.
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
