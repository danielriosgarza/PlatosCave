import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { BUILD, CONTENT, DIST, SITE } from '../static-server';

// The school fixture, built by static-server.ts with `parallax build` and served on two hosts.
const reef = '/courses/ana/reef-ecology';
const sampling = `${reef}/5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33`;
const SHINY = 'https://shiny.example.org';
const notebookFile = () => {
  const file = `${sampling}/9d8c7b6a-5f4e-4d3c-a2b1-0f9e8d7c6b5a.json`;
  return JSON.parse(readFileSync(join(DIST, 'site', file), 'utf8')).file as string;
};

/** Every request of the page; the listed Shiny origin is answered here, so no other host is asked. */
async function watched(page: Page) {
  const requests: string[] = [];
  const statuses: number[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('response', (r) => r.url().endsWith('.pdf') && statuses.push(r.status()));
  await page.route(`${SHINY}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Tide</title><p>Tide</p>',
    }),
  );
  return { requests, statuses };
}

/**
 * A screen: no sign-in, provider, join or notes control, and axe passes on the page. Its frames are
 * documents of other origins (an output, a Shiny app), which axe does not enter: in one run in the
 * page, which a sandboxed frame cannot stall.
 */
async function screen(page: Page, shown: Locator) {
  await expect(shown).toBeVisible();
  const kept = /sign in|continue with|provider|join|notes/i;
  await expect(page.getByRole('button', { name: kept })).toHaveCount(0);
  await expect(page.getByRole('link', { name: kept })).toHaveCount(0);
  // A display formula's box scrolls and is no tab stop: the reading viewer's own, left to P5-25.
  const axe = new AxeBuilder({ page }).setLegacyMode(true).options({ iframes: false });
  const { violations } = await axe.exclude('.math-display').analyze();
  expect(violations).toEqual([]);
}

/** The walk from the front page to every tab of a topic, by mouse or by keyboard. */
async function walk(page: Page, keys: boolean) {
  const go = async (target: Locator) => {
    if (!keys) return target.click();
    await target.focus();
    await page.keyboard.press('Enter');
  };
  const panel = page.getByRole('tabpanel');
  const pick = (label: string, option: string) =>
    page.getByRole('combobox', { name: label }).selectOption({ label: option });
  await page.goto('/');
  await screen(page, page.getByRole('heading', { name: 'Example School of Marine Biology' }));
  await go(page.getByRole('link', { name: 'Open the courses' }));
  // The catalogue: instructors, then their courses.
  await screen(page, page.getByRole('heading', { name: 'Courses', level: 1 }));
  const named = page.getByRole('heading', { level: 2 });
  await expect(named).toHaveText(['Ana Lima', 'Bao Tran']);
  await expect(page.getByRole('region', { name: 'Bao Tran' }).getByRole('link')).toHaveText(
    'Tide pools',
  );
  await go(page.getByRole('link', { name: 'Reef ecology' }));
  await screen(page, page.getByText('Open to everyone · Ana Lima'));
  await go(page.getByRole('link', { name: 'Sampling a reef' }));
  // Slides: a web deck, then a PDF deck read in ranges from the content host.
  await screen(
    page,
    page.getByRole('region', { name: 'Slide viewer' }).getByRole('heading', { name: 'Transects' }),
  );
  await pick('Slides', 'Reef zones');
  await screen(page, page.getByRole('region', { name: 'Slide viewer' }).getByText('Reef crest'));
  await go(page.getByRole('tab', { name: 'Reading' }));
  await screen(page, panel.getByRole('heading', { name: 'Survey methods' }));
  await expect(panel.locator('.katex').first()).toBeVisible();
  await pick('Reading', 'Counting fish along a transect');
  await screen(page, panel.getByText('Counting fish along a transect'));
  await go(page.getByRole('tab', { name: 'Notebooks' }));
  await screen(page, panel.getByText('Stored output · Python 3').first());
  await expect(page.getByText('Saved outputs')).toBeVisible();
  // Its three images (an attachment, a PNG and an SVG output), each loaded from the content host.
  const images = () =>
    panel
      .locator('img')
      .evaluateAll((all: HTMLImageElement[]) =>
        all.map((img) => [new URL(img.src).origin, img.complete && img.naturalWidth > 0]),
      );
  await expect.poll(images).toEqual(Array(3).fill([CONTENT, true]));
  const colab = page.getByRole('region', { name: 'Work in Colab' });
  await expect(colab.getByRole('link', { name: 'Open in Colab' })).toBeVisible();
  const download = colab.getByRole('link', { name: 'Download notebook without outputs' });
  await expect(download).toHaveAttribute('href', notebookFile());
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await pick('Notebook', 'Tide explorer');
  await screen(page, panel.locator(`iframe[src="${SHINY}/tide/"]`));
  await pick('Notebook', 'Current explorer');
  await screen(page, panel.getByText('Not embedded on this site'));
  const external = panel.getByRole('link', { name: 'Open externally' });
  await expect(external).toHaveAttribute('href', 'https://apps.example.net/currents/');
  await expect(panel.locator('iframe')).toHaveCount(0);
  for (const [tab, sentence, title] of [
    ['Exercises', 'Exercises are done in a class.', 'Estimate a density'],
    ['Tests', 'Tests are taken in a class.', 'Sampling quiz'],
  ] as const) {
    await go(page.getByRole('tab', { name: tab }));
    await screen(page, panel.getByText(sentence));
    await expect(panel.getByRole('listitem')).toHaveText([title]);
  }
  // The topic that has only an exercise and a test is listed and opens on Exercises.
  await go(page.getByRole('link', { name: 'Courses', exact: true }));
  await go(page.getByRole('link', { name: 'Tide pools' }));
  await screen(page, page.getByRole('link', { name: 'Practice' }));
  await go(page.getByRole('link', { name: 'Practice' }));
  await screen(page, panel.getByText('Exercises are done in a class.'));
  await expect(page.getByRole('tab', { name: 'Exercises' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(panel.getByRole('listitem')).toHaveText(['Sort the dwellers']);
}

test('A44 a level 0 site shows slides, readings and rendered notebooks with no request to /api and no sign-in', async ({
  page,
}) => {
  const build = JSON.parse(readFileSync(BUILD, 'utf8'));
  expect(build.status).toBe(0);
  expect(build.stdout).toContain(
    'warning: instructors/ana/courses/reef-ecology/sampling/notebooks/currents.shiny.yaml: “Current explorer” is not on an approved Shiny origin',
  );
  const { requests, statuses } = await watched(page);
  await walk(page, false);
  // Kept nothing in the browser.
  const kept = await page.evaluate(async () => [
    localStorage.length,
    sessionStorage.length,
    (await indexedDB.databases()).length,
    document.cookie,
  ]);
  expect(kept).toEqual([0, 0, 0, '']);
  // The deck's PDF arrived in ranges; every request went to the two hosts or the listed app.
  expect(statuses).toContain(206);
  const hosts = new Set(requests.map((url) => new URL(url).origin));
  expect([...hosts].sort()).toEqual([SITE, CONTENT, SHINY].sort());
  expect(requests.filter((url) => new URL(url).pathname.startsWith('/api'))).toEqual([]);
  // At a narrow viewport and by keyboard as well.
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page, true);
});

test('A44 a link straight to a topic loads from plain files', async ({ page, request }) => {
  // The build wrote a copy of the shell's index.html at every address, and at no other.
  const site = join(DIST, 'site');
  const shell = readFileSync(join(site, 'index.html'));
  for (const page of ['about', 'team', 'courses', 'courses/bao/tide-pools'])
    expect(readFileSync(join(site, page, 'index.html')).equals(shell)).toBe(true);
  expect((await request.get(`${SITE}/courses/ana`)).status()).toBe(404);
  expect((await request.get(`${SITE}${sampling}/history`)).status()).toBe(404);
  expect((await request.get(`${SITE}/api/health`)).status()).toBe(404);
  // A reading's address, which only …/reading/index.html answers, and the same after a reload.
  const paper = `${sampling}/reading?resource=0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f`;
  for (const load of [() => page.goto(paper), () => page.reload()]) {
    const response = await load();
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('combobox', { name: 'Reading' })).toHaveValue(
      '0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f',
    );
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
  }
  // The notebook file offered for download is on the content host, without outputs: a static
  // host sends no Content-Disposition, so the browser shows it, from where a visitor saves it.
  await page.goto(notebookFile());
  const notebook = JSON.parse((await page.locator('body').textContent()) ?? '');
  const code = notebook.cells.filter((cell: { cell_type: string }) => cell.cell_type === 'code');
  expect([
    notebook.nbformat,
    code.length,
    code.flatMap((cell: { outputs: [] }) => cell.outputs),
  ]).toEqual([4, 3, []]);
});
