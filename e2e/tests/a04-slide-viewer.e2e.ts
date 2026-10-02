import { expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { class: id(211), topic: id(311), deckRevision: id(513) };
const slides = `/classes/${lab.class}/topics/${lab.topic}/slides`;

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test.beforeEach(async ({ page }) => {
  const signedIn = await page.request.post('/api/test/signin-as', {
    data: { email: 'lab-reader@example.test' },
  });
  expect(signedIn.ok()).toBe(true);
  // The database is shared by every attempt of a run: start each from the first slide.
  const reset = await page.request.put(`/api/classes/${lab.class}/positions`, {
    data: { revisionId: lab.deckRevision, tab: 'slides', position: { page: 1, offset: 0 } },
  });
  expect(reset.ok()).toBe(true);
});

const count = (page: Page) => page.getByText(/^\d+ \/ 6$/);
const slide = (page: Page) => page.getByLabel(/^Slide \d+ of 6$/).first();

/** The slide's box once drawn, and the stage's: the canvas is sized only when pdf.js has drawn. */
async function boxes(page: Page) {
  await expect(page.locator('[data-page]')).toBeVisible();
  const canvas = await slide(page).boundingBox();
  const mat = await page.locator('[data-slide-stage]').boundingBox();
  if (!canvas || !mat) throw new Error('the slide has no box');
  return { canvas, mat };
}

test('A04 the whole slide fits the stage at 1440 x 900, Focus enlarges it and Escape restores it', async ({
  page,
}) => {
  await page.goto(slides);
  await expect(count(page)).toHaveText('1 / 6');
  await expect(page.locator('.textLayer')).toContainText('Sampling slide 1');

  const normal = await boxes(page);
  // Source ratio, no distortion; the whole slide inside the window, controls included.
  expect(normal.canvas.width / normal.canvas.height).toBeCloseTo(16 / 9, 1);
  expect(normal.canvas.width).toBeGreaterThan(900);
  expect(normal.canvas.width).toBeLessThan(1000);
  expect(normal.canvas.x).toBeGreaterThanOrEqual(normal.mat.x);
  expect(normal.canvas.x + normal.canvas.width).toBeLessThanOrEqual(
    normal.mat.x + normal.mat.width + 1,
  );
  expect(normal.canvas.y + normal.canvas.height).toBeLessThanOrEqual(900);
  await expect(page.getByRole('button', { name: 'Next' })).toBeInViewport();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(count(page)).toHaveText('2 / 6');
  await expect(page.locator('.textLayer')).toContainText('Sampling slide 2');

  await page.getByRole('button', { name: 'Focus' }).click();
  await expect(page.getByRole('tablist', { name: 'Topic materials' })).toBeHidden();
  await expect
    .poll(async () => (await boxes(page)).canvas.width)
    .toBeGreaterThan(normal.canvas.width + 200);
  const focused = await boxes(page);
  expect(focused.canvas.width / focused.canvas.height).toBeCloseTo(16 / 9, 1);
  expect(focused.canvas.y + focused.canvas.height).toBeLessThanOrEqual(900);
  await expect(count(page)).toHaveText('2 / 6');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('tablist', { name: 'Topic materials' })).toBeVisible();
  await expect(count(page)).toHaveText('2 / 6');
  await expect
    .poll(async () => Math.round((await boxes(page)).canvas.width))
    .toBe(Math.round(normal.canvas.width));
});

test('A24 repeated arrow presses advance a focused viewer, which is remembered and read in ranges', async ({
  page,
}) => {
  const requests: { range: string | undefined; status: number }[] = [];
  page.on('response', (res) => {
    if (!res.url().includes('/content/') || res.request().method() !== 'GET') return;
    requests.push({ range: res.request().headers().range, status: res.status() });
  });
  // Bytes that arrived for content requests, whether or not the request finished.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const contentRequests = new Set<string>();
  let received = 0;
  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.request.url.includes('/content/')) contentRequests.add(e.requestId);
  });
  cdp.on('Network.dataReceived', (e) => {
    if (contentRequests.has(e.requestId)) received += e.dataLength;
  });
  await page.goto(slides);
  await expect(count(page)).toHaveText('1 / 6');
  const stage = page.getByRole('region', { name: 'Slide viewer' });
  await stage.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(count(page)).toHaveText('4 / 6');
  await expect(stage).toBeFocused();
  await expect(page.locator('.textLayer')).toContainText('Sampling slide 4');
  await page.keyboard.press('ArrowLeft');
  await expect(count(page)).toHaveText('3 / 6');

  // The deck is 302 kB. pdf.js's first request has no range and is dropped at once; the rest
  // are ranges answered 206. Together they stay well below the whole file.
  expect(requests.some((r) => r.range !== undefined)).toBe(true);
  for (const request of requests.filter((r) => r.range !== undefined)) {
    expect(request.range).toMatch(/^bytes=\d+-\d+$/);
    expect(request.status).toBe(206);
  }
  expect(received).toBeGreaterThan(0);
  expect(received).toBeLessThan(302_028);

  // The last slide survives a reload.
  await expect
    .poll(async () => {
      const list = await page.request.get(`/api/classes/${lab.class}/topics/${lab.topic}/slides`);
      const { decks } = (await list.json()) as {
        decks: { revisionId: string; position: { page: number } | null }[];
      };
      return decks.find((d) => d.revisionId === lab.deckRevision)?.position?.page;
    })
    .toBe(3);
  await page.reload();
  await expect(count(page)).toHaveText('3 / 6');
  await expect(page.locator('.textLayer')).toContainText('Sampling slide 3');
});
