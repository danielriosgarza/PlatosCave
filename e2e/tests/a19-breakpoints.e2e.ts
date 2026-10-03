import { expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { class: id(211), topic: id(311), nativeRevision: id(511) };
const reading = `/classes/${lab.class}/topics/${lab.topic}/reading?resource=${lab.nativeRevision}`;

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

/** Left and right padding of the first element matched, in px. */
const sidePadding = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const style = getComputedStyle(el);
    return [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)];
  });

const columns = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) =>
    getComputedStyle(el)
      .gridTemplateColumns.split(' ')
      .map((track) => parseFloat(track)),
  );

// DESIGN.md "Smaller screens": 1199 / 800 / 540, the wireframe's breakpoints.
const widths = [
  { width: 1100, side: 32, notes: 'beside', cards: 3 },
  { width: 850, side: 32, notes: 'beside', cards: 3 },
  { width: 800, side: 24, notes: 'below', cards: 2 },
  { width: 540, side: 16, notes: 'below', cards: 1 },
];

for (const { width, side, notes, cards } of widths) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`A19 reading at ${width} px has ${side} px side padding and notes ${notes} the text`, async ({
      page,
    }) => {
      await page.goto(reading);
      await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();
      expect(await sidePadding(page, 'header:has(h1)')).toEqual([side, side]);
      const aside = page.getByRole('complementary', { name: 'Notes and discussion' });
      await expect(aside).toBeVisible();
      const text = page.locator('[data-block-id]').first();
      const [textBox, asideBox] = [await text.boundingBox(), await aside.boundingBox()];
      if (!textBox || !asideBox) throw new Error('no layout');
      if (notes === 'beside') {
        expect(asideBox.x).toBeGreaterThan(textBox.x + textBox.width - 1);
        expect(Math.round(asideBox.width)).toBe(260);
      } else {
        expect(asideBox.y).toBeGreaterThan(textBox.y + textBox.height - 1);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    });

    test(`A04 course cards at ${width} px use ${cards} column(s)`, async ({ page }) => {
      await page.goto('/courses?view=student');
      await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
      const grid = await page.evaluate(() => {
        const found = [...document.querySelectorAll('main *')].find(
          (el) => getComputedStyle(el).display === 'grid',
        );
        if (!found) return null;
        found.setAttribute('data-test-grid', '');
        return true;
      });
      expect(grid).toBe(true);
      expect(await columns(page, '[data-test-grid]')).toHaveLength(cards);
    });
  });
}
