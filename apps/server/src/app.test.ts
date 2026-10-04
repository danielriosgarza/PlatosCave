import { expect, test } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { redactUrl } from './http/redact';

test('sign-in tokens are redacted from logged URLs', () => {
  expect(redactUrl('/api/auth/verify?token=abc123')).toBe('/api/auth/verify?token=[redacted]');
  expect(redactUrl('/x?a=1&token=abc&b=2')).toBe('/x?a=1&token=[redacted]&b=2');
  expect(redactUrl('/api/me')).toBe('/api/me');
});

test('the OpenAPI document lists the sign-in routes with their success statuses', async () => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  const doc = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json();
  // Error statuses are listed too (errorResponses); the success status is the only one below 400.
  const success = (op: { responses: object }) =>
    Object.keys(op.responses).filter((status) => Number(status) < 400);
  expect(success(doc.paths['/api/auth/link'].post)).toEqual(['202']);
  expect(success(doc.paths['/api/auth/verify'].get)).toEqual(['302']);
  expect(success(doc.paths['/api/auth/signout'].post)).toEqual(['200']);
  await app.close();
});
