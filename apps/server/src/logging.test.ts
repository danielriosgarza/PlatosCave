import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createLogger, REDACT_PATHS } from './logging';

/** Every sentinel below must never appear in any log line, whatever route or logger produced it. */
const SECRETS = {
  signInToken: 'SIGNIN-TOKEN-0123456789abcdefghijklmnopqrstuvwxyz',
  contentToken: 'CONTENT-TOKEN-0123456789abcdefghijklmnopqrstuvwxyz-0123456789',
  session: 'SESSION-COOKIE-VALUE-0123456789',
  answer: 'PRIVATE-ANSWER-the-student-wrote-this',
  email: 'private.person@example.org',
  dbDetail: 'Key (email)=(secret.row@example.org) already exists.',
  dbParam: 'PARAM-VALUE-IN-A-QUERY',
  smtp: 'smtp://mailer:SMTP-PASSWORD@mail.example.org:587',
};

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      done();
    },
  });
  return { lines, stream };
}

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'trace' });

const leaks = (lines: string[]) =>
  Object.entries(SECRETS)
    .filter(([, secret]) => lines.some((line) => line.includes(secret)))
    .map(([name]) => name);

describe('structured logs', () => {
  test('a request log line carries no token, cookie, body or address from the request', async () => {
    const { lines, stream } = capture();
    const app = await buildApp(config, { logStream: stream });
    await app.inject({
      method: 'GET',
      url: `/api/auth/verify?token=${SECRETS.signInToken}`,
      headers: { cookie: `pc_session=${SECRETS.session}`, authorization: 'Bearer abc' },
    });
    await app.inject({ method: 'GET', url: `/content/${SECRETS.contentToken}` });
    await app.inject({
      method: 'POST',
      url: '/api/auth/link',
      payload: { email: SECRETS.email, answer: SECRETS.answer },
    });
    await app.inject({ method: 'GET', url: `/anything/${SECRETS.contentToken}/page` });
    await app.close();
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.every((p) => typeof p.level === 'number' && typeof p.time === 'number')).toBe(
      true,
    );
    expect(leaks(lines)).toEqual([]);
  });

  test('a 5xx logs the failure without the database row values or query parameters', async () => {
    const { lines, stream } = capture();
    const app = await buildApp(config, { logStream: stream });
    app.get('/boom', async () => {
      throw Object.assign(new Error('insert failed'), {
        code: '23505',
        detail: SECRETS.dbDetail,
        parameters: [SECRETS.dbParam],
        where: SECRETS.dbParam,
        cause: Object.assign(new Error('inner'), { detail: SECRETS.dbDetail }),
      });
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    await app.close();
    expect(res.statusCode).toBe(500);
    const failure = lines.map((l) => JSON.parse(l)).find((p) => p.msg === 'request failed');
    expect(failure.err).toMatchObject({ code: '23505' });
    expect(failure.err.message).toContain('insert failed');
    expect(leaks(lines)).toEqual([]);
  });

  test('keys that hold private content are removed from any logged object, at two levels', async () => {
    const { lines, stream } = capture();
    const app = await buildApp(config, { logStream: stream });
    app.log.info({ body: SECRETS.answer, id: 'visible-1' }, 'top level');
    app.log.info(
      { request: { headers: { cookie: SECRETS.session }, content: SECRETS.answer }, count: 3 },
      'nested',
    );
    app.log.info(
      { smtpUrl: SECRETS.smtp, token: SECRETS.signInToken, to: SECRETS.email },
      'config',
    );
    await app.close();
    expect(leaks(lines)).toEqual([]);
    const top = JSON.parse(lines.find((l) => l.includes('top level')) as string);
    expect(top).toMatchObject({ id: 'visible-1' });
    expect(top).not.toHaveProperty('body');
    const nested = JSON.parse(lines.find((l) => l.includes('"nested"')) as string);
    expect(nested.count).toBe(3);
    expect(nested.request).not.toHaveProperty('content');
  });

  test('the worker logger redacts the same keys and names itself', () => {
    const { lines, stream } = capture();
    const log = createLogger(config, 'worker', stream);
    log.error(
      {
        err: Object.assign(new Error('job failed'), { detail: SECRETS.dbDetail }),
        payload: { email: SECRETS.email },
      },
      'job failed',
    );
    expect(leaks(lines)).toEqual([]);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ name: 'worker', msg: 'job failed' });
  });

  test('the redaction list covers cookies, authorisation and tokens on requests and responses', () => {
    for (const path of [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'token',
      '*.token',
      'body',
    ]) {
      expect(REDACT_PATHS).toContain(path);
    }
  });
});
