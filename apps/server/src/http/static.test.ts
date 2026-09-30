import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';

const dir = mkdtempSync(join(tmpdir(), 'parallax-static-'));
mkdirSync(join(dir, 'assets'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title>');
writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', STATIC_DIR: dir });

describe('SPA static serving', () => {
  it('serves index.html uncached for SPA routes, including HEAD', async () => {
    const app = await buildApp(config);
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await app.inject({ method, url: '/some/route' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
    }
    await app.close();
  });

  it('caches hashed assets long and returns 404 for missing assets', async () => {
    const app = await buildApp(config);
    const ok = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(ok.headers['cache-control']).toContain('immutable');
    const missing = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('does not serve the SPA for /api paths', async () => {
    const app = await buildApp(config);
    for (const url of ['/api', '/api/nope']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    await app.close();
  });
});
