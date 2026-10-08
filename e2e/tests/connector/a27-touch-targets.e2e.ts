import { expect, test } from '@playwright/test';
import { small } from '../../touch';
import { Connector } from './connector';
import { connect, endSessions, openConnect, pairAndApprove } from './ui';

test.use({ hasTouch: true, isMobile: true });

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test('A27 and A20 the connect panel fields of an SSH host are at least 44 px with a touch screen', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const connector = new Connector();
  const name = 'A27 touch laptop';
  try {
    await openConnect(page, 'reader', { studentOnly: true });
    await pairAndApprove(page, connector, name);
    await connect(page, connector, name);
    await page.getByRole('radio', { name: 'SSH host' }).check();
    const saved = page.getByLabel('Saved connection');
    if (await saved.count()) await saved.selectOption('new');
    await expect(page.getByLabel('Host', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Key file path')).toBeVisible();
    expect(
      await small(page, 'main input:not([type="radio"], [type="checkbox"]), main select'),
    ).toEqual([]);
  } finally {
    await endSessions(page).catch(() => undefined);
    await connector.dispose();
  }
});
