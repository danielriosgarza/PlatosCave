import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { runInThread, ThreadInputError } from './thread';

const fixture = (name: string) => new URL(`../../test/fixtures/threads/${name}`, import.meta.url);
const messages = { failed: 'refused', timeout: 'too slow', outOfMemory: 'too big' };
const bounds = { timeoutMs: 10_000, maxHeapMb: 32 };

const failure = (script: string, options: Partial<typeof bounds> = {}) =>
  runInThread(fixture(script), new Uint8Array(4), messages, { ...bounds, ...options }).catch(
    (err: unknown) => err,
  );

describe('runInThread', () => {
  test('returns the value the script answers', async () => {
    expect(await runInThread(fixture('echo.mjs'), new Uint8Array(7), messages, bounds)).toBe(7);
  });

  test('moves transferred buffers into the thread instead of copying them', async () => {
    const data = new Uint8Array(1024);
    const length = await runInThread(fixture('echo.mjs'), data, messages, {
      ...bounds,
      transferList: [data.buffer],
    });
    expect(length).toBe(1024);
    expect(data.byteLength).toBe(0);
  });

  test('the script refusing its input, the heap cap and the time bound are final', async () => {
    expect(await failure('refuses.mjs')).toEqual(new ThreadInputError('refused'));
    expect(await failure('slow.mjs', { timeoutMs: 200 })).toEqual(new ThreadInputError('too slow'));
  });

  test('a thread that reaches its heap cap fails as final', async () => {
    // In a child process without NODE_OPTIONS: a process-wide --max-old-space-size (set in some
    // shells) overrides every thread's heap cap.
    const serverDir = resolve(import.meta.dirname, '../..');
    const { stdout } = await promisify(execFile)(
      resolve(serverDir, 'node_modules/.bin/tsx'),
      ['test/fixtures/threads/oom-probe.ts'],
      { cwd: serverDir, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 },
    );
    expect(stdout.trim()).toBe('final: too big');
  }, 40_000);

  test('a thread that cannot load or exits without answering is retried, not final', async () => {
    for (const script of ['broken-import.mjs', 'silent.mjs']) {
      const err = await failure(script);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ThreadInputError);
    }
  });

  test('an abort stops the thread and is not a problem with the input', async () => {
    const controller = new AbortController();
    const pending = runInThread(fixture('slow.mjs'), null, messages, {
      ...bounds,
      signal: controller.signal,
    }).catch((err: unknown) => err);
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ThreadInputError);
  });
});
