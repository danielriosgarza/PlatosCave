import { expect, test } from '@playwright/test';
import { Connector, fixtures, onwardName, publishedPorts, studentWorkspace } from './connector';
import {
  connect,
  connectAndWaitReady,
  endSessions,
  openConnect,
  pairAndApprove,
  stage,
  testSsh,
  trustUntilDone,
  typeInCell,
} from './ui';

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

const ALL_PASSED = [
  'reachability',
  'host_identity',
  'ssh_auth',
  'workspace',
  'forwarding',
  'runtime',
  'kernels',
];

for (const route of [
  { label: 'directly', jump: false },
  { label: 'through the jump host', jump: true },
]) {
  test(`A28 SSH ${route.label}: host, account, workspace and kernel are visible and no Jupyter port is published`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const connector = new Connector();
    const name = `A28 ${route.jump ? 'jump' : 'direct'}`;
    try {
      await openConnect(page, 'reader', { studentOnly: true });
      await pairAndApprove(page, connector, name);
      await connect(page, connector, name);
      await testSsh(page, {
        name: `${name} notebook`,
        host: route.jump ? onwardName : '127.0.0.1',
        port: route.jump ? 22 : fixtures.direct,
        user: 'student',
        workspace: studentWorkspace,
        jump: route.jump ? { host: '127.0.0.1', port: fixtures.jump, user: 'jump' } : undefined,
      });
      await trustUntilDone(page);

      // Every stage passed, and the summary names what Connect will do before it does it.
      for (const s of ALL_PASSED) await expect(stage(page, s)).toHaveAttribute('data-status', 'ok');
      const summary = page.locator('dl').filter({ hasText: 'Working directory' });
      await expect(summary).toContainText(
        route.jump ? `${onwardName}:22` : `127.0.0.1:${fixtures.direct}`,
      );
      await expect(summary).toContainText('student');
      await expect(summary).toContainText(studentWorkspace);
      await expect(stage(page, 'kernels')).toHaveAttribute('data-status', 'ok');

      await connectAndWaitReady(page);
      await expect(page.getByRole('status').filter({ hasText: 'Ready' })).toContainText(
        `${name} notebook`,
      );

      // The kernel behind the tunnel runs a cell.
      await page.getByRole('button', { name: 'Close' }).click();
      const notebook = page.getByRole('article', { name: 'Live notebook' });
      await typeInCell(page, /^Code of cell 2/, 'print(6 * 7)');
      await notebook.getByRole('button', { name: /^Run cell 2/ }).click();
      await expect(notebook.getByText('42', { exact: true })).toBeVisible({ timeout: 60_000 });

      // Only the SSH ports are published: Jupyter listens on the host's loopback, inside its container.
      expect(publishedPorts().filter((p) => ![2222, 2223, 2224, 2225].includes(p))).toEqual([]);
    } finally {
      await endSessions(page).catch(() => undefined);
      await connector.dispose();
    }
  });
}
