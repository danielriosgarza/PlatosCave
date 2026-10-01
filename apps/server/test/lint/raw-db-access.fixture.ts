// Lint fixture for the scoped-table rule (ADR-0002). apps/server/src/db/raw-access-lint.test.ts
// lints copies of this file at feature-module paths, where every marked line must be an error,
// and at data-access paths, where none may be. At its own path the file is ordinary code.
import { eq, sql } from 'drizzle-orm'; // restricted-import
import pg from 'pg'; // restricted-import
import { createDb, type Db } from '../../src/db/client'; // restricted-import
import { classMemberships } from '../../src/db/schema'; // restricted-import
import { users } from '../../src/db/schema/users'; // restricted-import
import { classScopedTables } from '../../src/db/scoped'; // restricted-import

export const imported = [pg, createDb, users, classScopedTables];

export async function readAnotherClass(deps: { db: Db }, classId: string) {
  const db = deps.db;
  const rows = await deps.db
    .select() // raw-query
    .from(classMemberships)
    .where(eq(classMemberships.classId, classId));
  await db.execute(sql`select 1`); // raw-query
  await deps.db.query.classMemberships.findMany(); // raw-query
  await deps.db.transaction(async () => {}); // raw-query
  return rows;
}
