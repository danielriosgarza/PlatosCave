import { expect, test } from '@playwright/test';
import { Connector } from './connector';
import { labClass as classId, endSessions, liveLocalNotebook, typeInCell } from './ui';

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test('A31 offline then online runs the cell once', async ({ page, context }) => {
  test.setTimeout(240_000);
  const connector = new Connector();
  try {
    await liveLocalNotebook(page, connector, 'A31 laptop');
    const notebook = page.getByRole('article', { name: 'Live notebook' });

    // The chart cell was stored with execution count 2, so a count of 1 can only come from this run.
    await typeInCell(page, /^Code of cell 3 \[2\]/, "import time; time.sleep(8); print('slept')");
    await notebook.getByRole('button', { name: /^Run cell 3/ }).click();
    // The kernel is running this cell now: the drop below lands in the middle of an execution.
    const cell = notebook.getByRole('region', { name: /^Code cell 3/ });
    await expect(cell.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 });

    // The browser loses its connection, comes back, and the connector's link drops and returns.
    await context.setOffline(true);
    await expect(page.getByText('This browser is offline.')).toBeVisible({ timeout: 30_000 });
    await context.setOffline(false);
    const sessions = (await (
      await page.request.get(`/api/classes/${classId}/notebook-sessions`)
    ).json()) as {
      id: string;
      connectorId: string;
      state: string;
    }[];
    const session = sessions.find((s) => s.state === 'ready');
    expect(session, 'an open session').toBeTruthy();
    const dropped = await page.request.post(
      `/api/test/connectors/${session?.connectorId}/drop-link`,
    );
    expect(dropped.ok()).toBe(true);

    // The output arrives once, and the kernel's counter says the cell ran once.
    await expect(notebook.getByText('slept', { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(notebook.getByRole('region', { name: /^Code cell 3 \[1\]/ })).toBeVisible();
    const executions = (await (
      await page.request.get(`/api/classes/${classId}/notebook-sessions/${session?.id}/executions`)
    ).json()) as { executions: { state: string }[] };
    expect(executions.executions).toHaveLength(1);
  } finally {
    await endSessions(page).catch(() => undefined);
    await connector.dispose();
  }
});
