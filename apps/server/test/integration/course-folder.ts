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
const ANA = 'ana.lima@example.org';
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
function header(f: Folder): SyncHeader {
  const files = f.manifest.files.map((file) => {
    const bytes = bytesOf(f, file.path);
    return { ...file, size: bytes.length, sha256: sha256(bytes) };
  });
  return {
    instructor: { email: ANA, path: 'instructor.yaml' },
    course: 'reef-ecology',
    manifest: { ...f.manifest, files },
    options: { overwriteEditor: false, acceptNewIds: false },
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
    const query = sql`select * from ${sql.identifier(table)} where course_id = ${id} order by id`;
    return (await db.execute(query)).rows;
  };
  const world = { db, app, storage, ana, cookie, errors };
  return {
    ...world,
    /** One run of sync on the folder's files, read from their bytes. */
    sync: (f: Folder) =>
      syncCourse(deps, header(f), async function* (file) {
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
