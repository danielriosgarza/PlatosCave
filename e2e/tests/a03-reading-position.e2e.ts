import { expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = {
  class: id(211),
  topic: id(311),
  nativeRevision: id(511),
  pdfRevision: id(512),
};
const reading = `/classes/${lab.class}/topics/${lab.topic}/reading`;

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test.beforeEach(async ({ page }) => {
  const signedIn = await page.request.post('/api/test/signin-as', {
    data: { email: 'lab-reader@example.test' },
  });
  expect(signedIn.ok()).toBe(true);

  // The database is shared by every attempt of a run, so a retry would otherwise open on the
  // place the failed attempt saved: start each attempt from the top of both readings.
  const put = (position: object, revisionId: string) =>
    page.request.put(`/api/classes/${lab.class}/positions`, {
      data: { revisionId, tab: 'reading', position },
    });
  const content = await page.request.get(
    `/api/classes/${lab.class}/resources/${lab.nativeRevision}/reading`,
  );
  const firstBlock = /data-block-id="([^"]+)"/.exec((await content.json()).html)?.[1];
  expect(firstBlock).toBeDefined();
  expect((await put({ blockId: firstBlock, offset: 0 }, lab.nativeRevision)).ok()).toBe(true);
  expect((await put({ page: 1, offset: 0 }, lab.pdfRevision)).ok()).toBe(true);
});

const scrollTop = (page: Page) => page.evaluate(() => Math.round(window.scrollY));
/**
 * Waits until the server holds the place the address names: the reader writes both together, so
 * once they agree the last move has been saved (an earlier save, or one still in flight, differs).
 */
const placeSaved = async (page: Page, revisionId: string) => {
  await expect
    .poll(
      async () => {
        const shown = new URL(page.url()).searchParams;
        const list = await page.request.get(
          `/api/classes/${lab.class}/topics/${lab.topic}/readings`,
        );
        const { readings } = (await list.json()) as {
          readings: { revisionId: string; position: Record<string, unknown> | null }[];
        };
        const saved = readings.find((r) => r.revisionId === revisionId)?.position;
        if (!saved) return false;
        const block = shown.get('block')?.replace(/^b:/, '');
        const pageNumber = shown.get('page');
        const same =
          block !== undefined && block !== null
            ? saved.blockId === block
            : pageNumber !== null && saved.page === Number(pageNumber);
        return same && String(saved.offset) === (shown.get('offset') ?? '0');
      },
      { timeout: 10_000 },
    )
    .toBe(true);
};

test('A03 a native reading returns to the scrolled place after another tab and after a reload', async ({
  page,
}) => {
  await page.goto(`${reading}?resource=${lab.nativeRevision}`);
  await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();

  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(2000);
  await expect
    .poll(async () => {
      const before = await scrollTop(page);
      await page.waitForTimeout(400);
      return (await scrollTop(page)) === before;
    })
    .toBe(true);
  await placeSaved(page, lab.nativeRevision);
  const placed = await scrollTop(page);

  // Dispatched, not clicked: a click first scrolls the page up to the tab row, which would make
  // the top of the page the reader's place. This leaves from where the reader is.
  await page.getByRole('tab', { name: 'Slides' }).dispatchEvent('click');
  await expect(page).toHaveURL(/\/slides/);
  await page.getByRole('tab', { name: 'Reading' }).click();
  await expect(page).toHaveURL(/\/reading/);
  await expect(page.getByText('Paragraph', { exact: false }).first()).toBeVisible();
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(placed - 100);
  expect(Math.abs((await scrollTop(page)) - placed)).toBeLessThan(100);

  // A reload returns to the place the address names.
  await page.reload();
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(placed - 100);
  expect(Math.abs((await scrollTop(page)) - placed)).toBeLessThan(100);

  // A fresh visit without any place in the address: the server's saved position restores it.
  await page.goto(reading);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(placed - 100);
  expect(Math.abs((await scrollTop(page)) - placed)).toBeLessThan(100);
});

test('A03 a PDF reading returns to its page after another tab and after a reload, with a text layer', async ({
  page,
}) => {
  await page.goto(`${reading}?resource=${lab.pdfRevision}`);
  const indicator = page.getByText(/Page \d+ of 4/);
  await expect(indicator).toHaveText('Page 1 of 4');
  await expect(page.locator('.textLayer')).toContainText('Sampling paper page 1');

  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(indicator).toHaveText('Page 3 of 4');
  await expect(page.locator('.textLayer')).toContainText('Sampling paper page 3');
  await placeSaved(page, lab.pdfRevision);

  // Dispatched, not clicked: a click first scrolls the page up to the tab row, which would make
  // the top of the page the reader's place. This leaves from where the reader is.
  await page.getByRole('tab', { name: 'Slides' }).dispatchEvent('click');
  await expect(page).toHaveURL(/\/slides/);
  await page.getByRole('tab', { name: 'Reading' }).click();
  await expect(page.getByText(/Page \d+ of 4/)).toHaveText('Page 3 of 4');

  await page.reload();
  await expect(page.getByText(/Page \d+ of 4/)).toHaveText('Page 3 of 4');
  await page.goto(reading);
  await expect(page.getByRole('combobox', { name: 'Reading' })).toHaveValue(lab.pdfRevision);
  await expect(page.getByText(/Page \d+ of 4/)).toHaveText('Page 3 of 4');
  await expect(page.locator('.textLayer')).toContainText('Sampling paper page 3');
});
