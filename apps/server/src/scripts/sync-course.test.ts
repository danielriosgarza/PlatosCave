import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, expect, test } from 'vitest';
import { syncFromBundle } from './sync-course';

// Nothing listens on port 1: every query through this address fails, so nothing can be written.
const CLOSED = 'postgres://parallax:parallax@127.0.0.1:1/parallax';
const temp = mkdtempSync(join(tmpdir(), 'parallax-sync-course-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
/** Where FsStorage would write: a run that stored an object leaves this folder behind. */
const storage = join(temp, 'objects');
const env = { NODE_ENV: 'test', DATABASE_URL: CLOSED, STORAGE_DIR: storage };
const manifest = { title: 'Reef ecology', public: true, topics: [], files: [] };
const header = {
  format: 1,
  instructor: { email: 'ana.lima@example.org', path: 'instructor.yaml' },
  course: 'reef-ecology',
  manifest,
  options: { overwriteEditor: false, acceptNewIds: false },
};
const line = (value: unknown) => `${typeof value === 'string' ? value : JSON.stringify(value)}\n`;
const STOPPED =
  'sync stopped by an error: ECONNREFUSED; no release was published, and sync is safe to run again';

/** One run in this process: a query on the closed address ends it with exit code 3. */
async function run(bundle: string, environment: NodeJS.ProcessEnv = env) {
  const [out, errors]: [string[], string[]] = [[], []];
  const [input, print] = [Readable.from([Buffer.from(bundle)]), (l: string) => out.push(l)];
  const exit = await syncFromBundle(input, environment, print, (l) => errors.push(l));
  return { exit, out, errors };
}

/** The script as `parallax sync` runs it, with `input` on standard input. */
function script(input: string) {
  // Through node, not the `.bin` shim: Windows cannot spawn the shim directly.
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const file = resolve(import.meta.dirname, 'sync-course.ts');
  const [cwd, environment] = [resolve(import.meta.dirname, '../..'), { ...process.env, ...env }];
  const options = { cwd, input, env: { ...environment, NODE_OPTIONS: '' }, timeout: 50_000 };
  const { status, stdout, stderr } = spawnSync(process.execPath, [tsx, file], options);
  return { status, stdout: String(stdout), stderr: String(stderr) };
}

test('a malformed bundle and a missing DATABASE_URL exit 2 and write nothing', async () => {
  const format = `the bundle is not of format 1, which this server reads: use parallax and a server of one release`;
  // A key is the bundle's text: it reaches the terminal with its control characters shown.
  const odd = { ...manifest, 'x\u001b[2J': 1 };
  const cases: [string, string][] = [
    ['{"format": 1', 'the bundle ends before its header line does'],
    [line('{"format":'), 'the header is not JSON'],
    [line({ ...header, format: 2 }), format],
    [line({ ...header, format: undefined }), format],
    [line({ ...header, manifest: odd }), 'header: manifest.x\\u{1b}[2J: unknown key'],
    [`${line(header)}x`, 'bytes follow the header of a bundle without files'],
  ];
  for (const [bundle, problem] of cases) {
    const malformed = { exit: 2, out: [], errors: [`malformed bundle: ${problem}`] };
    expect(await run(bundle), bundle).toEqual(malformed);
  }
  const noUrl = await run(line(header), { NODE_ENV: 'test', STORAGE_DIR: storage });
  expect(noUrl).toEqual({ exit: 2, out: [], errors: ['DATABASE_URL is required'] });
  // A title PostgreSQL cannot store is refused before the course would be created with it.
  const title = line({ ...header, manifest: { ...manifest, title: 'Reef\u0000ecology' } });
  const nul = 'course.yaml: title: The text holds a NUL or an unpaired surrogate';
  expect(await run(title)).toEqual({ exit: 1, out: [nul], errors: [] });
  expect(existsSync(storage)).toBe(false);
});

test('an error that ends the run exits 3 and names only its code, and the script exits with the run’s code', async () => {
  expect(await run(line(header))).toEqual({ exit: 3, out: [], errors: [STOPPED] });
  const malformed = 'malformed bundle: the header is not JSON\n';
  expect(script(line('{'))).toEqual({ status: 2, stdout: '', stderr: malformed });
  expect(script(line(header))).toEqual({ status: 3, stdout: '', stderr: `${STOPPED}\n` });
}, 120_000);
