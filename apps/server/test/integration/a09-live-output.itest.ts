import hostile from '@parallax/contracts/fixtures/hostile-live-output.json';
import { MAX_LIVE_OUTPUT_BYTES } from '@parallax/contracts/routes/notebookSessions';
import { notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { notebookSessions } from '../../src/db/schema';
import type { Storage } from '../../src/storage/storage';
import { ids, type PersonName } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { readySession } from './kernel-channel';
import { call, insertNotebook } from './notebook-sessions';
import { type Relay, startRelay } from './relay';
import { tempStorage } from './working-copies';

/**
 * A09 for live output (spec §10.4, docs/design/connector.md §14, ADR-0002): a rich output a
 * kernel sends during a session is sanitised with the stored-output rules, stored under the
 * session's area and served only from the content origin, sandboxed, through five-minute links
 * minted for the session's owner. Anyone else asking about the session gets the shared 404.
 */

const start = new Date('2026-10-01T09:00:00Z');
let testDb: TestDatabase;
let relay: Relay;
let storage: { storage: Storage; cleanup: () => Promise<void> };
let revisionId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  storage = await tempStorage();
  relay = await startRelay(testDb, start, { storage: storage.storage });
  revisionId = await insertNotebook(testDb.db, start);
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
  await storage?.cleanup();
});

// One open session per person and notebook: each test starts with none.
beforeEach(async () => {
  relay.advance(61_000);
  await testDb.db
    .update(notebookSessions)
    .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
    .where(notInArray(notebookSessions.state, ['stopped', 'failed']));
});

const cookie = (who: PersonName) => relay.world.cookie[who];

/** What the content origin serves for a link, as a browser asks: its host, no cookie. */
const fetchContent = (url: string) => {
  const parsed = new URL(url);
  return relay.app.inject({ method: 'GET', url: parsed.pathname, headers: { host: parsed.host } });
};

const show = (who: PersonName, url: string, data: Record<string, unknown>, executionCount = 1) =>
  call(relay, cookie(who), 'POST', `${url}/outputs`, { data, executionCount });

describe('A09 live output on the content origin', () => {
  test('A09 live HTML output is served sandboxed from the content origin', async () => {
    const { url } = await readySession(relay, testDb, revisionId, { kernel: false });
    const res = await show('sam', url, hostile.html);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { output, expiresAt } = res.body;
    expect(output).toMatchObject({ type: 'html', executionCount: 1, scriptsRemoved: true });
    expect(new Date(expiresAt).getTime()).toBe(relay.now().getTime() + 300_000);
    const link = new URL(output.url);
    expect(link.host).not.toBe(new URL(relay.origin).host);

    const frame = await fetchContent(output.url);
    expect(frame.statusCode).toBe(200);
    expect(frame.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(frame.headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
    expect(frame.headers['set-cookie']).toBeUndefined();
    // The document keeps the content and nothing that runs.
    expect(frame.body).toContain('x online = 3');
    expect(frame.body).not.toMatch(/<script|onerror|onload|javascript:|<iframe|<object|<embed/i);

    // The same output shown again is the same stored object under a new five-minute link.
    relay.advance(120_000);
    const again = await show('sam', url, hostile.html);
    expect(again.status).toBe(200);
    expect(again.body.output.url).not.toBe(output.url);
    expect(new Date(again.body.expiresAt).getTime()).toBe(relay.now().getTime() + 300_000);
    // The first link has passed its five minutes; it no longer serves anything.
    relay.advance(181_000);
    expect((await fetchContent(output.url)).statusCode).toBe(404);
    expect((await fetchContent(again.body.output.url)).statusCode).toBe(200);
  });

  test('A09 live SVG and images are sanitised and served only from the content origin', async () => {
    const { url } = await readySession(relay, testDb, revisionId, { kernel: false });
    const svg = await show('sam', url, hostile.svg);
    expect(svg.status, JSON.stringify(svg.body)).toBe(200);
    expect(svg.body.output).toMatchObject({
      type: 'image',
      alt: '<Figure size 640x480>',
      scriptsRemoved: true,
    });
    const served = await fetchContent(svg.body.output.url);
    expect(served.headers['content-type']).toBe('image/svg+xml');
    expect(served.headers['content-security-policy']).toMatch(/^sandbox;/);
    expect(served.body).toContain('<circle r="4"');
    expect(served.body).not.toMatch(/script|onload|onclick|foreignObject|animate|__pwned/i);

    const png = await show('sam', url, { 'image/png': 'iVBORw0KGgo=' }, 2);
    expect(png.body.output).toMatchObject({
      type: 'image',
      executionCount: 2,
      alt: 'Image output',
    });
    expect(png.body.output.scriptsRemoved).toBeUndefined();
    const image = await fetchContent(png.body.output.url);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  });

  test('A09 a live output that names no object is answered as stored output, without a link', async () => {
    const { url } = await readySession(relay, testDb, revisionId, { kernel: false });
    const table = await show('sam', url, {
      'text/html': '<table><tr><th>a</th></tr><tr><td>1</td></tr></table>',
    });
    expect(table.body).toMatchObject({ output: { type: 'table' }, expiresAt: null });
    const markdown = await show('sam', url, hostile.markdown);
    expect(markdown.body).toMatchObject({ output: { type: 'markdown' }, expiresAt: null });
    expect(markdown.body.output.html).toContain('<strong>bold</strong>');
    expect(markdown.body.output.html).not.toMatch(/<script|<img|onerror|javascript:/i);
    // Past the body limit: refused before anything is rendered or stored.
    const huge = await show('sam', url, {
      'text/html': 'x'.repeat(MAX_LIVE_OUTPUT_BYTES + 65_536),
    });
    expect(huge.status).toBe(413);
    const widget = await show('sam', url, {
      'application/vnd.jupyter.widget-view+json': { model_id: 'm' },
    });
    expect(widget.body.output).toEqual({
      type: 'unsupported',
      executionCount: 1,
      mimeTypes: ['application/vnd.jupyter.widget-view+json'],
    });
  });

  test("A09 another person's session cannot read the output URL", async () => {
    const { url } = await readySession(relay, testDb, revisionId, { kernel: false });
    const data = { 'text/html': '<p>mine</p>' };
    // The class's instructor and a member of another class: the shared 404, nothing minted.
    for (const who of ['priya', 'bea'] as const) {
      const res = await show(who, url, data);
      expect(res, who).toMatchObject({ status: 404, body: { error: 'not found' } });
      expect(JSON.stringify(res.body)).not.toContain('/content/');
    }
    // The same session id named under another class is not found either.
    const elsewhere = url.replace(ids.classA, ids.classB);
    expect((await show('sam', elsewhere, data)).status).toBe(404);
    // Without a sign-in, nothing.
    const anonymous = await relay.app.inject({
      method: 'POST',
      url: `${url}/outputs`,
      payload: { data, executionCount: null },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
