import { expect, test } from '@playwright/test';

test.use({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { class: id(211), topic: id(311), notebookRevision: id(514) };
const notebooks = `/classes/${lab.class}/topics/${lab.topic}/notebooks`;

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

test('A09 a notebook shows its stored outputs, labelled as stored, with no live state claimed', async ({
  page,
}) => {
  await page.goto(notebooks);
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('heading', { name: 'Repeated samples, in code' })).toBeVisible();
  await expect(panel.locator('math').first()).toBeAttached();
  await expect(panel.getByText('[1]')).toBeVisible();
  await expect(panel.getByText('0.60', { exact: true })).toBeVisible();
  await expect(panel.getByText('Stored output · Python 3')).toHaveCount(2);
  await expect(page.getByText('Saved outputs')).toBeVisible();
  await expect(page.getByText(/Connected|Running/)).toHaveCount(0);
  const image = panel.getByRole('img', { name: 'Histogram of means' });
  await expect(image).toBeVisible();
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  // Outline jumps to a heading; Focus keeps the notebook and hides the topic chrome.
  await page.getByRole('button', { name: 'Outline' }).click();
  await panel
    .getByRole('navigation', { name: 'Notebook outline' })
    .getByRole('button', { name: 'Try a larger sample' })
    .click();
  await expect(panel.getByRole('heading', { name: 'Try a larger sample' })).toBeInViewport();
  await page.getByRole('button', { name: 'Focus' }).click();
  await expect(page.getByRole('tablist', { name: 'Topic materials' })).toBeHidden();
  await expect(panel.getByText('0.60', { exact: true })).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tablist', { name: 'Topic materials' })).toBeVisible();
});

test('A09 HTML outputs run no script: sandboxed frames on the content origin, even if a script was stored', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const seen: unknown[] = [];
    (window as unknown as { notebookMessages: unknown[] }).notebookMessages = seen;
    window.addEventListener('message', (e) => seen.push(e.data));
  });
  const frames: { url: string; csp: string }[] = [];
  page.on('response', (res) => {
    if (res.request().resourceType() === 'document' && res.url().includes('/content/')) {
      frames.push({ url: res.url(), csp: res.headers()['content-security-policy'] ?? '' });
    }
  });
  await page.goto(notebooks);
  const panel = page.getByRole('tabpanel');
  const outputs = panel.locator('iframe');
  await expect(outputs).toHaveCount(2);
  for (const frame of await outputs.all()) {
    await expect(frame).toHaveAttribute('sandbox', '');
    expect(new URL((await frame.getAttribute('src')) ?? '').origin).not.toBe(
      new URL(page.url()).origin,
    );
  }
  // The sanitised output, and one stored with its script intact: neither ran.
  await expect(page.frameLocator('iframe >> nth=0').locator('#state')).toHaveText(
    'Chart without script',
  );
  await expect(page.frameLocator('iframe >> nth=1').locator('#state')).toHaveText(
    'Script did not run',
  );
  await expect(panel.getByText('Scripts in this output were removed and not run')).toBeVisible();
  expect(frames).toHaveLength(2);
  for (const { csp } of frames) {
    expect(csp.split(';')[0]).toBe('sandbox');
    expect(csp).not.toContain('allow-scripts');
  }
  expect(
    await page.evaluate(
      () => (window as unknown as { notebookMessages: unknown[] }).notebookMessages,
    ),
  ).toEqual([]);
});

test('A09 the notebook source downloads as the .ipynb file', async ({ page }) => {
  await page.goto(notebooks);
  await expect(page.getByText('Stored output · Python 3').first()).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('Repeated samples.ipynb');
});
