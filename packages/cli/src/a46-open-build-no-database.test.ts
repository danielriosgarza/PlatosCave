import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { main } from './main';
import { buildUnderGuard, printing } from './open/testing';
import { loadSource, type Source, sourceRoot } from './paths';

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
  fs.writeFileSync(file, config.replace('level: 0', 'level: 1'));
  const level1 = await printing(async () => [
    await main(['build'], { cwd: root }),
    await main(['check'], { cwd: root }),
  ]);
  expect([level1.result, fs.existsSync(join(root, 'dist/index.html'))]).toEqual([[0, 0], true]);
  fs.writeFileSync(file, config);
  // The level 0 build replaces what the level 1 build placed.
  expect([build().status, fs.readdirSync(join(root, 'dist'))]).toEqual([0, ['content', 'site']]);
}, 600_000);

test('A46 a level 0 build runs with DATABASE_URL unset, loads no database module and holds no account, attempt or grade', () => {
  const { status, database, files } = build();
  // The imports of open/build.ts followed to the end: relative specifiers, type-only imports, the
  // sources loaded through paths.ts, the contracts and the worker entries of conversion.
  const [reached, packages] = [new Set<string>(), new Set<string>()];
  const isFile = (path: string) => fs.statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  const follow = (file: string) => {
    if (reached.has(file)) return;
    reached.add(file);
    const code = fs.readFileSync(file, 'utf8');
    for (const [, name, path = ''] of code.matchAll(/loadSource<[^>]*>\(\s*'(\w+)',\s*'([^']+)'/g))
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
    'apps/server/src/content/reading.worker.mjs',
  ];
  expect({
    child: [status, database],
    missed: needed.filter((path) => !paths.includes(path)),
    database: paths.filter((path) => /\/(db|auth)\//.test(path)),
    drivers: [...packages].filter((name) => /^(pg|drizzle-orm|@parallax\/server)(\/|$)/.test(name)),
  }).toEqual({ child: [0, []], missed: [], database: [], drivers: [] });

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
