import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.local', 'coverage']);
const ID = /\bA(0[1-9]|[12][0-9]|3[0-6])\b/g;
const GO_TEST = /^func Test(A(?:0[1-9]|[12][0-9]|3[0-6]))(?![0-9A-Za-z])/gm;
const TEST_FNS = new Set(['test', 'it', 'describe']);
// Modifiers that still name a test or group; others (`step`, `use`, `beforeEach`, …) are not titles.
const MODIFIERS = new Set([
  'only',
  'concurrent',
  'sequential',
  'fails',
  'skip',
  'todo',
  'fixme',
  'each',
  'for',
  'skipIf',
  'runIf',
  'describe',
  'serial',
  'parallel',
]);
// Modifiers whose own arguments come before the title's call: test.each(table)('title', fn).
const CURRIED = new Set(['each', 'for', 'skipIf', 'runIf']);
const SKIPPED = new Set(['skip', 'todo', 'fixme']);
// The documented gates of ADR-0006 that keep a block running in CI, where they are mandatory:
// `skipIf(!imagePresent)`, `skipIf(!env.S3_ENDPOINT)`, `runIf(env.CI)`, and `*.docker.*` files.
const GATE = /docker|imagePresent|S3_ENDPOINT|\bCI\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const isTestFile = (path: string): boolean =>
  /\.(test|itest|e2e)\.tsx?$/.test(path) || /^connector\/.*_test\.go$/.test(path);

const addId = (found: Map<string, Set<string>>, id: string, file: string): void => {
  if (!found.has(id)) found.set(id, new Set());
  found.get(id)?.add(file);
};

interface Modifier {
  name: string;
  args: string;
}

/**
 * Reads `test`, `it`, `describe` (or a `test.extend` alias) with a chain of modifiers, including
 * curried ones: `test.each(table)`, `describe.skipIf(cond)`, ``test.each`…` ``. Null for anything else.
 */
function parseCallee(node: ts.Expression, names: Set<string>): Modifier[] | null {
  if (ts.isIdentifier(node)) return names.has(node.text) ? [] : null;
  if (ts.isPropertyAccessExpression(node)) {
    const base = parseCallee(node.expression, names);
    return base && MODIFIERS.has(node.name.text)
      ? [...base, { name: node.name.text, args: '' }]
      : null;
  }
  const curried = ts.isCallExpression(node)
    ? node.expression
    : ts.isTaggedTemplateExpression(node)
      ? node.tag
      : null;
  if (!curried) return null;
  const base = parseCallee(curried, names);
  const last = base?.at(-1);
  if (!base || !last || !CURRIED.has(last.name)) return null;
  const args = ts.isCallExpression(node) ? node.arguments.map((a) => a.getText()).join(',') : '';
  return [...base.slice(0, -1), { name: last.name, args }];
}

function isSkipped(mods: Modifier[], file: string): boolean {
  const dockerFile = file.includes('.docker.');
  return mods.some(({ name, args }) => {
    if (SKIPPED.has(name)) return true;
    if (name === 'skipIf')
      return !(dockerFile || (args.trimStart().startsWith('!') && GATE.test(args)));
    if (name === 'runIf')
      return !(dockerFile || (!args.trimStart().startsWith('!') && GATE.test(args)));
    return false;
  });
}

/** The literal text of a title: strings, plain templates, and the fixed parts of `${…}` templates. */
function titleText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => ` ${span.literal.text}`).join('');
  }
  return null;
}

/**
 * Scenario IDs in the titles of non-skipped TS tests (`test`, `it`, `describe`). Titles built at
 * runtime (`test(row.name, …)`) are invisible: put the ID in a literal part of the title.
 */
export function idsInTsTitles(source: string, file = 'fixture.test.tsx'): string[] {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  // `const myTest = test.extend(…)` makes `myTest` a test function too.
  const names = new Set(TEST_FNS);
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isPropertyAccessExpression(node.initializer.expression) &&
      node.initializer.expression.name.text === 'extend' &&
      ts.isIdentifier(node.initializer.expression.expression) &&
      names.has(node.initializer.expression.expression.text)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const mods = parseCallee(node.expression, names);
      const last = mods?.at(-1);
      const curriedCallee =
        ts.isCallExpression(node.expression) || ts.isTaggedTemplateExpression(node.expression);
      // `describe.skipIf(cond)` and `test.each(table)` are the first half of a curried call, not titles.
      if (mods && (curriedCallee || !(last && CURRIED.has(last.name)))) {
        if (isSkipped(mods, file)) return;
        const title = node.arguments[0];
        const text = title && titleText(title);
        if (text) for (const id of text.matchAll(ID)) ids.push(id[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ids;
}

/** Scenario IDs in Go test function names (`func TestA28_Name`). */
export function idsInGoTests(source: string): string[] {
  return [
    ...source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).matchAll(GO_TEST),
  ].map((m) => m[1] as string);
}

/** Maps each scenario ID found in a test title to the files carrying it. */
export function findTests(
  files: string[],
  read: (file: string) => string = (f) => readFileSync(join(root, f), 'utf8'),
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of files.filter(isTestFile)) {
    const text = read(file);
    const ids = file.endsWith('.go') ? idsInGoTests(text) : idsInTsTitles(text, file);
    for (const id of ids) addId(found, id, file);
  }
  return found;
}

/** IDs listed in docs/delivery/done/*.txt, one per line, with every file that lists them. */
export function readDone(dir: string): Map<string, string[]> {
  const done = new Map<string, string[]>();
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.txt'))
    .sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      const id = line.trim();
      if (!id) continue;
      const files = done.get(id);
      if (files) files.push(name);
      else done.set(id, [name]);
    }
  }
  return done;
}

export function main(): number {
  const files = walk(root).map((p) => relative(root, p));
  const found = findTests(files);
  const done = readDone(join(root, 'docs/delivery/done'));

  console.log('scenario  test files');
  for (const id of [...found.keys()].sort()) {
    console.log(`${id.padEnd(9)} ${[...(found.get(id) ?? [])].sort().join(', ')}`);
  }
  const missing = [...done].filter(([id]) => !found.has(id));
  for (const [id, sources] of missing) {
    for (const source of sources) {
      console.error(`${id} is listed in docs/delivery/done/${source} but has no test`);
    }
  }
  console.log(`${found.size} scenarios with tests, ${done.size} recorded done`);
  return missing.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
