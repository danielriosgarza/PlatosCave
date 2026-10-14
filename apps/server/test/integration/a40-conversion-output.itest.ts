import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { DerivationSource } from '../../src/db/jobs/derived';
import { ingestRevision, type ObjectStore } from '../../src/jobs/reading-ingest.job';
import { FsStorage } from '../../src/storage/fs';
import { storeCourseObject } from '../../src/storage/objects';
import { courseObjectPrefix } from '../../src/storage/storage';
import { labNotebookFile } from '../fixtures/notebook';
import { makePdf } from '../fixtures/pdf';
import { asCourseScope, buildWorld, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

let testDb: TestDatabase;
let store: ObjectStore;
let root: string;
let storage: FsStorage;
/** The bytes of every upload, base64, by key: what the child process reads objects from. */
const uploads = new Map<string, string>();

beforeAll(async () => {
  testDb = await createTestDatabase();
  await buildWorld(testDb.db);
  store = { db: testDb.db, scope: asCourseScope(ids.statistics, ids.elena) };
  root = await mkdtemp(join(tmpdir(), 'parallax-convert-'));
  storage = new FsStorage(join(root, 'storage'));
});

afterAll(async () => {
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Stores a file as an editor's upload is stored, and returns its key. */
async function upload(file: string | Uint8Array, contentType: string): Promise<string> {
  const bytes = Buffer.from(file);
  const { key } = await storeCourseObject(store.db, storage, store.scope, bytes, contentType);
  uploads.set(key, bytes.toString('base64'));
  return key;
}

// The child loads the entry by the package's export. It runs a script, not a module: the
// rendering threads inherit the child's options, and `--input-type` fails in a thread.
const child = `(async () => {
  const { convertRevision } = await import('@parallax/server/convert');
  const { prefix, files, sources } = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const read = async (key) => new Uint8Array(Buffer.from(files[key], 'base64'));
  const results = [];
  for (const source of sources) {
    const { derived, objects } = await convertRevision(source, { read, prefix });
    const out = objects.map((o) => ({ ...o, bytes: Buffer.from(o.bytes).toString('base64') }));
    results.push({ derived, objects: out });
  }
  process.stdout.write(JSON.stringify({ database: process.env.DATABASE_URL ?? null, results }));
})();`;
type Result = { derived: unknown; objects: { key: string; contentType: string; bytes: string }[] };

/** `ingestRevision` here, and `convertRevision` in a child without DATABASE_URL, agree. */
async function expectSameOutputs(sources: DerivationSource[]) {
  const input = join(root, `sources-${sources.length}.json`);
  const prefix = courseObjectPrefix(ids.statistics);
  await writeFile(input, JSON.stringify({ prefix, files: Object.fromEntries(uploads), sources }));
  const { DATABASE_URL: _, ...env } = process.env;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '--eval', child, input],
    { cwd: resolve(import.meta.dirname, '../..'), env, maxBuffer: 64 * 1024 * 1024 },
  );
  const { database, results } = JSON.parse(stdout) as { database: null; results: Result[] };
  expect(database).toBeNull();
  for (const [i, source] of sources.entries()) {
    const ingested = await ingestRevision(source, storage, undefined, store);
    const { derived, objects } = results[i] ?? { derived: null, objects: [] };
    expect(derived).toEqual(JSON.parse(JSON.stringify(ingested)));
    const types = Object.fromEntries(objects.map((o) => [o.key, o.contentType]));
    expect(types).toEqual(source.type === 'notebook' ? ingested.objects : {});
    for (const object of objects) {
      const { body } = await storage.get(object.key);
      expect(Buffer.concat(await body.toArray()).toString('base64')).toBe(object.bytes);
    }
  }
}

const reading = '# Reef zones\n\nThe flat lies behind the crest.\n\n$$\\bar{x} = 4.2$$';
const deck = '# Reef survey\n\nTransects every 10 m.\n\n---\n\n## Results\n\n- Coral cover 41%';

test('A40 the database-free conversion entry equals ingestion output for the same sources', async () => {
  const md = await upload(reading, 'text/markdown');
  const html = await upload('<h1>Reef zones</h1><p>The crest.</p>', 'text/html');
  const nb = await upload(labNotebookFile, 'application/x-ipynb+json');
  const pdf = await upload(makePdf(['Reef flat', 'Reef crest']), 'application/pdf');
  const slides = await upload(makePdf(['Survey', ''], [960, 540]), 'application/pdf');
  await expectSameOutputs([
    { type: 'reading_native', content: { sourceKey: md, format: 'markdown' }, objectKeys: [md] },
    { type: 'reading_native', content: { sourceKey: html, format: 'html' }, objectKeys: [html] },
    { type: 'slides_web', content: { markdown: deck }, objectKeys: [] },
    { type: 'notebook', content: { sourceKey: nb }, objectKeys: [nb] },
    { type: 'reading_pdf', content: { objectKey: pdf }, objectKeys: [pdf] },
    { type: 'slides_pdf', content: {}, objectKeys: [slides] },
  ]);
});
