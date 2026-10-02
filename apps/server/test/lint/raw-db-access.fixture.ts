// Lint fixture for the scoped-table rule (ADR-0002). apps/server/src/db/raw-access-lint.test.ts
// lints copies of this file at feature-module paths, where exactly the marked lines must be
// errors, and at data-access paths, where none may be. At its own path the file is ordinary code.
import { eq, sql } from 'drizzle-orm'; // restricted-import
import pg from 'pg'; // restricted-import
import type * as clientNamespace from '../../src/db/client';
import * as client from '../../src/db/client'; // raw-query
import { createDb, type Db } from '../../src/db/client'; // restricted-import
import { classMemberships } from '../../src/db/schema'; // restricted-import
import { users } from '../../src/db/schema/users'; // restricted-import
import { classScopedTables } from '../../src/db/scoped'; // restricted-import
import { courseScopedTables } from '../../src/db/scoped.js'; // restricted-import

export const imported = [pg, createDb, users, classScopedTables, courseScopedTables];

export async function readAnotherClass(deps: { db: Db }, classId: string) {
  const db = deps.db;
  const rows = await deps.db
    .select() // raw-query
    .from(classMemberships)
    .where(eq(classMemberships.classId, classId));
  await db.execute(sql`select 1`); // raw-query
  await deps.db.query.classMemberships.findMany(); // raw-query
  await deps.db.transaction(async () => {}); // raw-query
  await deps.db?.select().from(users); // raw-query
  await deps.db.$client.query('delete from class_memberships'); // raw-query
  client.createDb('postgres://localhost/x'); // raw-query
  // biome-ignore lint/complexity/useLiteralKeys: the fixture exercises computed namespace access
  // biome-ignore lint/performance/noDynamicNamespaceImportAccess: as above
  client['createDb']('postgres://localhost/x'); // raw-query
  // biome-ignore lint/complexity/useLiteralKeys: the fixture exercises computed member access
  await deps.db['select']().from(users); // raw-query
  await deps.db.insert(users).values([]); // raw-query
  await deps.db.update(users).set({}); // raw-query
  await deps.db.delete(users); // raw-query
  return rows;
}

export function viaAccessor(deps: { db?: Db }) {
  const db = () => {
    if (!deps.db) throw new Error('no database');
    return deps.db;
  };
  // biome-ignore lint/style/noNonNullAssertion: the fixture exercises a non-null receiver
  const asserted = deps.db!.execute(sql`select 1`); // raw-query
  return [
    asserted,
    db().select().from(users), // raw-query
    db().query.users.findMany(), // raw-query
    // biome-ignore lint/style/noNonNullAssertion: the fixture exercises a non-null accessor result
    db()!.select(), // raw-query
  ];
}

export type * as clientTypes from '../../src/db/client';
export type ClientModule = typeof clientNamespace;
export * as clientModule from '../../src/db/client'; // raw-query
export * from '../../src/db/client'; // raw-query
// Checked by hand, not here, because db/client has no default export and `tsc` rejects them:
// `import x, * as client from` and `import type, * as client from` db/client are flagged.

export async function loadsTheClient() {
  const loaded = await import('../../src/db/client'); // raw-query
  const typed: typeof import('../../src/db/client') = loaded;
  return typed;
}

export function viaParameter({
  db: { select }, // raw-query
}: {
  db: Db;
}) {
  return select;
}

export function wrappedReceivers(deps: { db: Db }, method: 'execute' | 'select') {
  const { select } = deps.db; // raw-query
  const { ...everything } = deps.db; // raw-query
  const {
    db: { transaction }, // raw-query
  } = deps;
  // biome-ignore lint/complexity/useLiteralKeys: the fixture exercises a computed key
  const { ['insert']: insertInto } = deps.db; // raw-query
  // biome-ignore lint/complexity/useLiteralKeys: the fixture exercises an escaped computed key
  const { ['\x73elect']: escapedComputed } = deps.db; // raw-query
  const { '\x73elect': escapedQuoted } = deps.db; // raw-query
  const { [method]: anyMethod } = deps.db; // raw-query
  const {
    createDb: open, // raw-query
  } = client;
  for (const { createDb: make } of [client]) make('postgres://localhost/x'); // raw-query
  return [
    (deps.db as Db).select(), // raw-query
    (deps.db satisfies Db).execute(sql`select 1`), // raw-query
    // biome-ignore lint/complexity/useLiteralKeys: the fixture exercises a computed receiver
    deps['db'].select(), // raw-query
    deps.db._.session, // raw-query
    // biome-ignore lint/style/noNonNullAssertion: the fixture exercises a wrapped non-null receiver
    (deps.db as Db)!.select(), // raw-query
    // biome-ignore lint/complexity/useLiteralKeys: the fixture exercises a computed receiver
    // biome-ignore lint/style/noNonNullAssertion: the fixture exercises a computed non-null receiver
    deps['db']!.select(), // raw-query
    (<Db>deps.db).select(), // raw-query
    select,
    everything,
    transaction,
    insertInto,
    escapedComputed,
    escapedQuoted,
    anyMethod,
    open,
  ];
}

// Must not fire: other names on an object called `db`, destructuring the deps object, and a
// `createDb` name that is not taken from an object in a declaration.
export function notTheDatabase(deps: {
  db: Db;
  ledger: { db: { withdraw(): number } };
  config: { db: { url: string } };
  vault: { db: { ledger: { select(): number } } };
  tools: { open(): void };
}) {
  const { db } = deps;
  const { url } = deps.config.db;
  // biome-ignore lint/complexity/useLiteralKeys: the fixture exercises a computed key
  const { ['url']: computedUrl } = deps.config.db;
  const {
    db: { url: again },
  } = deps.config;
  const {
    db: {
      ledger: { select },
    },
  } = deps.vault;
  const { open: createDb } = deps.tools;
  const cache = { db: new Map<string, number>() };
  // Documented limit, asserted neither way: any object stored under `db` is treated as the handle
  // when a query method is called on it or a rest element destructures it.
  cache.db.delete('key'); // known-false-positive
  const { ...settings } = deps.config.db; // known-false-positive
  return [deps.ledger.db.withdraw(), db, url, computedUrl, again, select, settings, createDb];
}

export function takesAFactory({ createDb }: { createDb: () => void }) {
  const { open = ({ createDb: inner }: { createDb: () => void }) => inner() } = {};
  createDb();
  return open;
}
