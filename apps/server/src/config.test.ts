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
      TRUST_PROXY: 'false',
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

  test('smtp needs a sender; the file transport keeps a placeholder', () => {
    expect(() =>
      loadConfig({ MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://mail.example.org' }),
    ).toThrow(/MAIL_FROM/);
    expect(
      loadConfig({
        MAIL_TRANSPORT: 'smtp',
        SMTP_URL: 'smtp://mail.example.org',
        MAIL_FROM: 'Parallax <login@example.org>',
      }).MAIL_FROM,
    ).toBe('Parallax <login@example.org>');
    expect(loadConfig({}).MAIL_FROM).toBe('Parallax <no-reply@parallax.invalid>');
  });

  test('TRUST_PROXY is off by default and reads true or proxy addresses', () => {
    expect(loadConfig({}).TRUST_PROXY).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ TRUST_PROXY: 'loopback, ::1, fd00::/8' }).TRUST_PROXY).toEqual([
      'loopback',
      '::1',
      'fd00::/8',
    ]);
    expect(loadConfig({ TRUST_PROXY: '10.0.0.0/8, 192.168.1.5' }).TRUST_PROXY).toEqual([
      '10.0.0.0/8',
      '192.168.1.5',
    ]);
    // A hop count would silently trust nobody under Fastify 5; anything else would crash later.
    for (const bad of ['1', 'yes', 'nginx', '1.5', '10.0.0.0/33', '10.0.0.0/8,', '1.2.3.4/8/9']) {
      expect(() => loadConfig({ TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY/);
    }
  });

  test('A01 production requires TRUST_PROXY set explicitly; development and test default to false', () => {
    const production = {
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(32),
      APP_ORIGIN: 'https://parallax.example.org',
      APP_HOST: 'parallax.example.org',
      CONTENT_HOST: 'content.parallax.example.org',
      CONTENT_ORIGIN: 'https://content.parallax.example.org',
      CONTENT_TOKEN_SECRET: 's'.repeat(40),
    } as const;
    // Unset, or empty as in .env.example, is refused with a message naming the choice.
    expect(() => loadConfig(production)).toThrow(/TRUST_PROXY[\s\S]*required in production/);
    expect(() => loadConfig({ ...production, TRUST_PROXY: '' })).toThrow(/TRUST_PROXY/);
    expect(loadConfig({ ...production, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...production, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ ...production, TRUST_PROXY: '10.0.0.0/8' }).TRUST_PROXY).toEqual([
      '10.0.0.0/8',
    ]);
    expect(loadConfig({ NODE_ENV: 'development' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test' }).TRUST_PROXY).toBe(false);
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
    TRUST_PROXY: 'false',
  });
  expect(config.APP_ORIGIN).toBe('https://parallax.example.org');
});

test('a short session secret is refused', () => {
  expect(() => loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'short' })).toThrow();
});

test('the smtp transport needs SMTP_URL', () => {
  expect(() => loadConfig({ NODE_ENV: 'test', MAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_URL/);
  expect(
    loadConfig({
      NODE_ENV: 'test',
      MAIL_TRANSPORT: 'smtp',
      SMTP_URL: 'smtp://localhost:1025',
      MAIL_FROM: 'Parallax <login@example.org>',
    }).MAIL_TRANSPORT,
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
    TRUST_PROXY: 'false',
  } as const;
  expect(loadConfig(production).TEST_ROUTES).toBe(false);
  expect(() => loadConfig({ ...production, TEST_ROUTES: '1' })).toThrow(/TEST_ROUTES/);
});

test('A11 approved Shiny origins are origins on https or loopback, and never the app or content origin', () => {
  expect(loadConfig({}).SHINY_ORIGINS).toEqual([]);
  expect(
    loadConfig({ SHINY_ORIGINS: 'https://shiny.example.org/app, http://127.0.0.1:3838' })
      .SHINY_ORIGINS,
  ).toEqual(['https://shiny.example.org', 'http://127.0.0.1:3838']);
  expect(() => loadConfig({ SHINY_ORIGINS: 'http://shiny.example.org' })).toThrow(/https/);
  expect(() => loadConfig({ SHINY_ORIGINS: 'shiny.example.org' })).toThrow();
  expect(() => loadConfig({ SHINY_ORIGINS: 'http://localhost:3838' })).toThrow(/app or content/);
  expect(() => loadConfig({ SHINY_ORIGINS: 'http://127.0.0.1:3000' })).toThrow(/app or content/);
});
