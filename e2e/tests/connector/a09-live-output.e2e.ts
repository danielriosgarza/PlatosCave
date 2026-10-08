import { expect, test } from '@playwright/test';
import { Connector } from './connector';
import { endSessions, liveLocalNotebook, typeInCell } from './ui';

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test('A09 a live HTML output with a script runs no script, in a sandboxed frame on the content origin', async ({
  page,
}) => {
  test.setTimeout(240_000);
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
  const connector = new Connector();
  try {
    await liveLocalNotebook(page, connector, 'A09 live laptop');
    const notebook = page.getByRole('article', { name: 'Live notebook' });
    const cell = notebook.getByRole('region', { name: /^Code cell 2/ });

    const html =
      '<p id="state">Live chart without script</p>' +
      "<script>document.getElementById('state').textContent='Script ran';" +
      "window.parent.postMessage('pwned','*')</script>";
    await typeInCell(
      page,
      /^Code of cell 2/,
      `from IPython.display import HTML, display; display(HTML(${JSON.stringify(html)}))`,
    );
    await notebook.getByRole('button', { name: /^Run cell 2/ }).click();

    // The streamed output arrives as a frame the page does not own.
    const frame = cell.locator('iframe');
    await expect(frame).toHaveCount(1, { timeout: 60_000 });
    await expect(frame).toHaveAttribute('sandbox', '');
    expect(new URL((await frame.getAttribute('src')) ?? '').origin).not.toBe(
      new URL(page.url()).origin,
    );
    await expect(page.frameLocator('iframe').locator('#state')).toHaveText(
      'Live chart without script',
    );
    await expect(cell.getByText('Scripts in this output were removed and not run')).toBeVisible();
    // Live is told from stored: this cell no longer shows a stored label, the others still do.
    await expect(cell.getByText(/Stored output/)).toHaveCount(0);
    await expect(notebook.getByText(/Stored output/).first()).toBeVisible();

    expect(frames.length).toBeGreaterThan(0);
    for (const { csp } of frames) {
      expect(csp.split(';')[0]).toBe('sandbox');
      expect(csp).not.toContain('allow-scripts');
    }
    expect(
      await page.evaluate(
        () => (window as unknown as { notebookMessages: unknown[] }).notebookMessages,
      ),
    ).toEqual([]);
  } finally {
    await endSessions(page).catch(() => undefined);
    await connector.dispose();
  }
});
