import { expect, test } from 'vitest';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';

const body = { email: 'student@example.org', authenticatedMinutesAgo: 0 };
const id = '00000000-0000-4000-8000-000000000000';
// Spellings find-my-way decodes before matching; `req.url` stays raw.
const paths = [
  '/api/test/signin-as',
  '/api/%74est/signin-as',
  '/%61pi/test/signin-as',
  '/api/te%73t/world',
  `/api/test/connectors/${id}/approve`,
  `/api/%74est/connectors/${id}/drop-link`,
];

test('AUD16 test routes answer only peers on this machine', async () => {
  const app = await buildApp(
    loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', TEST_ROUTES: '1' }),
  );
  const post = (url: string, remoteAddress: string) =>
    app.inject({ method: 'POST', url, payload: body, remoteAddress });

  for (const url of paths) {
    for (const peer of ['203.0.113.9', '10.0.0.5', '::ffff:10.0.0.5', '2001:db8::1']) {
      const res = await post(url, peer);
      expect(res.statusCode, `${peer} ${url}`).toBe(404);
      expect(res.headers['set-cookie'], `${peer} ${url}`).toBeUndefined();
    }
  }
  // A loopback peer passes the guard; with no database the handler then answers 503.
  for (const peer of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    expect((await post('/api/test/signin-as', peer)).statusCode, peer).toBe(503);
    expect((await post('/api/%74est/signin-as', peer)).statusCode, peer).toBe(503);
  }
  await app.close();
});

test('AUD16 test routes are not mounted without TEST_ROUTES', async () => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  const res = await app.inject({ method: 'POST', url: '/api/test/signin-as', payload: body });
  expect(res.statusCode).toBe(404);
  await app.close();
});
