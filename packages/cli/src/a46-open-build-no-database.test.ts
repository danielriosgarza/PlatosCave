import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { main } from './main';
import { buildOpenSite } from './open/build';
import type { ShellCompiler } from './open/shell';
import { buildUnderGuard, printing } from './open/testing';
import { loadSource, type Source, sourceRoot } from './paths';
import { loadSite } from './site/load';

delete process.env.DATABASE_URL;
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a46-open-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const root = join(temp, 'school');
fs.cpSync(resolve(import.meta.dirname, '../fixtures/open-site/school'), root, { recursive: true });
const { openCatalogue, openCourse, openResource, openTopic } = await loadSource<
  typeof import('@parallax/contracts')
>('contracts', 'src/index.ts');

let built: ReturnType<typeof buildUnderGuard> | undefined;
/** The school fixture built at level 0, once, from a process that has a database's variables. */
function build() {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://db.invalid/parallax',
    PGHOST: 'db.invalid',
  });
  try {
    built ??= buildUnderGuard(root);
    return built;
  } finally {
    delete process.env.DATABASE_URL;
    delete process.env.PGHOST;
  }
}

test('A46 the same folder builds at level 1 and at level 0, where only level differs', async () => {
  const file = join(root, 'parallax.config.ts');
  const config = fs.readFileSync(file, 'utf8');
  const level1 = config.replace('level: 0', 'level: 1');
  expect(level1).not.toBe(config);
  fs.writeFileSync(file, level1);
  const run = await printing(async () => [
    await main(['build'], { cwd: root }),
    await main(['check'], { cwd: root }),
  ]);
  expect([run.result, fs.existsSync(join(root, 'dist/index.html'))]).toEqual([[0, 0], true]);
  fs.writeFileSync(file, config);
  // The level 0 build replaces what the level 1 build placed.
  const { status, error } = build();
  expect([status, error, fs.readdirSync(join(root, 'dist'))]).toEqual([
    0,
    undefined,
    ['content', 'site'],
  ]);
}, 600_000);

test('A46 a level 0 build runs with DATABASE_URL unset, loads no database module and holds no account, attempt or grade', () => {
  const { status, error, database, files } = build();
  // The imports of open/build.ts followed to the end: relative specifiers, type-only imports, the
  // sources loaded through paths.ts, the contracts and the worker entries of conversion.
  const [reached, packages] = [new Set<string>(), new Set<string>()];
  const isFile = (path: string) => fs.statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  const follow = (file: string) => {
    if (reached.has(file)) return;
    reached.add(file);
    const code = fs.readFileSync(file, 'utf8');
    for (const [, name, path = ''] of code.matchAll(
      /loadSource(?:<[^>]*>)?\(\s*'(\w+)',\s*'([^']+)'/g,
    ))
      follow(join(sourceRoot(name as Source), path));
    for (const [, spec = ''] of code.matchAll(/(?:from|import|new URL)\s*\(?\s*['"]([^'"]+)/g)) {
      const base = spec.startsWith('.') ? resolve(dirname(file), spec) : '';
      const target = base && [`${base}.ts`, join(base, 'index.ts'), base].find(isFile);
      if (base && !target) throw new Error(`${file} imports ${spec}, which is no file`);
      if (target) follow(target);
      else if (spec === '@parallax/contracts')
        follow(join(sourceRoot('contracts'), 'src/index.ts'));
      else packages.add(spec);
    }
  };
  follow(join(import.meta.dirname, 'open/build.ts'));
  const repo = resolve(import.meta.dirname, '../../..');
  const paths = [...reached].map((file) => relative(repo, file).replaceAll('\\', '/'));
  const needed = [
    'packages/contracts/src/openSite.ts',
    'apps/server/src/content/validation.ts',
    'apps/server/src/content/reading.worker.mjs',
  ];
  expect({
    child: [status, error, database],
    missed: needed.filter((path) => !paths.includes(path)),
    database: paths.filter((path) => /\/(db|auth)\//.test(path)),
    drivers: [...packages].filter((name) =>
      /^(pg|pg-boss|drizzle-orm|@parallax\/server)(\/|$)/.test(name),
    ),
  }).toEqual({ child: [0, undefined, []], missed: [], database: [], drivers: [] });

  // Every key of every data file, at every level, is one its schema declares: the parse refuses a
  // key that a strict level does not name and drops one inside a notebook.
  const data = [...files].filter(([path]) => /^dist\/site\/.*\.json$/.test(path));
  const schemas: Record<string, { parse(value: unknown): unknown }> = {
    'catalogue.json': openCatalogue,
    'course.json': openCourse,
    'topic.json': openTopic,
  };
  const reparsed = data.filter(([path, bytes]) => {
    const schema = schemas[path.split('/').at(-1) ?? ''] ?? openResource;
    return JSON.stringify(schema.parse(JSON.parse(String(bytes)))) !== String(bytes);
  });
  const keys = (value: unknown): string[] =>
    typeof value !== 'object' || value === null
      ? []
      : Object.entries(value).flatMap(([key, inner]) => [
          ...(Array.isArray(value) ? [] : [key]),
          ...keys(inner),
        ]);
  const all = new Set(data.flatMap(([, bytes]) => keys(JSON.parse(String(bytes)))));
  const personal = [...all].filter((key) =>
    /account|user|email|attempt|grade|score|submission|member|class|session|token/i.test(key),
  );
  expect([data.length, reparsed, personal]).toEqual([18, [], []]);

  // The catalogue holds names, titles and references; no file holds an instructor's address.
  expect(JSON.parse(String(files.get('dist/site/courses/catalogue.json')))).toEqual({
    mode: 'school',
    instructors: [
      { name: 'Ana Lima', courses: [{ ref: 'ana/reef-ecology', title: 'Reef ecology' }] },
      { name: 'Bao Tran', courses: [{ ref: 'bao/tide-pools', title: 'Tide pools' }] },
    ],
  });
  const addresses = ['ana.lima@example.org', 'bao.tran@example.org'];
  const holding = [...files].filter(([, bytes]) => addresses.some((at) => bytes.includes(at)));
  expect([files.size > 60, holding.map(([path]) => path)]).toEqual([true, []]);
}, 300_000);

test('a stop of a level 0 build prints each line of its message, control characters as escapes', async () => {
  const copy = join(temp, 'stopped');
  fs.cpSync(resolve(import.meta.dirname, '../fixtures/open-site/school'), copy, {
    recursive: true,
  });
  // No course; the shell writes a data file whose schema fails with a message of three lines, one
  // of them with course text that holds a bell and a line separator.
  const schema = {
    parse() {
      throw new Error('first line\n“Reef\u0007 crest”\u2028\nthird line');
    },
  };
  const shell: ShellCompiler = async (_, out) => out.data('courses/x.json', schema, {});
  const site = { ...(await loadSite(copy)), instructors: [] };
  expect(await printing(() => buildOpenSite(site, { shell }))).toEqual({
    result: 1,
    lines: [
      'courses/x.json does not pass its schema: Error: first line',
      '“Reef\\u{7} crest”\\u{2028}',
      'third line',
      'parallax build: dist/ is as it was.',
    ],
  });
});
