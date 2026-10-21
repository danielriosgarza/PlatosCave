import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CONTENT, SITE } from '../static-server';
import { Connector, expectLoopbackOnly, listeningAddresses } from '../tests/connector/connector';

/*
 * A57 with a real `parallax-connector open` and real Jupyter (docs/design/open-site.md §14): the
 * school fixture's notebook runs on the computer of the browser, with its data file, and the
 * outputs return to the course page. playwright.open.config.ts collects it when CONNECTOR_E2E is
 * set, which the open-site workflow does after installing Go and Jupyter Server.
 */

const sampling = '/courses/ana/reef-ecology/5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33';
const CONNECTOR = 'http://127.0.0.1:47821';
/** The fourth cell, edited on the page: it reads the data file and shows HTML and an SVG. */
const EDITED = [
  'from IPython.display import HTML, SVG, display',
  "print(len(rows), rows[0]['note'])",
  `display(HTML('<table><tr><th>fish</th><td>8</td></tr></table><script>parent.document.title = "ran"</script>'))`,
  `display(SVG('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'))`,
].join('\n');

let connector: Connector | undefined;
test.afterAll(async () => connector?.dispose());

test('A57 a level 0 notebook runs on this computer through the connector, and its outputs return to the course page', async ({
  page,
}) => {
  connector = new Connector();
  const workspace = connector.workspace();
  const run = connector.open(workspace, '--allow', SITE);
  await run.waitFor(/is open on http:\/\/127\.0\.0\.1:47821/);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.goto(`${sampling}/notebooks`);
  const panel = page.getByRole('tabpanel');
  await expect(page.getByText('Saved outputs')).toBeVisible();
  await page.getByRole('button', { name: 'Run on this computer' }).click();
  await expect(page.getByRole('heading', { name: 'Run on this computer' })).toBeVisible();
  // Choosing it asks the connector nothing; Connect does.
  expect(requests.filter((url) => url.startsWith(CONNECTOR))).toEqual([]);
  await page.getByRole('button', { name: 'Connect' }).click();
  const mode = page.getByText(/^This computer · Python · /);
  await expect(mode).toHaveText('This computer · Python · Ready', { timeout: 60_000 });
  await expect(
    page.getByText(/^The notebook's files are in local-127\.0\.0\.1-4175\//),
  ).toBeVisible();
  // The connector and the Jupyter it started listen on loopback only.
  expectLoopbackOnly(run.child.pid as number);

  const cell = (n: number) => panel.getByRole('region', { name: new RegExp(`^Code cell ${n} `) });
  const runCell = (n: number) =>
    cell(n)
      .getByRole('button', { name: new RegExp(`^Run cell ${n} `) })
      .click();
  await runCell(2);
  await expect(cell(2)).toContainText('Finished');
  await runCell(3);
  await expect(cell(3)).toContainText('Finished');
  await expect(cell(3)).toContainText('RUN');

  // An edit of the page runs as edited: the data file is beside the notebook on this computer.
  await cell(4).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(EDITED);
  await runCell(4);
  await expect(cell(4)).toContainText('Finished');
  await expect(cell(4)).toContainText('2 only-in-a-data-file');
  // HTML in a frame with every sandbox restriction, without its script; SVG as an image.
  const frame = cell(4).locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', '');
  expect(await frame.getAttribute('srcdoc')).not.toContain('<script');
  await expect(cell(4).frameLocator('iframe').getByText('fish')).toBeVisible();
  const svg = cell(4).locator('img');
  await expect(svg).toHaveAttribute('src', /^data:image\/svg\+xml;/);
  await expect.poll(() => svg.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(20);
  expect(await page.title()).not.toBe('ran');

  // The notebook's folder below the site's, with the notebook and its data file.
  const files = readdirSync(workspace, { recursive: true, encoding: 'utf8' });
  const folder = 'local-127.0.0.1-4175/ana/reef-ecology/Counting-quadrats';
  expect(files).toContain(`${folder}/data/quadrats.csv`);
  // The page asked the site, its content host and the connector, and nothing else.
  const origins = new Set(requests.map((url) => new URL(url).origin));
  expect([...origins].sort()).toEqual([SITE, CONNECTOR, CONTENT].sort());

  // Stop session ends the notebook's Jupyter on this computer; the page shows the saved outputs.
  await page.getByRole('button', { name: 'Session' }).click();
  await page.getByRole('button', { name: 'Stop session' }).click();
  await page
    .getByRole('region', { name: 'Stop session' })
    .getByRole('button', { name: 'Stop session' })
    .click();
  await expect(page.getByText('Saved outputs')).toBeVisible();
  await expect
    .poll(() => listeningAddresses(run.child.pid as number), { timeout: 30_000 })
    .toEqual(['127.0.0.1:47821']);
});
