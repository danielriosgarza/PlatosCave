import { expect, test } from '@playwright/test';
import { Connector, expectLoopbackOnly } from './connector';
import { connect, connectLocal, endSessions, openConnect, pairAndApprove } from './ui';

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test('A27 a student pairs a local connector and runs a cell', async ({ page }) => {
  test.setTimeout(180_000);
  const connector = new Connector();
  const name = 'A27 laptop';
  try {
    await openConnect(page);
    // The real Approve button, not the test route.
    await pairAndApprove(page, connector, name, 'button');
    const run = await connect(page, connector, name);

    await connectLocal(page, name, connector.workspace());
    // Ready is the kernel's word: the notebook goes live only once the kernel is idle.
    await expect(page.getByRole('status').filter({ hasText: 'Ready' })).toBeVisible({
      timeout: 90_000,
    });

    await page.getByRole('button', { name: 'Close' }).click();
    const notebook = page.getByRole('article', { name: 'Live notebook' });
    await expect(notebook).toBeVisible();
    const cell = notebook.getByRole('textbox', { name: /^Code of cell 2/ });
    await cell.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('print(2 + 2)');
    await notebook.getByRole('button', { name: /^Run cell 2/ }).click();
    await expect(notebook.getByText('4', { exact: true })).toBeVisible({ timeout: 60_000 });
    // The output returned to the same full-width notebook the stored outputs were in.
    await expect(page.getByRole('tablist', { name: 'Topic materials' })).toBeVisible();

    // The connector and the Jupyter server it started listen on loopback only.
    const pid = run.child.pid;
    expect(pid).toBeDefined();
    expectLoopbackOnly(pid as number);
  } finally {
    await endSessions(page).catch(() => undefined);
    await connector.dispose();
  }
});
