import { expect, test } from '@playwright/test';
import { Connector, fixtures, knownHosts, rotateHostKey, studentWorkspace } from './connector';
import {
  connect,
  endSessions,
  openConnect,
  pairAndApprove,
  stage,
  takeTestBudget,
  testSsh,
  trustUntilDone,
} from './ui';

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test('A30 a rotated host key stops the connection and keeps the trust record', async ({ page }) => {
  test.setTimeout(240_000);
  const connector = new Connector();
  const name = 'A30 laptop';
  try {
    await openConnect(page, 'instructor');
    await pairAndApprove(page, connector, name);
    await connect(page, connector, name);
    await testSsh(page, {
      name: `${name} notebook`,
      host: '127.0.0.1',
      port: fixtures.rotating,
      user: 'student',
      workspace: studentWorkspace,
    });
    await trustUntilDone(page);
    await expect(stage(page, 'host_identity')).toHaveAttribute('data-status', 'ok');
    const trusted = knownHosts(connector);
    expect(trusted).toContain(`[127.0.0.1]:${fixtures.rotating}`);

    rotateHostKey();
    await takeTestBudget(page);
    await page.getByRole('button', { name: 'Save and test connection' }).click();

    // The connection stops at the host key: nothing after it ran, and both keys are shown.
    await expect(stage(page, 'host_identity')).toHaveAttribute('data-status', 'failed', {
      timeout: 60_000,
    });
    await expect(stage(page, 'host_identity')).toContainText('differs from the one you trusted');
    await expect(page.getByText('Trusted key', { exact: true })).toBeVisible();
    await expect(page.getByText('Presented key', { exact: true })).toBeVisible();
    for (const later of ['ssh_auth', 'workspace', 'forwarding']) {
      await expect(stage(page, later)).toHaveAttribute('data-status', 'skipped');
    }
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
    // Replacing is offered only behind a confirmation, and nothing was replaced.
    await expect(page.getByRole('button', { name: 'Replace trusted key…' })).toBeVisible();
    expect(knownHosts(connector)).toBe(trusted);
  } finally {
    await endSessions(page).catch(() => undefined);
    await connector.dispose();
  }
});
