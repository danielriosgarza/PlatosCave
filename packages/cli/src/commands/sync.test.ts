import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { SyncHeader } from '@parallax/contracts';
import { afterAll, expect, test, vi } from 'vitest';
import { processes } from '../host/compose';
import { main } from '../main';

delete process.env.DATABASE_URL;
const fixture = resolve(import.meta.dirname, '../../fixtures/course');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-sync-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
let sites = 0;
/** A copy of the fixture site with a second course, `atolls`, which the listing gives first. */
function site(change: (root: string) => void = () => {}) {
  const root = join(temp, `site-${sites++}`);
  fs.cpSync(fixture, root, { recursive: true });
  for (const top of ['courses', 'private/courses']) {
    fs.cpSync(join(root, top, 'reef-ecology'), join(root, top, 'atolls'), { recursive: true });
  }
  change(root);
  return root;
}
const root = site();
type Run = { args: string; cwd: string; header: SyncHeader & { format: number }; size: number };

/** `parallax sync` with the process runner replaced, so no Docker: run n exits with `codes[n]`. */
async function sync(args: string[], codes: number[] = [], at = root) {
  const runs: Run[] = [];
  processes.run = async (args, cwd, input) => {
    const bytes = await buffer(input as Readable);
    const end = bytes.indexOf(10);
    const header = JSON.parse(String(bytes.subarray(0, end)));
    runs.push({ args: args.join(' '), cwd, header, size: bytes.length - end - 1 });
    return codes[runs.length - 1] ?? 0;
  };
  const lines: string[] = [];
  const spies = (['log', 'error'] as const).map((name) =>
    vi.spyOn(console, name).mockImplementation((line) => lines.push(line)),
  );
  try {
    return { code: await main(['sync', ...args], { cwd: at }), runs, lines };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}
const courses = ({ runs }: { runs: Run[] }) => runs.map((run) => run.header.course);
const SCRIPT = / run --rm -T server node_modules\/\.bin\/tsx src\/scripts\/sync-course\.ts$/;

test('sync runs the script once per course in the site’s order, with the address in the bundle only, and exits with the highest code', async () => {
  const all = await sync([], [3, 1]);
  expect([all.code, courses(all)]).toEqual([3, ['atolls', 'reef-ecology']]);
  const instructor = { email: 'ana.lima@example.org', path: 'instructor.yaml' };
  for (const run of all.runs) {
    expect(run.cwd).toBe(root);
    expect(run.args).toMatch(SCRIPT);
    expect(run.args).not.toContain('@');
    expect(run.header).toMatchObject({ format: 1, instructor });
    expect(run.size).toBe(run.header.manifest.files.reduce((sum, file) => sum + file.size, 0));
  }
  expect(all.lines).toContain(
    'parallax sync: courses/atolls: exit code 3; the lines above say why',
  );
  // Named in another order, the courses still run in the site's order, each once.
  const named = await sync(['reef-ecology', 'atolls', 'reef-ecology'], [0, 2]);
  expect([named.code, courses(named)]).toEqual([2, ['atolls', 'reef-ecology']]);
});

test('a course named in another case is refused with both spellings, the bundle carries the listed name, and the options reach its header', async () => {
  const refused = await sync(['Reef-Ecology']);
  expect(refused).toMatchObject({ code: 2, runs: [] });
  const both = 'the name on disk is reef-ecology, not Reef-Ecology (case or Unicode form)';
  expect(refused.lines).toContain(`parallax sync: Reef-Ecology: ${both}`);
  const none = 'parallax sync: coral: no course folder of this name in the site';
  expect((await sync(['coral'])).lines).toContain(none);
  expect(courses(await sync(['reef-ecology']))).toEqual(['reef-ecology']);
  const options = async (args: string[]) => (await sync(args)).runs.map((r) => r.header.options);
  const flags = { overwriteEditor: true, acceptNewIds: true };
  expect(await options(['--accept-new-ids', 'atolls', '--overwrite-editor'])).toEqual([flags]);
  expect(await options(['atolls'])).toEqual([{ overwriteEditor: false, acceptNewIds: false }]);
  expect(await sync(['--force'])).toMatchObject({ code: 2, runs: [] });
});

test('a folder error or level 0 stops sync before any run', async () => {
  const overlay = 'private/courses/atolls';
  const drop = (at: string) => fs.rmSync(join(at, overlay), { recursive: true });
  const broken = await sync([], [], site(drop));
  expect(broken).toMatchObject({ code: 1, runs: [] });
  expect(broken.lines).toContain(`${overlay}/sampling/tests/quiz.yaml: no definition here`);
  const level0 = (at: string) => {
    const config = join(at, 'parallax.config.ts');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('level: 1', 'level: 0'));
  };
  expect(await sync([], [], site(level0))).toMatchObject({ code: 2, runs: [] });
});
