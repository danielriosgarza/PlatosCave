import { configDefaults, defineConfig } from 'vitest/config';

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
          testTimeout: 15000,
          hookTimeout: 60000,
        },
      },
      {
        test: {
          name: 'runner',
          environment: 'node',
          include: ['apps/runner/test/**/*.docker.itest.ts'],
          // The suites share one Docker daemon and each sweeps every sandbox container at the end.
          fileParallelism: false,
          testTimeout: 120000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
