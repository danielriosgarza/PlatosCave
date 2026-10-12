import { configDefaults, defineConfig } from 'vitest/config';

// A cold start on Windows takes longer than the limits below allow; Linux and CI keep them.
const windows = process.platform === 'win32';
const coldStart = windows ? { testTimeout: 30000, hookTimeout: 60000 } : {};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/**/*.test.ts',
            'apps/server/src/**/*.test.ts',
            'apps/runner/src/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          ...coldStart,
        },
      },
      {
        extends: 'apps/web/vite.config.ts',
        root: 'apps/web',
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
          ...coldStart,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['apps/server/test/integration/**/*.itest.ts', 'apps/runner/test/**/*.itest.ts'],
          // The runner's Docker suites need the runner image, which only the `runner` job builds.
          exclude: [...configDefaults.exclude, 'apps/runner/test/**/*.docker.itest.ts'],
          globalSetup: ['apps/server/test/integration/global-setup.ts'],
          testTimeout: windows ? 60000 : 15000,
          hookTimeout: 60000,
          // With every file at once the content jobs outlast their waits on Windows.
          ...(windows ? { maxWorkers: 5 } : {}),
        },
      },
      {
        test: {
          name: 'runner',
          environment: 'node',
          include: ['apps/runner/test/**/*.docker.itest.ts'],
          // Each file's afterAll sweeps every `parallax.runner` container, so files must not overlap.
          fileParallelism: false,
          testTimeout: 120000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
