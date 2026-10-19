import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CourseManifest, SyncHeader } from '@parallax/contracts';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app';
import { DEV_RUNNER_RUNTIMES, loadConfig } from '../../src/config';
import { type SyncDeps, syncCourse } from '../../src/content/folder-sync';
import { createSession } from '../../src/db/auth/sessions';
import { createUser } from '../../src/db/identity';
import { createBoss } from '../../src/db/jobs/boss';
import readingIngest from '../../src/jobs/reading-ingest.job';
import { loadJobs } from '../../src/jobs/registry';
import { ensureQueues, workScopedJob } from '../../src/jobs/scoped';
import { FsStorage } from '../../src/storage/fs';
import { makePdf } from '../fixtures/pdf';
import { cookieFor } from '../fixtures/world';
import { createTestDatabase } from './db';

// What the tests of `parallax sync` share: the golden manifests and the fixture files of P5-08
// (the fictional course "Reef ecology" by Ana Lima), and a server with a worker and `FsStorage`
// on real PostgreSQL.

const fixtures = resolve(import.meta.dirname, '../../../../packages/cli/fixtures');
export const ANA = 'ana.lima@example.org';
/** Folder ids of the fixture course. */
export const ids = {
  tides: '0b2f4a6c-8d1e-4f3a-b5c7-9e0a1b2c3d4e',
  tidesReading: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  transects: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
  methods: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
  notebook: '9d8c7b6a-5f4e-4d3c-a2b1-0f9e8d7c6b5a',
  deck: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d',
  shiny: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
};
/** The fixture's PDFs are stand-ins that no PDF reader opens; these are read as the deck and paper. */
const pdfs = {
  deck: makePdf(['Reef zones from the shore outward', 'The reef crest'], [960, 540]),
  paper: makePdf(['Counting fish along a transect']),
};

export type Folder = { manifest: CourseManifest; bytes: Map<string, Uint8Array> };
type Entry = CourseManifest['topics'][number]['resources'][number];

/**
 * A fixture course folder (`course` or `course-changed`) as the reader gives it, its PDFs
 * replaced by ones that convert.
 */
export function folder(name: string): Folder {
  const golden = readFileSync(join(fixtures, `${name}.manifest.json`), 'utf8');
  const manifest: CourseManifest = JSON.parse(golden);
  const root = join(fixtures, name, 'courses/reef-ecology');
  const bytes = new Map<string, Uint8Array>();
  for (const { path, format } of manifest.files) {
    const pdf = path.endsWith('paper.pdf') ? pdfs.paper : pdfs.deck;
    bytes.set(path, format === 'pdf' ? pdf : readFileSync(join(root, path)));
  }
  return { manifest, bytes };
}

export const entry = ({ manifest }: Folder, id: string) =>
  manifest.topics.flatMap((topic) => topic.resources).find((r) => r.id === id) as Entry;

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (f: Folder, path: string) => {
  const bytes = f.bytes.get(path);
  if (!bytes) throw new Error(`no bytes for ${path}`);
  return bytes;
};

/** The bundle's header for a folder, its files' sizes and hashes taken from their bytes. */
function header(f: Folder, more: Partial<SyncHeader>): SyncHeader {
  const files = f.manifest.files.map((file) => {
    const bytes = bytesOf(f, file.path);
    return { ...file, size: bytes.length, sha256: sha256(bytes) };
  });
  return {
    instructor: { email: ANA, path: 'instructor.yaml' },
    course: 'reef-ecology',
    manifest: { ...f.manifest, files },
    options: { overwriteEditor: false, acceptNewIds: false },
    ...more,
  };
}

export async function syncWorld() {
  const testDb = await createTestDatabase();
  const { db } = testDb;
  const ana = await createUser(db, { email: ANA, name: 'Ana Lima' });
  const cookie = cookieFor((await createSession(db, ana)).token);
  const root = await mkdtemp(join(tmpdir(), 'parallax-sync-'));
  const storage = new FsStorage(root);
  const errors: Error[] = [];
  const handlers = { onError: (e: Error) => errors.push(e), onWarning() {} };
  const boss = createBoss(db.$client, { role: 'api', ...handlers });
  await boss.start();
  // As the API does at startup: sends never create the queue themselves.
  await ensureQueues(boss, await loadJobs());
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  const app = await buildApp(config, { db, boss, storage });
  const worker = { pollingIntervalSeconds: 0.5 };
  await workScopedJob(boss, db, readingIngest, app.log, worker, { storage, boss });
  const shiny = ['https://shiny.example.org'];
  const validate = { approvedShinyOrigins: shiny, runtimes: DEV_RUNNER_RUNTIMES };
  // A busy machine may start the first conversion late; that is no idle worker here.
  const wait = { idleMs: 180_000, pollMs: 200 };
  const deps: SyncDeps = { db, boss, storage, validate, instructorEmails: [ANA], wait };
  /** The rows of one of the four tables sync writes, for one course. */
  const of = async (table: string, id: string) => {
    const order = sql.identifier(table === 'course_releases' ? 'version' : 'id');
    const query = sql`select * from ${sql.identifier(table)} where course_id = ${id} order by ${order}`;
    return (await db.execute(query)).rows;
  };
  /** The paths the byte source was asked for. */
  const asked: string[] = [];
  const world = { db, app, boss, storage, ana, cookie, deps, errors, worker, asked };
  return {
    ...world,
    /** One run of sync on the folder's files, read from their bytes. */
    sync: (f: Folder, more: Partial<SyncHeader> = {}, other: Partial<SyncDeps> = {}) =>
      syncCourse({ ...deps, ...other }, header(f, more), async function* (file) {
        asked.push(file.path);
        yield bytesOf(f, file.path);
      }),
    rows: async (courseId: string) => ({
      topics: await of('topics', courseId),
      resources: await of('resources', courseId),
      revisions: await of('resource_revisions', courseId),
      releases: await of('course_releases', courseId),
    }),
    close: async () => {
      await app.close();
      await boss.stop({ graceful: false });
      await testDb.drop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type SyncWorld = Awaited<ReturnType<typeof syncWorld>>;
