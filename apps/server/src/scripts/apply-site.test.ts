import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { applySite, stopLine } from './apply-site';

const fixture = readFileSync(
  new URL('../../test/fixtures/site-setup.json', import.meta.url),
  'utf8',
);
const doc = JSON.parse(fixture);
const [ana, ben] = doc.instructors;
const [spring] = doc.classes;
const edit = (patch: object) => JSON.stringify({ ...doc, ...patch });
// Nothing listens on port 1: every query through this address fails, so nothing can be written.
const CLOSED = 'postgres://parallax:parallax@127.0.0.1:1/parallax';
const TWICE = edit({ instructors: [ana, { ...ben, email: ana.email.toUpperCase() }] });

/** One run in this process; it rejects if it made a query. */
async function run(input: string, url: string | undefined) {
  const [out, errors]: [string[], string[]] = [[], []];
  const print = (line: string) => out.push(line);
  const exit = await applySite(input, url, print, (line) => errors.push(line));
  return { exit, out, errors };
}

/** The script as `parallax apply` runs it, with `input` on standard input. */
function script(input: string) {
  const serverDir = resolve(import.meta.dirname, '../..');
  // Through node, not the `.bin` shim: Windows cannot spawn the shim directly.
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [tsx, resolve(import.meta.dirname, 'apply-site.ts')],
    {
      cwd: serverDir,
      input,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, DATABASE_URL: CLOSED, NODE_OPTIONS: '' },
    },
  );
  return { status, stdout, stderr };
}

test('a malformed document exits 2 and changes nothing', async () => {
  const cases: [string, string][] = [
    ['', 'the setup document is not JSON'],
    [`{"instructors": [{"email": "${ana.email}"`, 'the setup document is not JSON'],
    ['null', 'setup document: Invalid input: expected object, received null'],
    [edit({ code: 'ABCDE-FGHJK' }), 'setup document: code: unknown key'],
    [TWICE, 'setup document: instructors[1].email: an address listed twice'],
    [
      edit({ instructors: [{ ...ana, email: 'ana' }, ben] }),
      'setup document: instructors[0].email: Invalid email address',
    ],
    [
      edit({ classes: [{ ...spring, instructors: ['ana', 'carl'] }] }),
      'setup document: classes[0].instructors[1]: carl is not in instructors',
    ],
  ];
  for (const [input, line] of cases) {
    // A query on the closed address would reject the run: exit 2 means it made none.
    expect(await run(input, CLOSED), input).toEqual({ exit: 2, out: [], errors: [line] });
  }
  expect(await run(fixture, undefined)).toEqual({
    exit: 2,
    out: [],
    errors: ['DATABASE_URL is required'],
  });
});

test('a well-formed document goes to the database, and its error is named without its values', async () => {
  const err = await run(fixture, CLOSED).catch((e: unknown) => e);
  // The failed query's own message holds its parameters, among them the first address.
  expect((err as Error).message).toContain(ana.email);
  expect(stopLine(err)).toBe('apply stopped by an error: ECONNREFUSED');
  expect(stopLine(new TypeError(ana.path))).toBe('apply stopped by an error: TypeError');
});

test('the script exits 2 for a malformed document and 1 for a database error, and prints none of it', () => {
  expect(script(TWICE)).toEqual({
    status: 2,
    stdout: '',
    stderr: 'setup document: instructors[1].email: an address listed twice\n',
  });
  // The failed query's message holds the first address; the line names only the code.
  expect(script(fixture)).toEqual({
    status: 1,
    stdout: '',
    stderr: 'apply stopped by an error: ECONNREFUSED\n',
  });
}, 120_000);
