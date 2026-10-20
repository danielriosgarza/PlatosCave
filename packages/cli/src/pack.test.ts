import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { pack } from '../scripts/pack';
import { relativeTarget, SOURCES, specifiers, vendor } from '../scripts/vendor';
import { type Source, sourceRoot } from './paths';

// The packing of docs/design/site.md §2, checked on the tarball itself: no network, no install.
const pkg = resolve(import.meta.dirname, '..');
const repo = resolve(pkg, '../..');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-pack-'));
const version = '1.4.0-pack.1';
/** The tracked files that differ from the index or from `HEAD`. */
const status = () =>
  execFileSync('git', ['status', '--porcelain', '-uno'], { cwd: repo, encoding: 'utf8' });
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
type Pins = Record<string, string>;
type Manifest = {
  name: string;
  version: string;
  license?: string;
  dependencies: Pins;
  devDependencies?: Pins;
};

/** The files of a gzipped tarball by path, `package/` removed (ustar names and pax `path`). */
function untar(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Buffer>();
  const field = (at: number, from: number, length: number) =>
    tar.toString('utf8', at + from, at + from + length).replace(/\0.*$/s, '');
  let long: string | undefined;
  for (let at = 0; at + 512 <= tar.length && field(at, 0, 100); ) {
    const size = Number.parseInt(field(at, 124, 12).trim() || '0', 8);
    const body = tar.subarray(at + 512, at + 512 + size);
    const type = field(at, 156, 1);
    const prefix = field(at, 345, 155);
    const name = long ?? (prefix ? `${prefix}/` : '') + field(at, 0, 100);
    long = undefined;
    if (type === 'x') long = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
    else if (type === '0' || type === '') files.set(name.replace(/^package\//, ''), body);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

let before: string;
let files: Map<string, Buffer>;
let manifest: Manifest;
/** The packed tool written out, beside a `node_modules` that holds its dependencies and no other. */
const tool = join(temp, 'parallax-site');

beforeAll(() => {
  before = status();
  files = untar(fs.readFileSync(pack('parallax-site', version, join(temp, 'out'))));
  manifest = JSON.parse(String(files.get('package.json')));
  for (const [path, body] of files) {
    fs.mkdirSync(dirname(join(tool, path)), { recursive: true });
    fs.writeFileSync(join(tool, path), body);
  }
  for (const name of Object.keys(manifest.dependencies)) {
    const link = join(temp, 'node_modules', name);
    fs.mkdirSync(dirname(link), { recursive: true });
    fs.symlinkSync(fs.realpathSync(join(pkg, 'node_modules', name)), link, 'junction');
  }
}, 300_000);
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

const code = () => [...files.keys()].filter((path) => /\.([cm]?[jt]sx?|css)$/.test(path));

test('the packed tool names no @parallax/ package, and every relative import resolves inside it', () => {
  const unresolved: string[] = [];
  for (const path of code()) {
    for (const { spec } of specifiers(String(files.get(path)))) {
      expect(spec, path).not.toMatch(/^@parallax\//);
      const found = !spec.startsWith('.') || relativeTarget((file) => files.has(file), path, spec);
      if (!found) unresolved.push(`${path}: ${spec}`);
    }
  }
  expect(unresolved).toEqual([]);
  // The thread scripts of the conversion are reached through `new URL(…, import.meta.url)`.
  const content = 'vendor/server/src/content';
  for (const name of ['notebook', 'pdf-text', 'reading']) {
    expect(files.has(`${content}/${name}.worker.mjs`), name).toBe(true);
  }
});

test('every package the copies import is a dependency at the version of its source manifest', () => {
  const sources = Object.entries(SOURCES).map(([name, dir]) => {
    const file = join(repo, dir, 'package.json');
    return [name, fs.existsSync(file) ? read(file) : {}] as const;
  });
  const manifests: Record<string, Partial<Manifest>> = Object.fromEntries(sources);
  const imported = new Set<string>();
  for (const path of code()) {
    const source = /^vendor\/([^/]+)\//.exec(path)?.[1];
    const { dependencies = {}, devDependencies = {} } = source
      ? (manifests[source] ?? {})
      : read(join(pkg, 'package.json'));
    for (const { spec, type } of specifiers(String(files.get(path)))) {
      if (type || /^[./]/.test(spec) || spec.includes(':') || builtinModules.includes(spec))
        continue;
      const name = spec
        .split('/')
        .slice(0, spec.startsWith('@') ? 2 : 1)
        .join('/');
      const pinned = dependencies[name] ?? devDependencies[name];
      expect(pinned, `${path} imports ${spec}`).toMatch(/^\d/);
      expect(manifest.dependencies[name], `${path} imports ${spec}`).toBe(pinned);
      imported.add(name);
    }
  }
  expect([...imported]).toEqual(expect.arrayContaining(['react', 'unified', 'zod', 'tsx', 'vite']));
  expect(manifest.dependencies).not.toHaveProperty('pg');
  expect(manifest.dependencies).not.toHaveProperty('drizzle-orm');
  expect(manifest).not.toHaveProperty('devDependencies');
});

type Fragment = { parseHtmlFragment(html: string): { tree: { children: unknown[] } } };
type Read = { read(key: string): Promise<Uint8Array> };
type Convert = { convertRevision(source: object, io: Read): Promise<{ derived: unknown }> };

test('the conversion closure holds no file under db/ and runs from the packed copy', async () => {
  const server = [...files.keys()].filter((path) => path.startsWith('vendor/server/'));
  const entries = ['convert.ts', 'validation.ts', 'html-fragment.ts'];
  expect(server).toEqual(
    expect.arrayContaining(entries.map((f) => `vendor/server/src/content/${f}`)),
  );
  expect(server.filter((path) => path.startsWith('vendor/server/src/db/'))).toEqual([]);
  // The packed `paths.ts` takes `vendor/` (docs/design/site.md §2), and the modules load from it.
  const paths: typeof import('./paths') = await import(
    pathToFileURL(join(tool, 'src/paths.ts')).href
  );
  expect(paths.sourceRoot('contracts')).toBe(join(tool, 'vendor/contracts'));
  type Contracts = typeof import('@parallax/contracts');
  const contracts = await paths.loadSource<Contracts>('contracts', 'src/index.ts');
  expect(contracts.siteConfig.safeParse({}).success).toBe(false);
  const fragment = await paths.loadSource<Fragment>('server', 'src/content/html-fragment.ts');
  expect(fragment.parseHtmlFragment('<p>Reef</p>').tree.children).toHaveLength(1);
  // A reading converted by the packed copy's own thread script, with tsx and its packages.
  const convert = await paths.loadSource<Convert>('server', 'src/content/convert.ts');
  const markdown = new TextEncoder().encode('# Reef zones\n\nThe reef flat lies behind the crest.');
  const reading = { sourceKey: 'k', format: 'markdown' };
  const source = { type: 'reading_native', content: reading, objectKeys: ['k'] };
  const { derived } = await convert.convertRevision(source, { read: async () => markdown });
  expect(JSON.stringify(derived)).toContain('Reef zones');
}, 120_000);

test('no test, fixture or .env file is packed; tsconfig.base.json and the backup scripts are', () => {
  const paths = [...files.keys()];
  const kept = paths.filter((path) =>
    /(^|\/)(\.|test\/|fixtures\b)|\.(test|itest|e2e)\.|^src\/open\/(testing\.ts|read-guard)/.test(
      path,
    ),
  );
  expect(kept).toEqual([]);
  const same = (packed: string, file: string) =>
    expect(String(files.get(packed)), packed).toBe(fs.readFileSync(join(repo, file), 'utf8'));
  same('tsconfig.base.json', 'tsconfig.base.json');
  same('vendor/deploy/backup.sh', 'scripts/backup.sh');
  same('vendor/deploy/restore.sh', 'scripts/restore.sh');
  // `vendor/<name>` mirrors the folder that the workspace branch of `paths.ts` reads.
  for (const [name, dir] of Object.entries(SOURCES)) {
    expect(sourceRoot(name as Source)).toBe(join(repo, dir));
  }
  expect(paths).toEqual(expect.arrayContaining(['bin/parallax.mjs', 'pages.d.ts', 'src/main.ts']));
  expect(paths).toContain('vendor/web/src/routeTree.gen.ts');
});

test('both published packages carry the MIT licence: the license field and the LICENSE file', () => {
  // The owner's decision of 2026-10-20 (docs/design/site.md §14, question 3).
  const licence = fs.readFileSync(join(repo, 'LICENSE'), 'utf8');
  expect(licence).toMatch(/^MIT License\n\nCopyright \(c\) \d{4} \S/);
  expect(manifest.license).toBe('MIT');
  expect(String(files.get('LICENSE'))).toBe(licence);
  const scaffolder = untar(
    fs.readFileSync(pack('create-parallax-site', version, join(temp, 'scaffolder'))),
  );
  expect(JSON.parse(String(scaffolder.get('package.json'))).license).toBe('MIT');
  expect(String(scaffolder.get('LICENSE'))).toBe(licence);
});

test('pack.ts gives a tarball whose manifest carries the version asked for, and no tracked file changes', () => {
  expect(manifest.name).toBe('parallax-site');
  expect(manifest.version).toBe(version);
  expect(read(join(pkg, 'package.json')).version).toBe('0.0.0');
  expect(status()).toBe(before);
  // In the repository a `vendor/` would shadow the workspace sources, so it is refused there.
  expect(() => vendor(pkg, repo)).toThrow(/staged copy/);
  expect(fs.existsSync(join(pkg, 'vendor'))).toBe(false);
});
