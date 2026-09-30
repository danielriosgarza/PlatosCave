import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.local', 'coverage']);
const ID = /\bA(0[1-9]|[12][0-9]|3[0-6])\b/g;

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

/** Maps each scenario ID found in a test file to the files mentioning it. */
export function findTests(files: string[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of files.filter(isTestFile)) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const match of text.matchAll(ID)) {
      const id = match[0];
      if (!found.has(id)) found.set(id, new Set());
      found.get(id)?.add(file);
    }
  }
  return found;
}

/** IDs listed in docs/delivery/done/*.txt, one per line. */
export function readDone(dir: string): Map<string, string> {
  const done = new Map<string, string>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.txt'))) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      const id = line.trim();
      if (id) done.set(id, name);
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
  for (const [id, source] of missing) {
    console.error(`${id} is listed in docs/delivery/done/${source} but has no test`);
  }
  console.log(`${found.size} scenarios with tests, ${done.size} recorded done`);
  return missing.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
