import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.local', 'coverage']);
const ID = /\bA(0[1-9]|[12][0-9]|3[0-6])\b/g;
const GO_TEST = /^func Test(A(?:0[1-9]|[12][0-9]|3[0-6]))(?![0-9A-Za-z])/gm;
const HEAD = /(?<![.\w$])(?:test|it|describe)(?![\w$])/g;
// Modifiers whose own arguments come before the title's call: test.each(table)('title', fn).
const CURRIED = new Set(['each', 'for', 'skipIf', 'runIf']);
const SKIPPED = new Set(['skip', 'todo', 'fixme']);
// The documented Docker/S3/CI gates of ADR-0006: those blocks run in CI, where they are mandatory.
const DOCKER_GATE = /docker|imagePresent|S3_ENDPOINT|\bCI\b/i;

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

const REGEX_PREFIX = /[(,=:[!&|?{};+\-*%<>~^]$/;

/**
 * Same-length copy of `src` with comments, regex literals and string contents blanked
 * (quotes kept, newlines preserved), so scanning it never sees IDs, parentheses or test calls
 * that are not code. Single- and double-quoted strings end at a newline.
 */
export function maskSource(src: string): string {
  const out: string[] = [];
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out.push(src[k] === '\n' ? '\n' : ' ');
  };
  let last = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && next === '*') {
      const stop = src.indexOf('*/', i + 2);
      const j = stop < 0 ? src.length : stop + 2;
      blank(i, j);
      i = j;
    } else if (c === '/' && (last === '' || REGEX_PREFIX.test(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      blank(i, j + 1);
      i = j + 1;
      last = '/';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) {
        j += src[j] === '\\' ? 2 : 1;
      }
      const closed = src[j] === c;
      out.push(c);
      blank(i + 1, Math.min(j, src.length));
      if (closed) out.push(c);
      i = closed ? j + 1 : j;
      last = c;
    } else {
      out.push(c);
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out.join('');
}

/** Index just past the `)` closing the group whose `(` is at `open` (masked source). */
function groupEnd(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')' && --depth === 0) return i + 1;
  }
  return masked.length;
}

const skipSpace = (masked: string, from: number): number => {
  let i = from;
  while (i < masked.length && /\s/.test(masked[i] as string)) i++;
  return i;
};

const addId = (found: Map<string, Set<string>>, id: string, file: string): void => {
  if (!found.has(id)) found.set(id, new Set());
  found.get(id)?.add(file);
};

/** Scenario IDs in the titles of non-skipped TS tests (`test`, `it`, `describe`). */
export function idsInTsTitles(source: string, file = ''): string[] {
  const masked = maskSource(source);
  const ids: string[] = [];
  let skipUntil = 0;
  for (const head of masked.matchAll(HEAD)) {
    if (head.index < skipUntil) continue;
    let pos = head.index + head[0].length;
    let skipped = false;
    let call = -1;
    for (;;) {
      pos = skipSpace(masked, pos);
      if (masked[pos] === '.') {
        const name = /^\.\s*([A-Za-z]+)/.exec(masked.slice(pos, pos + 40));
        if (!name) break;
        const modifier = name[1] as string;
        pos += name[0].length;
        const open = skipSpace(masked, pos);
        if (CURRIED.has(modifier) && masked[open] === '(') {
          const end = groupEnd(masked, open);
          if (modifier === 'skipIf' || modifier === 'runIf') {
            skipped ||= !(DOCKER_GATE.test(source.slice(open, end)) || file.includes('.docker.'));
          }
          pos = end;
        } else if (SKIPPED.has(modifier)) skipped = true;
      } else {
        if (masked[pos] === '(') call = pos;
        break;
      }
    }
    if (call < 0) continue;
    const end = groupEnd(masked, call);
    if (skipped) {
      skipUntil = end;
      continue;
    }
    const quote = masked[skipSpace(masked, call + 1)];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    const start = skipSpace(masked, call + 1);
    const close = masked.indexOf(quote, start + 1);
    if (close < 0) continue;
    for (const id of source.slice(start + 1, close).matchAll(ID)) ids.push(id[0]);
  }
  return ids;
}

/** Scenario IDs in Go test function names (`func TestA28_Name`). */
export function idsInGoTests(source: string): string[] {
  return [...maskSource(source).matchAll(GO_TEST)].map((m) => m[1] as string);
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
