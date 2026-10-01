import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { downloadName } from '../content/media';
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
let web: string;
let server: FastifyInstance;
let clock = now;
let key: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'parallax-content-'));
  const storage = new FsStorage(root);
  ({ key } = await storage.put(courseObjectPrefix(course), Buffer.from('<svg>…</svg>')));
  // A built web app, so the SPA fallback is live as in production.
  web = await mkdtemp(join(tmpdir(), 'parallax-web-'));
  await mkdir(join(web, 'assets'));
  await writeFile(join(web, 'index.html'), '<!doctype html><title>Parallax</title>');
  await writeFile(join(web, 'assets', 'app.js'), 'console.log(1)');
  server = await buildApp({ ...config, STATIC_DIR: web }, { storage, now: () => clock });
  await server.ready();
});
afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
  await rm(web, { recursive: true, force: true });
});

const grant = {
  userId: '00000000-0000-4000-8000-000000000004',
  scopeId: course,
  contentType: 'image/svg+xml',
  disposition: 'inline',
} as const;
const token = (extra: Partial<ContentGrant> = {}) =>
  mintContentToken(config.CONTENT_TOKEN_SECRET, { ...grant, key, ...extra }, now).token;

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
      `/content/${token({ disposition: 'attachment', filename: 'Café "Bob\'s" (notes).svg' })}`,
      content,
    );
    // RFC 8187: ' ( ) are not attr-chars and must be percent-encoded in filename*.
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Caf_ _Bob's_ (notes).svg"; filename*=UTF-8''Caf%C3%A9%20%22Bob%27s%22%20%28notes%29.svg`,
    );
  });

  test('the longest download name still yields a token the content origin accepts', async () => {
    const name = downloadName('統計'.repeat(400), 'application/pdf');
    expect([...name]).toHaveLength(104);
    const res = await get(
      `/content/${token({ disposition: 'attachment', filename: name })}`,
      content,
    );
    expect(res.statusCode).toBe(200);
  });

  test('A01 expired, forged and unknown-object tokens get 404', async () => {
    const valid = token();
    clock = new Date(now.getTime() + 300_000);
    expect((await get(`/content/${valid}`, content)).statusCode).toBe(404);
    clock = now;
    const otherSecret = mintContentToken('z'.repeat(32), { ...grant, key }, now).token;
    expect((await get(`/content/${otherSecret}`, content)).statusCode).toBe(404);
    const missing = token({ key: `courses/${course}/objects/${'f'.repeat(64)}` });
    const res = await get(`/content/${missing}`, content);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  test('the content host serves nothing else and ignores cookies; the app host has no /content', async () => {
    for (const url of [
      '/api/health',
      '/',
      '/topics',
      '/assets/app.js',
      '/content',
      '/content/',
      `/content/${token()}/x`,
      '/content/a/b',
    ]) {
      const res = await get(url, content);
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('<title>Parallax</title>');
    }
    // The web app itself is still served on the app host.
    expect((await get('/topics', app)).body).toContain('<title>Parallax</title>');
    const withCookie = await get('/api/health', { ...content, cookie: 'pc_session=anything' });
    expect(withCookie.statusCode).toBe(404);
    expect((await get(`/content/${token()}`, app)).statusCode).toBe(404);
    expect((await get('/api/health', app)).statusCode).toBe(200);
  });

  test('an absolute-form request target cannot reach /content on the app host', async () => {
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = new URL(address);
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(
          `GET http://x/content/${token()} HTTP/1.1\r\nHost: 127.0.0.1:3100\r\nConnection: close\r\n\r\n`,
        );
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
    });
    expect(status).toBe('HTTP/1.1 404 Not Found');
  });

  test('tokens are redacted from logged request URLs', () => {
    expect(redactContentUrl(`/content/${token()}`)).toBe('/content/[redacted]');
    expect(redactContentUrl('/api/health')).toBe('/api/health');
    expect(redactContentUrl(`http://x/content/${token()}?a=1`)).toBe(
      'http://x/content/[redacted]?a=1',
    );
  });
});
