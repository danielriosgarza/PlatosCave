import { expect, test } from '@playwright/test';
import { small } from '../../touch';
import { Connector } from './connector';
import {
  connect,
  endSessions,
  liveLocalNotebook,
  newConnection,
  openConnect,
  pairAndApprove,
  typeInCell,
} from './ui';

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
    await newConnection(page);
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

test('A27 and A20 the stdin prompt and the Files input of a live notebook are at least 44 px with a touch screen', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const connector = new Connector();
  try {
    await liveLocalNotebook(page, connector, 'A27 touch live laptop');
    const notebook = page.getByRole('article', { name: 'Live notebook' });
    await typeInCell(page, /^Code of cell 2/, "input('Your name? ')");
    await notebook.getByRole('button', { name: /^Run cell 2/ }).click();
    const prompt = notebook.getByRole('textbox', { name: 'Your name?' });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    const send = notebook.getByRole('button', { name: 'Send' });
    for (const control of [prompt, send]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await prompt.fill('Ada', { timeout: 10_000 });
    await send.click({ timeout: 10_000 });

    // The panel has no region name while the working copy loads; the field is the anchor.
    const name = page.getByLabel('File name in the workspace');
    await expect(name).toBeVisible({ timeout: 30_000 });
    expect((await name.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  } finally {
    await endSessions(page).catch(() => undefined);
    await connector.dispose();
  }
});
