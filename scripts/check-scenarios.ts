import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.local', 'coverage']);
const ID = /\bA(0[1-9]|[12][0-9]|3[0-6])\b/g;
const GO_TEST = /^func Test(A(?:0[1-9]|[12][0-9]|3[0-6]))(?![0-9A-Za-z])/gm;
const CALL_HEAD =
  /\b(?:test|it|describe)((?:\.[A-Za-z]+(?:\([^()]*\))?)*)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
const DOCKER_SKIP = /docker|imagePresent|S3_ENDPOINT/i;

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
  (path !== 'scripts/check-scenarios.test.ts' && /\.(test|itest|e2e)\.tsx?$/.test(path)) ||
  /^connector\/.*_test\.go$/.test(path);

/** Blanks comments with spaces (offsets and newlines preserved) so IDs in them never count. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') (out += ' '), i++;
    } else if (c === '/' && next === '*') {
      const stop = src.indexOf('*/', i + 2);
      const endAt = stop < 0 ? src.length : stop + 2;
      out += src.slice(i, endAt).replace(/[^\n]/g, ' ');
      i = endAt;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just past the `)` closing the call whose `(` is at or after `from`. */
function callEnd(src: string, from: number): number {
  const open = src.indexOf('(', from);
  if (open < 0) return src.length;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i] as string;
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return src.length;
}

const addId = (found: Map<string, Set<string>>, id: string, file: string): void => {
  if (!found.has(id)) found.set(id, new Set());
  found.get(id)?.add(file);
};

/** Scenario IDs in the titles of non-skipped TS tests (`test`, `it`, `describe`). */
export function idsInTsTitles(source: string, file = ''): string[] {
  let src = stripComments(source);
  const ids: string[] = [];
  CALL_HEAD.lastIndex = 0;
  for (let m = CALL_HEAD.exec(src); m; m = CALL_HEAD.exec(src)) {
    const mods = m[1] ?? '';
    const skipped =
      /\.(skip|todo|fixme)\b/.test(mods) ||
      (/\.(skipIf|runIf)\b/.test(mods) && !(DOCKER_SKIP.test(mods) || file.includes('.docker.')));
    if (skipped) {
      const end = callEnd(src, m.index + m[0].length - (m[3] ?? '').length - 2);
      src = src.slice(0, m.index) + src.slice(m.index, end).replace(/[^\n]/g, ' ') + src.slice(end);
      CALL_HEAD.lastIndex = m.index;
      continue;
    }
    for (const id of (m[3] ?? '').matchAll(ID)) ids.push(id[0]);
  }
  return ids;
}

/** Scenario IDs in Go test function names (`func TestA28_Name`). */
export function idsInGoTests(source: string): string[] {
  return [...stripComments(source).matchAll(GO_TEST)].map((m) => m[1] as string);
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
      done.set(id, [...(done.get(id) ?? []), name]);
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
