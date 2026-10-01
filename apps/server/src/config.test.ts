import { describe, expect, test } from 'vitest';
import { DEV_CONTENT_TOKEN_SECRET, DEV_SESSION_SECRET, loadConfig } from './config';

describe('config', () => {
  test('development defaults: app on localhost, content origin on 127.0.0.1, fs storage', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      APP_HOST: 'localhost',
      CONTENT_HOST: '127.0.0.1',
      CONTENT_ORIGIN: 'http://127.0.0.1:3000',
      CONTENT_TOKEN_SECRET: DEV_CONTENT_TOKEN_SECRET,
      STORAGE_DRIVER: 'fs',
    });
  });

  test('the content host must differ from the app host and match CONTENT_ORIGIN', () => {
    expect(() => loadConfig({ APP_HOST: 'localhost', CONTENT_HOST: 'LOCALHOST' })).toThrow(
      /must differ/,
    );
    expect(() =>
      loadConfig({ CONTENT_HOST: 'content.example.org', CONTENT_ORIGIN: 'https://example.org' }),
    ).toThrow(/CONTENT_HOST/);
    expect(() => loadConfig({ CONTENT_HOST: 'http://localhost' })).toThrow();
  });

  test('production requires the content origin and token secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/CONTENT_ORIGIN/);
    const config = loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(32),
      APP_ORIGIN: 'https://parallax.example.org',
      APP_HOST: 'parallax.example.org',
      CONTENT_HOST: 'content.parallax.example.org',
      CONTENT_ORIGIN: 'https://content.parallax.example.org/',
      CONTENT_TOKEN_SECRET: 's'.repeat(40),
    });
    expect(config.CONTENT_ORIGIN).toBe('https://content.parallax.example.org');
  });

  test('a server reachable beyond loopback never runs on the public development secret', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/CONTENT_TOKEN_SECRET/);
    expect(loadConfig({ HOST: '0.0.0.0', CONTENT_TOKEN_SECRET: 's'.repeat(40) })).toBeTruthy();
    expect(loadConfig({ HOST: '0.0.0.0', NODE_ENV: 'test' }).CONTENT_TOKEN_SECRET).toBe(
      DEV_CONTENT_TOKEN_SECRET,
    );
  });

  test('the s3 driver needs a bucket and credentials', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    const config = loadConfig({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'parallax',
      S3_ACCESS_KEY_ID: 'GK1',
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
  });
});

test('development and test run without secrets, using the dev session secret', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  expect(config.SESSION_SECRET).toBe(DEV_SESSION_SECRET);
  expect(config.APP_ORIGIN).toBe('http://localhost:5173');
  expect(config.MAIL_TRANSPORT).toBe('file');
});

test('production refuses to start without SESSION_SECRET and APP_ORIGIN', () => {
  expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
  expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) })).toThrow(
    /APP_ORIGIN/,
  );
  const config = loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'x'.repeat(32),
    APP_ORIGIN: 'https://parallax.example.org/some/path',
    APP_HOST: 'parallax.example.org',
    CONTENT_HOST: 'content.parallax.example.org',
    CONTENT_ORIGIN: 'https://content.parallax.example.org',
    CONTENT_TOKEN_SECRET: 's'.repeat(40),
  });
  expect(config.APP_ORIGIN).toBe('https://parallax.example.org');
});

test('a short session secret is refused', () => {
  expect(() => loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'short' })).toThrow();
});

test('the smtp transport needs SMTP_URL', () => {
  expect(() => loadConfig({ NODE_ENV: 'test', MAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_URL/);
  expect(
    loadConfig({ NODE_ENV: 'test', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://localhost:1025' })
      .MAIL_TRANSPORT,
  ).toBe('smtp');
});

test('A01 fixture routes are off by default and refused in production', () => {
  expect(loadConfig({ NODE_ENV: 'test' }).TEST_ROUTES).toBe(false);
  expect(loadConfig({ NODE_ENV: 'test', TEST_ROUTES: '1' }).TEST_ROUTES).toBe(true);
  const production = {
    NODE_ENV: 'production',
    SESSION_SECRET: 'x'.repeat(32),
    APP_ORIGIN: 'https://parallax.example.org',
    APP_HOST: 'parallax.example.org',
    CONTENT_HOST: 'content.parallax.example.org',
    CONTENT_ORIGIN: 'https://content.parallax.example.org',
    CONTENT_TOKEN_SECRET: 's'.repeat(40),
  } as const;
  expect(loadConfig(production).TEST_ROUTES).toBe(false);
  expect(() => loadConfig({ ...production, TEST_ROUTES: '1' })).toThrow(/TEST_ROUTES/);
});
