import { expect, test } from '@playwright/test';
import { Connector, fixtures } from './connector';
import { connect, openConnect, pairAndApprove, stage, testSsh, trustUntilDone } from './ui';

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

async function failingTarget(
  page: import('@playwright/test').Page,
  name: string,
  user: string,
  port: number,
): Promise<Connector> {
  const connector = new Connector();
  await openConnect(page);
  await pairAndApprove(page, connector, name);
  await connect(page, connector, name);
  await testSsh(page, { name: `${name} notebook`, host: '127.0.0.1', port, user, workspace: `/home/${user}/work` });
  await trustUntilDone(page);
  return connector;
}

const notReady = (page: import('@playwright/test').Page) =>
  expect(page.getByRole('status').filter({ hasText: 'Ready' })).toHaveCount(0);

test('A29 forwarding forbidden names its stage and never reaches Ready', async ({ page }) => {
  test.setTimeout(180_000);
  const connector = await failingTarget(page, 'A29 forwarding', 'student', fixtures.noForwarding);
  try {
    await expect(stage(page, 'forwarding')).toHaveAttribute('data-status', 'failed');
    await expect(stage(page, 'forwarding')).toContainText('The SSH server forbids port forwarding for this account.');
    // The stages before it passed; the ones after it did not run.
    await expect(stage(page, 'workspace')).toHaveAttribute('data-status', 'ok');
    await expect(stage(page, 'runtime')).toHaveAttribute('data-status', 'skipped');
    await expect(page.getByRole('button', { name: 'Test again' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
    await notReady(page);
  } finally {
    await connector.dispose();
  }
});

test('A29 Jupyter missing names its stage and never reaches Ready', async ({ page }) => {
  test.setTimeout(180_000);
  const connector = await failingTarget(page, 'A29 missing', 'bare', fixtures.direct);
  try {
    await expect(stage(page, 'runtime')).toHaveAttribute('data-status', 'failed');
    await expect(stage(page, 'runtime')).toContainText('Jupyter Server is not installed in that environment.');
    await expect(stage(page, 'forwarding')).toHaveAttribute('data-status', 'ok');
    await expect(stage(page, 'kernels')).toHaveAttribute('data-status', 'skipped');
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
    await notReady(page);
  } finally {
    await connector.dispose();
  }
});

test('A29 a token the server rejects names its stage and never reaches Ready', async ({ page }) => {
  test.setTimeout(240_000);
  const connector = await failingTarget(page, 'A29 token', 'locked', fixtures.direct);
  try {
    // Test connection starts nothing, so every stage before the server passes...
    await expect(stage(page, 'ssh_auth')).toHaveAttribute('data-status', 'ok');
    await expect(stage(page, 'runtime')).toHaveAttribute('data-status', 'ok');
    // ...and Connect, which starts the server, stops at its token.
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: "Jupyter rejected the connector's token." })).toBeVisible({
      timeout: 120_000,
    });
    await notReady(page);
  } finally {
    await connector.dispose();
  }
});
