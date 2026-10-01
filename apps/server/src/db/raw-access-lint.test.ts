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
  overrides?: {
    includes?: string[];
    plugins?: (string | { path: string })[];
    linter?: { rules?: { style?: { noRestrictedImports?: unknown } } };
  }[];
};
// The server override is the one that includes the server source tree, so a later override for
// another app that uses the same rule cannot be mistaken for it.
const override = (config.overrides ?? []).find((o) => o.includes?.includes('apps/server/src/**'));
const plugins = (override?.plugins ?? []).map((p) => (typeof p === 'string' ? p : p.path));
const fixture = readFileSync(join(root, 'apps/server/test/lint/raw-db-access.fixture.ts'), 'utf8');

const restricted = [
  'apps/server/src/http/routes/fixture.routes.ts',
  'apps/server/src/http/register-fixture.ts',
  'apps/server/src/annotations/fixture.ts',
  'apps/server/src/auth/fixture.ts',
  'apps/server/src/content/fixture.ts',
  'apps/server/src/storage/fixture.ts',
];
const exempt = [
  'apps/server/src/db/fixture.ts',
  'apps/server/src/db/schema/fixture.ts',
  'apps/server/src/content/drafts.ts',
  'apps/server/src/auth/scope.ts',
  'apps/server/src/storage/objects.ts',
  'apps/server/src/main.ts',
  'apps/server/src/http/routes/fixture.routes.test.ts',
];

function markedLines(marker: string): number[] {
  return fixture
    .split('\n')
    .flatMap((line, i) => (line.trimEnd().endsWith(`// ${marker}`) ? [i + 1] : []));
}

// Lines marked `known-false-positive` document a limit of the rule; the tests accept either
// outcome there, so a more precise rule may stop flagging them.
const unasserted = new Set(markedLines('known-false-positive'));

interface Diagnostic {
  category: string;
  location: { path: string; start: { line: number } };
}

let scratch: string | undefined;
let diagnostics: Diagnostic[] = [];

// One biome run lints every copy of the fixture; the tests partition its diagnostics by path.
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'parallax-lint-'));
  cpSync(join(root, 'biome.json'), join(scratch, 'biome.json'));
  for (const plugin of plugins) {
    mkdirSync(dirname(join(scratch, plugin)), { recursive: true });
    cpSync(join(root, plugin), join(scratch, plugin));
  }
  for (const path of [...restricted, ...exempt]) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), fixture);
  }
  const run = spawnSync(biome, ['lint', '--vcs-enabled=false', '--reporter=json', 'apps'], {
    cwd: scratch,
    encoding: 'utf8',
  });
  if (run.error || !run.stdout) {
    throw new Error(`biome did not run: ${run.error?.message ?? run.stderr}`);
  }
  diagnostics = (JSON.parse(run.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function lintAt(path: string): { imports: number[]; queries: number[] } {
  const lines = (category: string) =>
    diagnostics
      .filter((d) => d.category === category && d.location.path === path)
      .filter((d) => !unasserted.has(d.location.start.line))
      .map((d) => d.location.start.line)
      .sort((a, b) => a - b);
  return { imports: lines('lint/style/noRestrictedImports'), queries: lines('plugin') };
}

test('biome.json declares the import rule and the query plugin in one override', () => {
  expect(override?.includes).toContain('apps/server/src/**');
  expect(plugins).toEqual(['./apps/server/lint/raw-db-query.grit']);
  expect(override?.linter?.rules?.style?.noRestrictedImports).toBeDefined();
});

test('the fixture marks restricted imports and raw queries', () => {
  expect(markedLines('restricted-import')).toHaveLength(7);
  expect(markedLines('raw-query')).toHaveLength(24);
  expect(markedLines('known-false-positive')).toHaveLength(1);
});

test.each(restricted)('raw database access is a lint error in feature module %s', (path) => {
  expect(lintAt(path)).toEqual({
    imports: markedLines('restricted-import'),
    queries: markedLines('raw-query'),
  });
});

test.each(exempt)(
  'data-access files, the composition root and tests may use the database: %s',
  (path) => {
    expect(lintAt(path)).toEqual({ imports: [], queries: [] });
  },
);
