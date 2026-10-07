import { Writable } from 'node:stream';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createLogger, REDACT_PATHS, serialiseError } from './logging';

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

  test('a failed query as drizzle throws it logs its error code and none of its bound values', async () => {
    const { lines, stream } = capture();
    const app = await buildApp(config, { logStream: stream });
    const query = () =>
      new DrizzleQueryError(
        'insert into answers (text) values ($1)',
        [SECRETS.dbParam, SECRETS.answer],
        Object.assign(new Error(`duplicate key ${SECRETS.dbDetail}`), {
          code: '23505',
          detail: SECRETS.dbDetail,
        }),
      );
    app.get('/query', async () => {
      throw query();
    });
    const res = await app.inject({ method: 'GET', url: '/query' });
    expect(res.statusCode).toBe(500);
    // The worker's logger gets the same error.
    const worker = capture();
    createLogger(config, 'worker', worker.stream).error({ err: query() }, 'job failed');
    await app.close();
    for (const written of [lines, worker.lines]) {
      expect(leaks(written)).toEqual([]);
      const line = written.map((l) => JSON.parse(l)).find((p) => p.err);
      expect(line.err).toMatchObject({ code: '23505', message: 'database query failed (23505)' });
      expect(line.err).not.toHaveProperty('params');
    }
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
      'headers',
      '*.headers',
      '["set-cookie"]',
      'authorization',
      'token',
      '*.token',
      'body',
    ]) {
      expect(REDACT_PATHS).toContain(path);
    }
  });

  test('the error serializer never throws and never changes what it was given', () => {
    const plain = { code: 'X', query: 'select 1' };
    for (const value of [
      'boom',
      42,
      null,
      undefined,
      new Error('x', { cause: 'text' }),
      new Error('x', { cause: 42 }),
      new Error('x', { cause: null }),
      plain,
    ]) {
      expect(() => serialiseError(value), String(value)).not.toThrow();
    }
    expect(serialiseError('boom')).toBe('boom');
    expect(serialiseError(null)).toBeNull();
    expect(serialiseError(plain)).toBe(plain);
    expect(plain).toEqual({ code: 'X', query: 'select 1' });
    // A primitive cause is left out of the line, as pino does.
    expect((serialiseError(new Error('x', { cause: 'text' })) as { message: string }).message).toBe(
      'x',
    );
  });

  test('a raw pg error keeps its code and loses a message that quotes the input', () => {
    const pgError = Object.assign(
      new Error(`invalid input syntax for type uuid: "${SECRETS.answer}"`),
      {
        severity: 'ERROR',
        code: '22P02',
      },
    );
    const out = serialiseError(pgError) as { message: string; stack: string; code: string };
    expect(out).toMatchObject({ message: 'database query failed (22P02)', code: '22P02' });
    expect(JSON.stringify(out)).not.toContain(SECRETS.answer);
  });
});
