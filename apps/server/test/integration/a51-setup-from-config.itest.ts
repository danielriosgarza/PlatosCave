import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SiteSetup, siteSetup } from '@parallax/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DEV_RUNNER_RUNTIMES } from '../../src/config';
import { type SyncDeps, syncCourse } from '../../src/content/folder-sync';
import { userForVerifiedEmail } from '../../src/db/auth/accounts';
import { ensureFolderCourse } from '../../src/db/content/sync';
import { createClass } from '../../src/db/identity';
import { issueInvite, joinWithCode } from '../../src/db/invites';
import { createBoss } from '../../src/db/jobs/boss';
import { applySetup } from '../../src/db/setup';
import type { JobLogger } from '../../src/jobs/logger';
import readingIngest from '../../src/jobs/reading-ingest.job';
import { loadJobs } from '../../src/jobs/registry';
import { ensureQueues, workScopedJob } from '../../src/jobs/scoped';
import { FsStorage } from '../../src/storage/fs';
import { asCourseScope, asManagerScope, asUserScope } from '../fixtures/world';
import { folder, sha256 } from './course-folder';
import { createTestDatabase, type TestDatabase } from './db';

// A51 (§13, N2) with no Fastify app built: the fixture document is what the school fixture site
// gives (`packages/cli/fixtures/config/school`), and each course is the fixture course of P5-08,
// synced by `syncCourse` as `parallax sync` syncs it.

const fixture = join(import.meta.dirname, '../fixtures/site-setup.json');
const doc = siteSetup.parse(JSON.parse(readFileSync(fixture, 'utf8')));
const [ANA, BEN] = doc.instructors.map((i) => i.email) as [string, string];
const spring = doc.classes[0] as SiteSetup['classes'][number];
const CODE = /[A-Z2-9]{5}-[A-Z2-9]{5}/;
const SAID = { spring: 'ana/reef-ecology, Spring 2027:', open: 'ben/statistics, Open course:' };
const PENDING = `${SAID.open} pending: the course is not synced; run parallax sync`;
/** Setup's own event for a class: no actor, the account it acted for and the changes' names. */
const event = (actingFor: string, list: string) => ({
  actor: null,
  actingFor,
  changes: list.split(' '),
});

let t: TestDatabase;
let deps: SyncDeps;
let root: string;
beforeAll(async () => {
  t = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'parallax-a51-'));
  const boss = createBoss(t.db.$client, { role: 'api', onError() {}, onWarning() {} });
  await boss.start();
  await ensureQueues(boss, await loadJobs());
  const storage = new FsStorage(root);
  const quiet = { info() {}, warn() {}, error() {} } as unknown as JobLogger;
  const polling = { pollingIntervalSeconds: 0.5 };
  await workScopedJob(boss, t.db, readingIngest, quiet, polling, { storage, boss });
  const shiny = ['https://shiny.example.org'];
  const validate = { approvedShinyOrigins: shiny, runtimes: DEV_RUNNER_RUNTIMES };
  const wait = { idleMs: 180_000, pollMs: 200 };
  deps = { db: t.db, boss, storage, validate, instructorEmails: [ANA, BEN], wait };
});
afterAll(async () => {
  await deps?.boss.stop({ graceful: false });
  await t?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

/** `parallax sync` of the fixture course into the instructor's course folder `name`. */
async function sync(email: string, name: string) {
  const { manifest, bytes } = folder('course');
  const read = (path: string) => bytes.get(path) as Uint8Array;
  const files = manifest.files.map((f) => {
    const data = read(f.path);
    return { ...f, size: data.length, sha256: sha256(data) };
  });
  const options = { overwriteEditor: false, acceptNewIds: false };
  const instructor = { email, path: 'instructor.yaml' };
  const header = { instructor, course: name, options, manifest: { ...manifest, files } };
  const result = await syncCourse(deps, header, async function* (file) {
    yield read(file.path);
  });
  expect(result, result.report.join('\n')).toMatchObject({ code: 0 });
}

async function apply(document: SiteSetup = doc) {
  const report: string[] = [];
  const code = await applySetup(t.db, document, (line) => report.push(line));
  return { code, report };
}

const query = async (q: SQL) => (await t.db.execute(q)).rows;
/** The rows of the tables (all of them by default), in an order that does not depend on storage. */
async function rows(tables?: string[]) {
  const all = sql`select table_name from information_schema.tables where table_schema = 'public'`;
  const names = tables ?? (await query(all)).map((r) => String(r.table_name));
  const read = (name: string) => query(sql`select * from ${sql.identifier(name)}`);
  const each = names.map(async (n) => [n, (await read(n)).map((r) => JSON.stringify(r)).sort()]);
  return Object.fromEntries(await Promise.all(each)) as Record<string, string[]>;
}
const classesNamed = (name: string) =>
  query(sql`select id, course_id, release_id, open from classes
    where name = ${name} order by created_at`);
const membersOf = (id: unknown) =>
  query(sql`select u.email, m.role, c.owner, c.editor from class_memberships m
    join users u on u.id = m.user_id join classes k on k.id = m.class_id
    left join course_memberships c on c.user_id = m.user_id and c.course_id = k.course_id
    where m.class_id = ${id} order by u.email`);
const eventsOf = async (id: unknown) =>
  (
    await query(sql`select jsonb_build_object('actor', actor_id) || after as event
    from audit_events where action = 'setup.apply' and target_id = ${id}`)
  ).map((r) => r.event);
const invitesOf = (id: unknown) =>
  query(sql`select max_uses, expires_at from class_invites
    where class_id = ${id} and kind = 'enrolment'`);
const UNLIMITED = [{ max_uses: null, expires_at: null }];

test('A51 setup from the configuration creates instructor access, classes and enrolment with no API call, and a second run changes nothing', {
  timeout: 300_000,
}, async () => {
  const ana = await userForVerifiedEmail(t.db, ANA);
  await sync(ANA, 'reef-ecology');

  // Ben has not signed in: setup stops before any write and names his instructor.yaml.
  const before = await rows();
  const signIn = 'no active account has this address; that person signs in once first';
  const stop = { code: 1, report: [`instructors/ben/instructor.yaml: ${signIn}`] };
  expect(await apply()).toEqual(stop);
  expect(await rows()).toEqual(before);
  expect([before.auth_sessions, before.signin_tokens]).toEqual([[], []]);

  // Ben's course is not synced: his class is reported, and Ana's is set up.
  const ben = await userForVerifiedEmail(t.db, BEN);
  const first = await apply();
  const created = `${SAID.spring} class created; instructors ana, ben; release 1 adopted;`;
  expect(first).toEqual({ code: 1, report: [expect.stringMatching(created), PENDING] });
  expect(first.report[0]).toMatch(new RegExp(`; enrolment code ${CODE.source}$`));
  const [cls] = await classesNamed('Spring 2027');
  const newest = sql`select id from course_releases where course_id = ${cls?.course_id} order by version desc`;
  expect(cls).toMatchObject({ release_id: (await query(newest))[0]?.id, open: false });
  // The owner's grant was found; both instructors teach the class and edit the course draft.
  expect(await membersOf(cls?.id)).toEqual([
    { email: ANA, role: 'instructor', owner: true, editor: true },
    { email: BEN, role: 'instructor', owner: false, editor: true },
  ]);
  expect(await invitesOf(cls?.id)).toEqual(UNLIMITED);
  const carol = await userForVerifiedEmail(t.db, 'carol@example.org');
  const code = CODE.exec(first.report[0] as string)?.[0] as string;
  const student = asUserScope(carol, 'carol@example.org');
  expect(await joinWithCode(t.db, student, code, new Date())).toMatchObject({ role: 'student' });
  const made = event(ana, 'class.create membership.add membership.add release.adopt invite.create');
  expect(await eventsOf(cls?.id)).toEqual([made]);

  // The course row a first sync leaves when it stops before publishing is not ready either.
  await ensureFolderCourse(t.db, { id: ben, email: BEN }, 'statistics', 'Statistics', [BEN]);
  expect((await apply()).report).toEqual([`${SAID.spring} unchanged`, PENDING]);

  await sync(BEN, 'statistics');
  const second = await apply();
  const link = `${SAID.open} class created; instructors ben; release 1 adopted; opened; join link`;
  expect(second).toEqual({ code: 0, report: [`${SAID.spring} unchanged`, expect.any(String)] });
  const joinLink = `https://school.example.org/join/${CODE.source}`;
  expect(second.report[1]).toMatch(new RegExp(`^${link} ${joinLink}$`));
  const [open] = await classesNamed('Open course');
  expect(open).toMatchObject({ open: true, release_id: expect.any(String) });
  expect(await invitesOf(open?.id)).toEqual(UNLIMITED);
  const opened = event(ben, 'class.create membership.add release.adopt class.open invite.create');
  expect(await eventsOf(open?.id)).toEqual([opened]);
  // No route writes the action of setup's own events.
  const routes = join(import.meta.dirname, '../../src/http/routes');
  for (const file of readdirSync(routes)) {
    expect(readFileSync(join(routes, file), 'utf8'), file).not.toContain('setup.apply');
  }

  // A second run changes no row and prints no code.
  const tables = ['users', 'auth_sessions', 'signin_tokens', 'course_memberships', 'classes'];
  tables.push('class_memberships', 'class_invites', 'class_release_history', 'audit_events');
  const settled = await rows(tables);
  const report = [`${SAID.spring} unchanged`, `${SAID.open} unchanged`];
  expect(await apply()).toEqual({ code: 0, report });
  expect(await rows(tables)).toEqual(settled);

  // A renamed class is created beside the earlier one, which stays as it was.
  const renamed = await apply({ ...doc, classes: [{ ...spring, name: 'Spring term 2027' }] });
  expect(renamed.report[0]).toMatch(/^ana\/reef-ecology, Spring term 2027: class created; /);
  expect(await classesNamed('Spring 2027')).toEqual([cls]);

  // Refused: a name that two classes of the course carry, and an instructor who is a student.
  const owner = asCourseScope(cls?.course_id as string, ana);
  const twin = await createClass(t.db, owner, { name: 'Spring 2027' });
  const autumn = await createClass(t.db, owner, { name: 'Autumn 2027' });
  const manager = asManagerScope(autumn.id, owner.courseId, ana);
  const issued = await issueInvite(t.db, manager, { kind: 'enrolment' }, new Date());
  const enrolment = issued.ok ? issued.invite.code : '';
  await joinWithCode(t.db, asUserScope(ben, BEN), enrolment, new Date());
  const refused = await apply({ ...doc, classes: [spring, { ...spring, name: 'Autumn 2027' }] });
  expect(refused).toEqual({
    code: 1,
    report: [
      `${SAID.spring} refused: two or more classes of the course have this name: ${cls?.id}, ${twin.id}`,
      'ana/reef-ecology, Autumn 2027: refused: instructors/ben/instructor.yaml: the account is a student of this class',
    ],
  });
  // The refused class's transaction wrote nothing: Ana, listed first, does not teach it.
  const studentOnly = [{ email: BEN, role: 'student', owner: false, editor: true }];
  expect(await membersOf(autumn.id)).toEqual(studentOnly);
  expect(await eventsOf(autumn.id)).toEqual([]);
});
