import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { CONTENT, DIST, lookup, ROOT, SITE } from '../static-server';

// The school fixture, built by static-server.ts with `parallax build` and served on two hosts.
const sampling = '/courses/ana/reef-ecology/5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33';
const data = {
  notebook: `${sampling}/9d8c7b6a-5f4e-4d3c-a2b1-0f9e8d7c6b5a.json`,
  reading: `${sampling}/2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e.json`,
  deck: `${sampling}/c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f.json`,
};
// biome-ignore lint/suspicious/noExplicitAny: the JSON of a data file, which the tests alter
type Json = Record<string, any>;
/** A response of the page: its address, resource type, media type, and whether a frame asked. */
type Seen = { url: string; type: string; mime: string; frame: boolean };

/**
 * A disposable copy of the built `site/`, whose data files the page's site host answers from now
 * on. Its documents still come from the host: Chromium's private network checks would block the
 * loopback content host for a page that a route answers.
 */
async function disposable(page: Page) {
  const copy = mkdtempSync(join(ROOT, 'copy-'));
  cpSync(join(DIST, 'site'), copy, { recursive: true });
  await page.route(`${SITE}/**/*.json`, (route) => {
    const file = lookup(copy, new URL(route.request().url()).pathname);
    return file ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
  });
  return (path: string, change: (file: Json) => void) => {
    const file = JSON.parse(readFileSync(join(copy, path), 'utf8'));
    change(file);
    writeFileSync(join(copy, path), JSON.stringify(file));
  };
}

/** Writes `text` to the content host as an object would be, and gives its address there. */
function object(text: string, ext: string) {
  const name = `o/${createHash('sha256').update(text).digest('hex')}.${ext}`;
  writeFileSync(join(DIST, 'content', name), text);
  return `${CONTENT}/${name}`;
}

/** What a script in a stand-in would do, in the frame, as an image or as a page of its own. */
const SCRIPT = `parent.postMessage('stand-in', '*');
try { parent.document.title = 'changed'; } catch {}
document.title = JSON.stringify({ storage: localStorage.length + sessionStorage.length,
  cookie: document.cookie, opener: window.opener !== null });`;

test('A45 a notebook’s HTML output and an SVG load only from the content origin and cannot run script against the site', async ({
  page,
  context,
}) => {
  const responses: Seen[] = [];
  page.on('response', (r) =>
    responses.push({
      url: r.url(),
      type: r.request().resourceType(),
      mime: r.headers()['content-type'] ?? '',
      frame: r.request().frame() !== page.mainFrame(),
    }),
  );
  const scripts = (r: Seen) => r.type === 'script';
  // A PDF reading, its file read from the content host by the worker's script, then the notebook.
  await page.goto(`${sampling}/reading?resource=0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f`);
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByText('Page 1 of 2')).toBeVisible();
  await expect.poll(() => responses.some((r) => r.url.endsWith('.pdf'))).toBe(true);
  await expect.poll(() => responses.some((r) => scripts(r) && r.url.includes('worker'))).toBe(true);
  await page.goto(`${sampling}/notebooks`);
  await expect(panel.getByText('Scripts in this output were removed and not run')).toHaveCount(2);
  await expect(
    panel.getByText('Interactive output not shown (application/javascript)'),
  ).toBeVisible();
  // The fixture's one HTML output: a frame with every sandbox restriction, on the content host.
  const frames = panel.locator('iframe');
  await expect(frames).toHaveCount(1);
  await expect(frames).toHaveAttribute('sandbox', '');
  await expect(frames).toHaveAttribute('src', new RegExp(`^${CONTENT}/o/`));
  // Its three images (an attachment, a PNG and an SVG output), each loaded from the content host.
  const images = () =>
    panel
      .locator('img')
      .evaluateAll((all: HTMLImageElement[]) =>
        all.map((img) => [new URL(img.src).origin, img.complete && img.naturalWidth > 0]),
      );
  await expect.poll(images).toEqual(Array(3).fill([CONTENT, true]));
  // Every image, frame and PDF came from the content host. The site host answered documents,
  // scripts (the worker's among them), styles and JSON, and every script came from its /assets/.
  const seen = (pick: (r: Seen) => boolean, say: (r: Seen) => string) => () =>
    [...new Set(responses.filter(pick).map(say))].sort();
  const kind = (r: Seen) => (r.frame ? 'frame' : r.type === 'image' ? 'image' : 'pdf');
  const objects = (r: Seen) => r.type === 'image' || r.frame || r.url.endsWith('.pdf');
  await expect
    .poll(seen(objects, (r) => `${kind(r)} ${new URL(r.url).origin}`))
    .toEqual([`frame ${CONTENT}`, `image ${CONTENT}`, `pdf ${CONTENT}`]);
  const site = (r: Seen) => new URL(r.url).origin === SITE;
  await expect
    .poll(seen(site, (r) => r.mime.split(';')[0] ?? ''))
    .toEqual(['application/json', 'text/css', 'text/html', 'text/javascript']);
  const folder = (r: Seen) => r.url.slice(0, r.url.lastIndexOf('/') + 1);
  await expect.poll(seen(scripts, folder)).toEqual([`${SITE}/assets/`]);

  // Stand-ins for script that survived conversion, pointed at by one data file of a copy.
  const html = object(`<!doctype html><title>stand-in</title><script>${SCRIPT}</script>`, 'html');
  const svg = object(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" onload="parent.postMessage('svg', '*')"><script>${SCRIPT}</script><rect width="20" height="20"/></svg>`,
    'svg',
  );
  const edit = await disposable(page);
  edit(data.notebook, ({ notebook }) => {
    const outputs = notebook.cells.flatMap((cell: Json) => cell.outputs ?? []);
    outputs.find((output: Json) => output.type === 'html').url = html;
    outputs.find((output: Json) => output.url?.endsWith('.svg')).url = svg;
  });
  await page.addInitScript(() => {
    (window as Json).messages = [];
    window.addEventListener('message', (event) => (window as Json).messages.push(event.data));
  });
  const framed = page.waitForResponse(html);
  await page.goto(`${sampling}/notebooks`);
  const response = await framed;
  expect(response.status()).toBe(200);
  await expect(panel.locator(`iframe[src="${html}"]`)).toHaveAttribute('sandbox', '');
  await expect
    .poll(() =>
      panel.locator(`img[src="${svg}"]`).evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(20);
  // The frame's document loaded and kept its own title: its script did not run. A message the
  // frame sends now arrives alone, after anything the script could have sent.
  const frame = response.frame();
  await frame.waitForLoadState('load');
  expect(await frame.title()).toBe('stand-in');
  await frame.evaluate(() => parent.postMessage('last', '*'));
  await expect.poll(() => page.evaluate(() => (window as Json).messages)).toEqual(['last']);
  await expect(page).toHaveTitle('Sampling a reef · Parallax');

  // Opened on its own, the stand-in runs as the content host and finds nothing of the site: not
  // its storage, and not its cookie for every path, which a host of the same name on another
  // port would be sent.
  const kept = await page.evaluate(() => {
    localStorage.setItem('site', 'kept');
    // biome-ignore lint/suspicious/noDocumentCookie: a cookie of the site, which the stand-in must not find
    document.cookie = 'site=kept; path=/';
    return [localStorage.getItem('site'), document.cookie];
  });
  expect(kept).toEqual(['kept', 'site=kept']);
  const alone = await context.newPage();
  await alone.goto(html);
  await expect(alone).toHaveTitle(JSON.stringify({ storage: 0, cookie: '', opener: false }));
});

test('A45 the browser cleans the three app-origin surfaces of an altered data file', async ({
  page,
}) => {
  // Each surface past conversion, as if conversion had not cleaned it.
  const hostile = `<p>Altered by the test</p><script>window.ran = 1</script><img src="x" onerror="window.ran = 1"><a href="javascript:window.ran = 1">Run</a>`;
  const edit = await disposable(page);
  edit(data.reading, (reading) => {
    reading.html = hostile + reading.html;
  });
  edit(data.notebook, ({ notebook }) => {
    notebook.cells[0].html = hostile + notebook.cells[0].html;
  });
  edit(data.deck, (deck) => {
    deck.web.slides[0] = hostile + deck.web.slides[0];
  });
  for (const tab of ['reading', 'notebooks', 'slides']) {
    await page.goto(`${sampling}/${tab}`);
    const main = page.getByRole('main');
    await expect(main.getByText('Altered by the test')).toBeVisible();
    await expect(main.getByText('Run', { exact: true })).toBeVisible();
    // The image stays; once its load has failed, its handler, if it had kept one, has run.
    const image = main.locator('img[src="x"]');
    await expect(image).toHaveCount(1);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete)).toBe(true);
    const found = await main.evaluate((root) => ({
      scripts: root.querySelectorAll('script').length,
      handlers: [...root.querySelectorAll('*')].flatMap((el) =>
        el.getAttributeNames().filter((name) => name.startsWith('on')),
      ),
      javascript: [...root.querySelectorAll('[href],[src]')].filter((el) =>
        /^\s*javascript:/i.test(el.getAttribute('href') ?? el.getAttribute('src') ?? ''),
      ).length,
      ran: (window as Json).ran ?? null,
    }));
    expect(found, tab).toEqual({ scripts: 0, handlers: [], javascript: 0, ran: null });
  }
});
