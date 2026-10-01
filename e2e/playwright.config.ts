import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { e2eDatabaseUrl } from './global-setup';
import { mailDir } from './paths';

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'tests',
  testMatch: /\.e2e\.ts$/,
  timeout: 30_000,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'pnpm --filter @parallax/server start',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: !CI,
    // One server, two origins (ADR-0002): the app on 127.0.0.1, the content origin on localhost.
    env: {
      PORT: '3100',
      HOST: '0.0.0.0',
      APP_HOST: '127.0.0.1',
      CONTENT_HOST: 'localhost',
      CONTENT_ORIGIN: 'http://localhost:3100',
      STORAGE_DRIVER: 'fs',
      STORAGE_DIR: resolve(import.meta.dirname, '../.local/e2e-storage'),
      NODE_ENV: 'test',
      STATIC_DIR: resolve(import.meta.dirname, '../apps/web/dist'),
      DATABASE_URL: e2eDatabaseUrl,
      // Sign-in links in the mail must point at this server; the file mailer writes to the
      // repository-root .local/mail (ADR-0001), not the server's working directory.
      APP_ORIGIN: 'http://127.0.0.1:3100',
      MAIL_DIR: mailDir,
      // The limits are in memory and reuseExistingServer keeps them across local runs; mail round
      // trips stay cheap to repeat until P1-03's signin-as fixture replaces most of them.
      AUTH_LINK_RATE_LIMIT: '10000',
      AUTH_VERIFY_RATE_LIMIT: '10000',
    },
  },
});
