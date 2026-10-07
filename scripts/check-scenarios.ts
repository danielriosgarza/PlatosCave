import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
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
// `skipIf(!imagePresent)`, `skipIf(!dockerAvailable())`, `skipIf(!env.S3_ENDPOINT)`,
// `runIf(env.CI)` / `runIf(process.env.CI)`, and `*.docker.*` files. They are matched on the AST of the
// condition, so `skipIf(!fast || process.env.CI)` is not a gate. Anything else counts as skipped.
const SKIP_IF_GATES = new Set([
  'imagePresent',
  'dockerAvailable',
  'env.S3_ENDPOINT',
  'process.env.S3_ENDPOINT',
  'env.CI',
  'process.env.CI',
]);
const RUN_IF_GATES = new Set(['env.CI', 'process.env.CI']);
// Test modules whose exports are test functions: `import { test as base } from '@playwright/test'`.
const TEST_MODULES = new Set(['vitest', '@playwright/test']);

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
  args: readonly ts.Expression[];
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
      ? [...base, { name: node.name.text, args: [] }]
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
  const args = ts.isCallExpression(node) ? [...node.arguments] : [];
  return [...base.slice(0, -1), { name: last.name, args }];
}

/** `(await imagePresent())` → `imagePresent`; `process.env.CI` → `process.env.CI`; null otherwise. */
function gateName(node: ts.Expression): string | null {
  let cur = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAwaitExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
    } else if (ts.isCallExpression(cur) && cur.arguments.length === 0) {
      cur = cur.expression;
    } else break;
  }
  if (ts.isIdentifier(cur)) return cur.text;
  if (ts.isPropertyAccessExpression(cur)) {
    const base = gateName(cur.expression);
    return base && `${base}.${cur.name.text}`;
  }
  return null;
}

/** True for `!<gate>` where the gate is one of `gates`. */
function isNegatedGate(arg: ts.Expression | undefined, gates: Set<string>): boolean {
  if (!arg || !ts.isPrefixUnaryExpression(arg) || arg.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  const name = gateName(arg.operand);
  return name !== null && gates.has(name);
}

function isSkipped(mods: Modifier[], file: string): boolean {
  const dockerFile = file.includes('.docker.');
  return mods.some(({ name, args }) => {
    if (SKIPPED.has(name)) return true;
    if (dockerFile) return false;
    if (name === 'skipIf') return args.length !== 1 || !isNegatedGate(args[0], SKIP_IF_GATES);
    if (name === 'runIf') {
      const name = args.length === 1 && args[0] ? gateName(args[0]) : null;
      return name === null || !RUN_IF_GATES.has(name);
    }
    return false;
  });
}

/**
 * `test.skip()`, `test.skip(true, …)`, `test.fixme()` or `test.fixme(true, …)` as a statement skips
 * the group or test whose body it sits in. A conditional call (`test.skip(browserName === 'x', …)`)
 * only skips at runtime, like Go `t.Skip`; it is not detected and the titles stay counted.
 */
function hasUnconditionalSkip(statements: readonly ts.Statement[], names: Set<string>): boolean {
  return statements.some((stmt) => {
    if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) return false;
    const mods = parseCallee(stmt.expression.expression, names);
    const only = mods?.length === 1 ? mods[0] : undefined;
    if (!only || (only.name !== 'skip' && only.name !== 'fixme')) return false;
    const first = stmt.expression.arguments[0];
    return !first || first.kind === ts.SyntaxKind.TrueKeyword;
  });
}

/**
 * The literal text of a title: strings, plain templates, the fixed parts of `${…}` templates and of
 * `'A05 ' + name` chains. Dynamic parts become a space so neighbouring literals never merge into an ID.
 */
function titleText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return titleText(node.expression);
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => ` ${span.literal.text}`).join('');
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = titleText(node.left);
    const right = titleText(node.right);
    return left === null && right === null ? null : `${left ?? ' '}${right ?? ' '}`;
  }
  return null;
}

/** `test.extend(a).extend(b)` over a known test function. */
function isExtend(node: ts.Expression, names: Set<string>): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const { expression, name } = node.expression;
  if (name.text !== 'extend') return false;
  return (ts.isIdentifier(expression) && names.has(expression.text)) || isExtend(expression, names);
}

function parse(source: string, file: string): ts.SourceFile {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

/** Resolves a relative import to a file of the repository, or null. */
type Resolver = (from: string, specifier: string) => string | null;
type ExportsOf = (file: string) => Set<string>;

/**
 * Names that are test functions in this file: `test`, `it`, `describe`, test functions imported from
 * vitest, Playwright or (through `exportsOf`) another module, and `const x = test.extend(…)` aliases,
 * including chains.
 */
function testNames(sf: ts.SourceFile, resolve?: Resolver, exportsOf?: ExportsOf): Set<string> {
  const names = new Set(TEST_FNS);
  for (const stmt of sf.statements) {
    const bindings = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings) || !ts.isStringLiteral(stmt.moduleSpecifier)) {
      continue;
    }
    const spec = stmt.moduleSpecifier.text;
    const target = spec.startsWith('.') ? (resolve?.(sf.fileName, spec) ?? null) : null;
    const exported = target ? exportsOf?.(target) : undefined;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (TEST_MODULES.has(spec) ? TEST_FNS.has(imported) : exported?.has(imported)) {
        names.add(el.name.text);
      }
    }
  }
  const aliases = (node: ts.Node): boolean => {
    let added = false;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      !names.has(node.name.text) &&
      isExtend(node.initializer, names)
    ) {
      names.add(node.name.text);
      added = true;
    }
    ts.forEachChild(node, (child) => {
      added = aliases(child) || added;
    });
    return added;
  };
  while (aliases(sf));
  return names;
}

/** Test functions this module exports, for importers: `export const test = base.extend(…)`. */
function exportedTests(
  sf: ts.SourceFile,
  names: Set<string>,
  resolve?: Resolver,
  exportsOf?: ExportsOf,
): Set<string> {
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    if (
      ts.isVariableStatement(stmt) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && names.has(d.name.text)) out.add(d.name.text);
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      const spec =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : null;
      const target = spec?.startsWith('.') ? (resolve?.(sf.fileName, spec) ?? null) : null;
      const from = target ? exportsOf?.(target) : undefined;
      for (const el of stmt.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text;
        if (spec === null ? names.has(local) : from?.has(local)) out.add(el.name.text);
      }
    }
  }
  return out;
}

/**
 * Scenario IDs in the titles of non-skipped TS tests (`test`, `it`, `describe`). Titles built at
 * runtime (`test(row.name, …)`) are invisible: put the ID in a literal part of the title (a `+` chain
 * or a template counts by its literal parts).
 */
export function idsInTsTitles(
  source: string,
  file = 'fixture.test.tsx',
  resolve?: Resolver,
  exportsOf?: ExportsOf,
): string[] {
  const sf = parse(source, file);
  const names = testNames(sf, resolve, exportsOf);
  if (hasUnconditionalSkip(sf.statements, names)) return [];

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
        const body = node.arguments.find(
          (a): a is ts.ArrowFunction | ts.FunctionExpression =>
            ts.isArrowFunction(a) || ts.isFunctionExpression(a),
        )?.body;
        if (body && ts.isBlock(body) && hasUnconditionalSkip(body.statements, names)) return;
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

/** Blanks comments and string, raw-string and rune literals, keeping line breaks and offsets. */
function blankGoNonCode(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const two = source.slice(i, i + 2);
    let end = i + 1;
    if (two === '//') {
      end = source.indexOf('\n', i);
      if (end < 0) end = source.length;
    } else if (two === '/*') {
      const close = source.indexOf('*/', i + 2);
      end = close < 0 ? source.length : close + 2;
    } else if (c === '`') {
      const close = source.indexOf('`', i + 1);
      end = close < 0 ? source.length : close + 1;
    } else if (c === '"' || c === "'") {
      while (end < source.length && source[end] !== c && source[end] !== '\n') {
        end += source[end] === '\\' ? 2 : 1;
      }
      end = Math.min(end + 1, source.length);
    } else {
      i++;
      continue;
    }
    blank(i, end);
    i = end;
  }
  return out.join('');
}

/** Scenario IDs in Go test function names (`func TestA28_Name`). */
export function idsInGoTests(source: string): string[] {
  return [...blankGoNonCode(source).matchAll(GO_TEST)].map((m) => m[1] as string);
}

/** Maps each scenario ID found in a test title to the files carrying it. */
export function findTests(
  files: string[],
  read: (file: string) => string = (f) => readFileSync(join(root, f), 'utf8'),
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const fileSet = new Set(files);
  const resolve: Resolver = (from, specifier) => {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const stem = base.replace(/\.[cm]?js$/, '');
    return (
      [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
        (c) => fileSet.has(c),
      ) ?? null
    );
  };
  // Test functions each module exports (`export const test = base.extend(…)`), found on demand.
  const exportCache = new Map<string, Set<string>>();
  const exportsOf: ExportsOf = (file) => {
    const cached = exportCache.get(file);
    if (cached) return cached;
    exportCache.set(file, new Set()); // import cycles resolve to "nothing exported"
    const text = /\.tsx?$/.test(file) ? read(file) : '';
    const result = new Set<string>();
    if (text.includes('.extend(') || text.includes('export {')) {
      const sf = parse(text, file);
      for (const name of exportedTests(sf, testNames(sf, resolve, exportsOf), resolve, exportsOf)) {
        result.add(name);
      }
    }
    exportCache.set(file, result);
    return result;
  };
  for (const file of files.filter(isTestFile)) {
    const text = read(file);
    const ids = file.endsWith('.go')
      ? idsInGoTests(text)
      : idsInTsTitles(text, file, resolve, exportsOf);
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
