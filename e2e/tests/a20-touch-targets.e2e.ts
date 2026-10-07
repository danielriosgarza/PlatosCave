import { expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light', hasTouch: true, isMobile: true });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { class: id(211), topic: id(311), nativeRevision: id(511), deckRevision: id(513) };
const topic = `/classes/${lab.class}/topics/${lab.topic}`;

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test.beforeEach(async ({ page }) => {
  const signedIn = await page.request.post('/api/test/signin-as', {
    data: { email: 'lab-reader@example.test' },
  });
  expect(signedIn.ok()).toBe(true);
});

/** Visible matches of `selector` whose box is under 44 px either way, named for the failure message. */
const small = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const box = node.getBoundingClientRect();
        const name =
          node.getAttribute('aria-label') ||
          node.textContent?.trim() ||
          node.getAttribute('name') ||
          node.tagName;
        return { name, box };
      })
      .filter(({ box }) => box.width > 0 && (box.height < 43.5 || box.width < 43.5))
      .map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`),
  );

test('A20 the slide viewer toolbar, slide index and picker are at least 44 px with a touch screen', async ({
  page,
}) => {
  await page.goto(`${topic}/slides`);
  await expect(page.locator('[data-page]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();
  expect(await small(page, 'main button, main select')).toEqual([]);
});

test('A20 the reading margin toolbar is at least 44 px with a touch screen', async ({ page }) => {
  await page.goto(`${topic}/reading?resource=${lab.nativeRevision}`);
  await expect(page.locator('[data-block-id]').first()).toBeVisible();
  await page.evaluate(() => {
    const block = document.querySelector('[data-block-id]');
    const text = block && document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) throw new Error('no text to select');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const tools = page.getByRole('toolbar', { name: 'Selected passage' });
  await expect(tools).toBeVisible();
  expect(await small(page, '[role="toolbar"] button')).toEqual([]);
});

test('A20 the review panel checkboxes and the notebook toolbar are at least 44 px with a touch screen', async ({
  page,
}) => {
  await page.goto(`${topic}/reading?resource=${lab.nativeRevision}`);
  const boxes = page.getByRole('checkbox');
  await expect(boxes.first()).toBeVisible();
  const rows = await boxes.evaluateAll((nodes) =>
    nodes.map((node) => {
      const row = (node.closest('label') ?? node).getBoundingClientRect();
      return Math.round(row.height);
    }),
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const height of rows) expect(height).toBeGreaterThanOrEqual(44);

  await page.goto(`${topic}/notebooks`);
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();
  expect(await small(page, 'main button, main select')).toEqual([]);
});
