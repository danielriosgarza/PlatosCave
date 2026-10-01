import { expect, test } from 'vitest';
import { DEV_SESSION_SECRET, loadConfig } from './config';

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

test('fixture routes are off by default and refused in production', () => {
  expect(loadConfig({ NODE_ENV: 'test' }).TEST_ROUTES).toBe(false);
  expect(loadConfig({ NODE_ENV: 'test', TEST_ROUTES: '1' }).TEST_ROUTES).toBe(true);
  const production = {
    NODE_ENV: 'production',
    SESSION_SECRET: 'x'.repeat(32),
    APP_ORIGIN: 'https://parallax.example.org',
  } as const;
  expect(loadConfig(production).TEST_ROUTES).toBe(false);
  expect(() => loadConfig({ ...production, TEST_ROUTES: '1' })).toThrow(/TEST_ROUTES/);
});
