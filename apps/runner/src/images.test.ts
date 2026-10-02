import { describe, expect, test } from 'vitest';
import { RunnerFailure } from './failure';
import { ImageAllowlist, type ImageDaemon } from './images';

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const NEW = `ghcr.io/org/parallax-runner-python@sha256:${'a'.repeat(64)}`;
const OLD = `ghcr.io/org/parallax-runner-python@sha256:${'9'.repeat(64)}`;

/** A daemon holding a fixed set of images; records inspections and pulls. */
function fakeDaemon(images: Record<string, { Id: string; RepoDigests?: string[] }>) {
  const calls = { inspect: [] as string[], pull: [] as string[] };
  const store = { ...images };
  const daemon: ImageDaemon = {
    async inspect(ref) {
      calls.inspect.push(ref);
      return store[ref] ?? null;
    },
    async pull(ref) {
      calls.pull.push(ref);
      store[ref] = { Id: sha('p'), RepoDigests: [] };
    },
  };
  return { daemon, calls, store };
}

const production = {
  [NEW]: { Id: sha('1'), RepoDigests: [NEW] },
  [OLD]: { Id: sha('2'), RepoDigests: [OLD] },
};

async function failureOf(promise: Promise<unknown>): Promise<RunnerFailure> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof RunnerFailure)) throw new Error('expected a RunnerFailure');
  return error;
}

describe('image allowlist (design §6.4)', () => {
  test('a job without runtime.image runs on the first reference', async () => {
    const { daemon } = fakeDaemon(production);
    const list = new ImageAllowlist({ 'python-3.12': [NEW, OLD] }, daemon, 'never');
    await list.resolveAll();
    expect(await list.resolve({ id: 'python-3.12', language: 'python' })).toEqual({
      ref: NEW,
      id: sha('1'),
      digest: NEW,
    });
  });

  test('a replay matches by reference, by id and by repository digest', async () => {
    const { daemon } = fakeDaemon(production);
    const list = new ImageAllowlist({ 'python-3.12': [NEW, OLD] }, daemon, 'never');
    await list.resolveAll();
    const runtime = { id: 'python-3.12', language: 'python' as const };
    expect(await list.resolve({ ...runtime, image: OLD })).toMatchObject({ id: sha('2') });
    expect(await list.resolve({ ...runtime, image: sha('2') })).toEqual({
      ref: OLD,
      id: sha('2'),
      digest: OLD,
    });
  });

  test('a development tag is matched by its image id; a rebuilt tag is not allowed', async () => {
    const { daemon, store } = fakeDaemon({ 'parallax-runner-python:dev': { Id: sha('d') } });
    const list = new ImageAllowlist(
      { 'python-3.12': ['parallax-runner-python:dev'] },
      daemon,
      'missing',
    );
    const runtime = { id: 'python-3.12', language: 'python' as const };
    expect(await list.resolve({ ...runtime, image: sha('d') })).toEqual({
      ref: 'parallax-runner-python:dev',
      id: sha('d'),
      digest: null,
    });
    store['parallax-runner-python:dev'] = { Id: sha('e') };
    const failure = await failureOf(list.resolve({ ...runtime, image: sha('d') }));
    expect(failure.kind).toBe('image_not_allowed');
    expect(failure.terminal).toBe(true);
  });

  test('an unknown pinned image re-inspects the allowlist before refusing', async () => {
    const { daemon, calls } = fakeDaemon(production);
    const list = new ImageAllowlist({ 'python-3.12': [NEW] }, daemon, 'never');
    await list.resolveAll();
    const before = calls.inspect.length;
    const failure = await failureOf(
      list.resolve({ id: 'python-3.12', language: 'python', image: OLD }),
    );
    expect(failure.kind).toBe('image_not_allowed');
    expect(calls.inspect.length).toBeGreaterThan(before);
  });

  test('a runtime without an allowlist entry is not allowed', async () => {
    const { daemon } = fakeDaemon(production);
    const list = new ImageAllowlist({ 'python-3.12': [NEW] }, daemon, 'never');
    const failure = await failureOf(list.resolve({ id: 'r-4.6', language: 'r' }));
    expect(failure.kind).toBe('image_not_allowed');
  });

  test('RUNNER_PULL=never makes a missing image unavailable, never a pull', async () => {
    const { daemon, calls } = fakeDaemon({});
    const list = new ImageAllowlist({ 'python-3.12': [NEW] }, daemon, 'never');
    const failure = await failureOf(list.resolve({ id: 'python-3.12', language: 'python' }));
    expect(failure.kind).toBe('image_unavailable');
    expect(failure.terminal).toBe(false);
    expect(calls.pull).toEqual([]);
  });

  test('a replay pinned to an allowlisted image absent from the host is image_unavailable', async () => {
    const runtime = { id: 'python-3.12', language: 'python' as const };
    // The pinned digest reference itself is missing.
    const { daemon } = fakeDaemon({ [NEW]: { Id: sha('1'), RepoDigests: [NEW] } });
    const list = new ImageAllowlist({ 'python-3.12': [NEW, OLD] }, daemon, 'never');
    const byRef = await failureOf(list.resolve({ ...runtime, image: OLD }));
    expect(byRef.kind).toBe('image_unavailable');
    expect(byRef.terminal).toBe(false);
    // A pin by image id cannot be compared with a missing reference.
    const byId = await failureOf(list.resolve({ ...runtime, image: sha('2') }));
    expect(byId.kind).toBe('image_unavailable');
    // A missing tag may be the pinned image too.
    const tag = fakeDaemon({});
    const dev = new ImageAllowlist(
      { 'python-3.12': ['parallax-runner-python:dev'] },
      tag.daemon,
      'never',
    );
    expect((await failureOf(dev.resolve({ ...runtime, image: sha('d') }))).kind).toBe(
      'image_unavailable',
    );
  });

  test('a replay pinned to an image no allowlisted reference names stays image_not_allowed', async () => {
    const runtime = { id: 'python-3.12', language: 'python' as const };
    const other = `ghcr.io/org/parallax-runner-python@sha256:${'7'.repeat(64)}`;
    // Even with an allowlisted digest reference missing: digest references name only themselves.
    const { daemon } = fakeDaemon({ [NEW]: { Id: sha('1'), RepoDigests: [NEW] } });
    const list = new ImageAllowlist({ 'python-3.12': [NEW, OLD] }, daemon, 'never');
    const failure = await failureOf(list.resolve({ ...runtime, image: other }));
    expect(failure.kind).toBe('image_not_allowed');
    expect(failure.terminal).toBe(true);
  });

  test('RUNNER_PULL=missing pulls a missing image', async () => {
    const { daemon, calls } = fakeDaemon({});
    const list = new ImageAllowlist({ 'python-3.12': [NEW] }, daemon, 'missing');
    expect(await list.resolve({ id: 'python-3.12', language: 'python' })).toMatchObject({
      id: sha('p'),
    });
    expect(calls.pull).toEqual([NEW]);
  });

  test('a daemon error is a retried infrastructure failure', async () => {
    const daemon: ImageDaemon = {
      inspect: async () => {
        throw new Error('connect ENOENT /var/run/docker.sock');
      },
      pull: async () => undefined,
    };
    const list = new ImageAllowlist({ 'python-3.12': [NEW] }, daemon, 'never');
    const failure = await failureOf(list.resolve({ id: 'python-3.12', language: 'python' }));
    expect(failure.kind).toBe('daemon_unreachable');
    expect(failure.terminal).toBe(false);
    const replay = await failureOf(
      list.resolve({ id: 'python-3.12', language: 'python', image: sha('1') }),
    );
    expect(replay.kind).toBe('daemon_unreachable');
  });
});
