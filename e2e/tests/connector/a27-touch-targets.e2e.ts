import { expect, test } from '@playwright/test';
import { small } from '../../touch';
import { Connector } from './connector';
import {
  connect,
  connectLocal,
  endSessions,
  newConnection,
  openConnect,
  pairAndApprove,
} from './ui';

test.use({ hasTouch: true, isMobile: true });

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

// One test, one pairing: the server allows five pairing codes an hour per person, and the other
// connector scenarios spend the student's. This one runs as the instructor.
test('A27 and A20 the connect fields, the stdin prompt and the Files input are at least 44 px with a touch screen', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const connector = new Connector();
  const name = 'A27 touch laptop';
  try {
    await openConnect(page, 'instructor');
    await pairAndApprove(page, connector, name);
    await connect(page, connector, name);

    await page.getByRole('radio', { name: 'SSH host' }).check();
    await newConnection(page);
    await expect(page.getByLabel('Host', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Key file path')).toBeVisible();
    expect(
      await small(page, 'main input:not([type="radio"], [type="checkbox"]), main select'),
    ).toEqual([]);

    await connectLocal(page, name, connector.workspace());
    await expect(page.getByRole('status').filter({ hasText: 'Ready' })).toBeVisible({
      timeout: 90_000,
    });
    await page.getByRole('button', { name: 'Close' }).click();
    const notebook = page.getByRole('article', { name: 'Live notebook' });
    await expect(notebook).toBeVisible();

    await notebook.getByRole('textbox', { name: /^Code of cell 2/ }).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type("input('Your name? ')");
    await notebook.getByRole('button', { name: /^Run cell 2/ }).click();
    const prompt = notebook.getByRole('textbox', { name: 'Your name?' });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    const send = notebook.getByRole('button', { name: 'Send' });
    for (const control of [prompt, send]) {
      expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await prompt.fill('Ada', { timeout: 10_000 });
    await send.click({ timeout: 10_000 });

    // The panel has no region name while the working copy loads; the field is the anchor.
    const fileName = page.getByLabel('File name in the workspace');
    await expect(fileName).toBeVisible({ timeout: 30_000 });
    expect((await fileName.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  } finally {
    await endSessions(page).catch(() => undefined);
    await connector.dispose();
  }
});
