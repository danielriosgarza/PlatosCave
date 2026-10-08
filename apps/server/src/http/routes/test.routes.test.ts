import { expect, test } from 'vitest';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';

const body = { email: 'student@example.org', authenticatedMinutesAgo: 0 };

test('AUD16 test routes answer only peers on this machine', async () => {
  const app = await buildApp(
    loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', TEST_ROUTES: '1' }),
  );
  const post = (remoteAddress: string) =>
    app.inject({ method: 'POST', url: '/api/test/signin-as', payload: body, remoteAddress });

  const remote = await post('203.0.113.9');
  expect(remote.statusCode).toBe(404);
  expect(remote.headers['set-cookie']).toBeUndefined();
  expect((await post('10.0.0.5')).statusCode).toBe(404);
  // A loopback peer passes the guard; with no database the handler then fails, which is not a 404.
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    expect((await post(peer)).statusCode, peer).not.toBe(404);
  }
  await app.close();
});

test('AUD16 test routes are not mounted without TEST_ROUTES', async () => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  const res = await app.inject({ method: 'POST', url: '/api/test/signin-as', payload: body });
  expect(res.statusCode).toBe(404);
  await app.close();
});
