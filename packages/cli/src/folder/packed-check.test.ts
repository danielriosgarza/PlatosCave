import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { vendor } from '../../scripts/vendor';

// What vendor.ts writes (docs/design/site.md §2), outside the repository, beside the tool's src/.
delete process.env.DATABASE_URL;
const pkg = resolve(import.meta.dirname, '../..');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-packed-check-'));
const stage = join(temp, 'parallax-site');
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeAll(() => {
  const source = (file: string) => !file.endsWith('.test.ts');
  fs.cpSync(join(pkg, 'src'), join(stage, 'src'), { recursive: true, filter: source });
  vendor(stage, resolve(pkg, '../..'));
  const { dependencies } = JSON.parse(fs.readFileSync(join(pkg, 'package.json'), 'utf8'));
  for (const name of Object.keys(dependencies)) {
    const link = join(temp, 'node_modules', name);
    fs.mkdirSync(dirname(link), { recursive: true });
    fs.symlinkSync(fs.realpathSync(join(pkg, 'node_modules', name)), link, 'junction');
  }
}, 120_000);

test('the copy that vendor.ts writes holds the validator with all it imports and the upload rules, and no file under db/', async () => {
  const server = join(stage, 'vendor/server');
  const files = fs.readdirSync(server, { recursive: true, encoding: 'utf8' });
  expect(files.filter((path) => /^src[\\/]db([\\/]|$)/.test(path))).toEqual([]);
  // Loaded from the copy, whose paths.ts takes vendor/: a module missing there fails here.
  const packed: typeof import('./publication') = await import(
    pathToFileURL(join(stage, 'src/folder/publication.ts')).href
  );
  const file = { path: 'a.md', sha256: '0'.repeat(64), size: 1, format: 'markdown' as const };
  const manifest = { title: 'Reef ecology', topics: [], files: [file] };
  const report = packed.publicationReport(manifest, undefined, { folders: new Map() });
  expect(report.errors.map((issue) => issue.code)).toEqual(['empty_release']);
  const open = () => Readable.from([Buffer.from('\0')]);
  const refused = await packed.uploadProblems(manifest, open, new Map());
  expect(refused).toEqual([
    expect.objectContaining({ path: 'a.md', message: 'The file is not text' }),
  ]);
}, 120_000);
