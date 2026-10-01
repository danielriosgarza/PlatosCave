import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { type ContentGrant, mintContentToken } from '../content/tokens';
import { FsStorage } from '../storage/fs';
import { courseObjectPrefix } from '../storage/storage';
import { redactContentUrl } from './content';

const course = '00000000-0000-4000-8000-000000000101';
const now = new Date('2026-10-01T09:00:00Z');
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_HOST: '127.0.0.1',
  CONTENT_HOST: 'localhost',
  CONTENT_ORIGIN: 'http://localhost:3100',
});
const app = { host: '127.0.0.1:3100' };
const content = { host: 'localhost:3100' };

let root: string;
let server: FastifyInstance;
let clock = now;
let key: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'parallax-content-'));
  const storage = new FsStorage(root);
  ({ key } = await storage.put(courseObjectPrefix(course), Buffer.from('<svg>…</svg>')));
  server = await buildApp(config, { storage, now: () => clock });
  await server.ready();
});
afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

const grant = {
  userId: '00000000-0000-4000-8000-000000000004',
  scopeId: course,
  contentType: 'image/svg+xml',
  disposition: 'inline',
} as const;
const token = (extra: Partial<ContentGrant> = {}) =>
  mintContentToken(config.CONTENT_TOKEN_SECRET, { ...grant, key, ...extra }, now);

const get = (url: string, headers: Record<string, string>) =>
  server.inject({ method: 'GET', url, headers });

describe('content origin', () => {
  test('streams a token’s object on the content host with a sandboxed, cross-origin policy', async () => {
    const res = await get(`/content/${token()}`, content);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<svg>…</svg>');
    expect(res.headers).toMatchObject({
      'content-type': 'image/svg+xml',
      'content-length': String(Buffer.byteLength('<svg>…</svg>')),
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, max-age=300',
    });
    const csp = String(res.headers['content-security-policy']);
    expect(csp.split('; ')).toEqual(
      expect.arrayContaining([
        'sandbox',
        "default-src 'none'",
        'img-src http://localhost:3100 data:',
      ]),
    );
    expect(csp).not.toContain('script-src');
    expect(res.headers['set-cookie']).toBeUndefined();

    const head = await server.inject({
      method: 'HEAD',
      url: `/content/${token()}`,
      headers: content,
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });

  test('downloads carry an attachment disposition with a safe file name', async () => {
    const res = await get(
      `/content/${token({ disposition: 'attachment', filename: 'Café "notes".svg' })}`,
      content,
    );
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Caf_ _notes_.svg"; filename*=UTF-8''${encodeURIComponent('Café "notes".svg')}`,
    );
  });

  test('A01 expired, forged and unknown-object tokens get 404', async () => {
    const valid = token();
    clock = new Date(now.getTime() + 300_000);
    expect((await get(`/content/${valid}`, content)).statusCode).toBe(404);
    clock = now;
    const otherSecret = mintContentToken('z'.repeat(32), { ...grant, key }, now);
    expect((await get(`/content/${otherSecret}`, content)).statusCode).toBe(404);
    const missing = token({ key: `courses/${course}/objects/${'f'.repeat(64)}` });
    const res = await get(`/content/${missing}`, content);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  test('the content host serves nothing else and ignores cookies; the app host has no /content', async () => {
    for (const url of ['/api/health', '/', '/assets/app.js', '/content/']) {
      expect((await get(url, content)).statusCode, url).toBe(404);
    }
    const withCookie = await get('/api/health', { ...content, cookie: 'pc_session=anything' });
    expect(withCookie.statusCode).toBe(404);
    expect((await get(`/content/${token()}`, app)).statusCode).toBe(404);
    expect((await get('/api/health', app)).statusCode).toBe(200);
  });

  test('tokens are redacted from logged request URLs', () => {
    expect(redactContentUrl(`/content/${token()}`)).toBe('/content/[redacted]');
    expect(redactContentUrl('/api/health')).toBe('/api/health');
  });
});
