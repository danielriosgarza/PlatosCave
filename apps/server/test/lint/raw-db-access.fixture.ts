// Lint fixture for the scoped-table rule (ADR-0002). apps/server/src/db/raw-access-lint.test.ts
// lints copies of this file at feature-module paths, where exactly the marked lines must be
// errors, and at data-access paths, where none may be. At its own path the file is ordinary code.
import { eq, sql } from 'drizzle-orm'; // restricted-import
import pg from 'pg'; // restricted-import
import * as client from '../../src/db/client';
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
  // biome-ignore lint/complexity/useLiteralKeys: the fixture exercises computed member access
  await deps.db['select']().from(users); // raw-query
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
  ];
}

export function notTheDatabase(deps: { ledger: { db: { withdraw(): number } } }) {
  const cache = { db: new Map<string, number>() };
  // Known false positive: any object stored under the name `db` is treated as the handle.
  cache.db.delete('key'); // raw-query
  return deps.ledger.db.withdraw();
}
