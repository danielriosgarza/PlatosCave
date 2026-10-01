import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

// ADR-0002, Scoped tables: outside the data-access modules, server code may not import query
// builders, tables or the client constructor, nor build queries on the injected `db` handle.
// The fixture is linted with the repository's biome.json at several paths in a scratch copy.

const root = resolve(import.meta.dirname, '../../../..');
const biome = join(root, 'node_modules/.bin/biome');
const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8')) as {
  plugins: (string | { path: string; includes?: string[] })[];
  overrides: { includes?: string[] }[];
};
const plugins = config.plugins.map((p) => (typeof p === 'string' ? { path: p } : p));
const fixture = readFileSync(join(root, 'apps/server/test/lint/raw-db-access.fixture.ts'), 'utf8');

function markedLines(marker: string): number[] {
  return fixture
    .split('\n')
    .flatMap((line, i) => (line.trimEnd().endsWith(`// ${marker}`) ? [i + 1] : []));
}

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'parallax-lint-'));
  cpSync(join(root, 'biome.json'), join(scratch, 'biome.json'));
  for (const plugin of plugins) {
    mkdirSync(dirname(join(scratch, plugin.path)), { recursive: true });
    cpSync(join(root, plugin.path), join(scratch, plugin.path));
  }
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Diagnostic {
  category: string;
  location: { path: string; start: { line: number } };
}

function lintAt(path: string): { imports: number[]; queries: number[] } {
  mkdirSync(dirname(join(scratch, path)), { recursive: true });
  writeFileSync(join(scratch, path), fixture);
  const run = spawnSync(biome, ['lint', '--vcs-enabled=false', '--reporter=json', path], {
    cwd: scratch,
    encoding: 'utf8',
  });
  if (run.error || !run.stdout) {
    throw new Error(`biome did not run: ${run.error?.message ?? run.stderr}`);
  }
  const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] };
  const lines = (category: string) =>
    diagnostics
      .filter((d) => d.category === category && d.location.path === path)
      .map((d) => d.location.start.line)
      .sort((a, b) => a - b);
  return { imports: lines('lint/style/noRestrictedImports'), queries: lines('plugin') };
}

test('the fixture marks restricted imports and raw queries', () => {
  expect(markedLines('restricted-import')).toHaveLength(7);
  expect(markedLines('raw-query')).toHaveLength(8);
});

test('the import rule and the query plugin exempt the same files', () => {
  // Plugin includes are matched against absolute paths, hence their `**/` prefix.
  const plugin = plugins.find((p) => p.path.endsWith('raw-db-query.grit'))?.includes ?? [];
  const override = config.overrides.find((o) =>
    JSON.stringify(o).includes('noRestrictedImports'),
  )?.includes;
  expect(plugin.map((glob) => glob.replace(/^(!?)\*\*\/(?=apps\/)/, '$1'))).toEqual(override);
});

test.each([
  'apps/server/src/http/routes/fixture.routes.ts',
  'apps/server/src/http/register-fixture.ts',
  'apps/server/src/annotations/fixture.ts',
  'apps/server/src/auth/fixture.ts',
  'apps/server/src/content/fixture.ts',
  'apps/server/src/storage/fixture.ts',
])('raw database access is a lint error in feature module %s', (path) => {
  expect(lintAt(path)).toEqual({
    imports: markedLines('restricted-import'),
    queries: markedLines('raw-query'),
  });
});

test.each([
  'apps/server/src/db/fixture.ts',
  'apps/server/src/db/schema/fixture.ts',
  'apps/server/src/content/drafts.ts',
  'apps/server/src/auth/scope.ts',
  'apps/server/src/storage/objects.ts',
  'apps/server/src/main.ts',
  'apps/server/src/http/routes/fixture.routes.test.ts',
])('data-access files, the composition root and tests may use the database: %s', (path) => {
  expect(lintAt(path)).toEqual({ imports: [], queries: [] });
});
