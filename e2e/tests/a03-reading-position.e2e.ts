import { expect, type Page, test } from '@playwright/test';
import { joinLabClassAs } from './lab-classmate';

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
type Place = { blockId: string; offset: number } | { page: number; offset: number };

/** Waits until the server holds exactly `expected` for the revision. */
const placeSaved = async (page: Page, revisionId: string, expected: Place) => {
  await expect
    .poll(
      async () => {
        const list = await page.request.get(
          `/api/classes/${lab.class}/topics/${lab.topic}/readings`,
        );
        const { readings } = (await list.json()) as {
          readings: { revisionId: string; position: Record<string, unknown> | null }[];
        };
        return readings.find((r) => r.revisionId === revisionId)?.position ?? null;
      },
      { timeout: 10_000 },
    )
    .toEqual(expected);
};

/** The place the address names for a native reading, once the reader's scroll has written it. */
const nativePlaceInAddress = async (page: Page): Promise<Place> => {
  await expect.poll(() => new URL(page.url()).searchParams.get('block')).toMatch(/^b:/);
  const shown = new URL(page.url()).searchParams;
  return {
    blockId: (shown.get('block') ?? '').replace(/^b:/, ''),
    offset: Number(shown.get('offset') ?? '0'),
  };
};

test('A03 a native reading returns to the scrolled place after another tab and after a reload', async ({
  page,
}) => {
  await page.goto(`${reading}?resource=${lab.nativeRevision}`);
  await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();

  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(2000);
  await placeSaved(page, lab.nativeRevision, await nativePlaceInAddress(page));
  const placed = await scrollTop(page);

  // A real click: the tab row is above the reading, and reaching it must not move the place.
  await page.getByRole('tab', { name: 'Slides' }).click();
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
  await placeSaved(page, lab.pdfRevision, { page: 3, offset: 0 });

  // A real click: the tab row is above the reading, and reaching it must not move the place.
  await page.getByRole('tab', { name: 'Slides' }).click();
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

test('A03 one student goes Courses → Topics → Reading → Slides → Reading, writes a note, reloads and finds the place and the note', async ({
  page,
  playwright,
  baseURL,
}) => {
  // A student of their own: places and notes are per person, and the other tests of this class
  // reset or delete them on the shared reader.
  const unique = `${Date.now()}-${test.info().workerIndex}-${test.info().retry}`;
  await joinLabClassAs(playwright, baseURL, page.request, `walker-${unique}@example.test`);

  await page.goto('/courses');
  await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
  await page.getByRole('link', { name: 'Topics' }).click();
  await expect(page).toHaveURL(new RegExp(`/classes/${lab.class}/topics$`));
  await expect(page.getByRole('heading', { name: 'Reading lab' })).toBeVisible();
  // Nothing is saved yet, so the row offers Start; it opens the topic's first tab (Slides).
  await page.getByRole('link', { name: 'Start' }).click();
  await expect(page).toHaveURL(new RegExp(`/classes/${lab.class}/topics/${lab.topic}/slides`));
  await page.getByRole('tab', { name: 'Reading' }).click();
  await expect(page).toHaveURL(/\/reading/);
  await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();

  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(2000);
  const saved = await nativePlaceInAddress(page);
  await placeSaved(page, lab.nativeRevision, saved);
  const placed = await scrollTop(page);

  await page.getByRole('tab', { name: 'Slides' }).click();
  await expect(page).toHaveURL(/\/slides/);
  await page.getByRole('tab', { name: 'Reading' }).click();
  await expect(page).toHaveURL(/\/reading/);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(placed - 100);
  expect(Math.abs((await scrollTop(page)) - placed)).toBeLessThan(100);

  // A note on the first paragraph in view, so writing it does not move the place.
  const label = await page.evaluate(() => {
    const block = [...document.querySelectorAll('[data-block-id]')].find((b) => {
      const top = b.getBoundingClientRect().top;
      return /^Paragraph \d+\./.test(b.textContent ?? '') && top >= 0 && top < innerHeight - 200;
    });
    const text = block && document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
    const label = /^Paragraph \d+/.exec(text?.textContent ?? '')?.[0];
    if (!text || !label) throw new Error('no paragraph in view');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, label.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return label;
  });
  const note = `Walked path note ${unique}`;
  await page
    .getByRole('toolbar', { name: 'Selected passage' })
    .getByRole('button', { name: 'Note' })
    .click();
  await page.getByRole('textbox', { name: 'Your note' }).fill(note);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({
    timeout: 10_000,
  });
  // The editor may bring the note into view; the place to come back to is where the page rests.
  let resting = await scrollTop(page);
  await expect
    .poll(async () => {
      const now = await scrollTop(page);
      const settled = now === resting;
      resting = now;
      return settled;
    })
    .toBe(true);
  await placeSaved(page, lab.nativeRevision, await nativePlaceInAddress(page));
  const placed2 = await scrollTop(page);

  await page.reload();
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(placed2 - 150);
  expect(Math.abs((await scrollTop(page)) - placed2)).toBeLessThan(150);
  await expect(page.locator('mark[data-marks]').first()).toHaveText(label);
  await expect(page.getByText(note)).toBeVisible();

  // Coming back through Courses → Topics, the row now says Resume and lands on the same place.
  await page.goto('/courses');
  await page.getByRole('link', { name: 'Topics' }).click();
  await page.getByRole('link', { name: 'Resume' }).click();
  await expect(page).toHaveURL(/\/reading/);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(placed2 - 150);
  expect(Math.abs((await scrollTop(page)) - placed2)).toBeLessThan(150);
  await expect(page.locator('mark[data-marks]').first()).toHaveText(label);
});
