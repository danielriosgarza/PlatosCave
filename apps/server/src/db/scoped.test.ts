import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import * as schema from './schema';
import { classScopedTables, courseScopedTables, ownRowsTables, userOwnedTables } from './scoped';

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
const names = (list: PgTable[]) => list.map((t) => getTableConfig(t).name).sort();

function withColumn(column: string) {
  return tables.filter((t) => getTableConfig(t).columns.some((c) => snake(c.name) === column));
}

test.each([
  ['class_id', classScopedTables],
  ['course_id', courseScopedTables],
])('every table with %s is registered in db/scoped.ts and vice versa', (column, registered) => {
  expect(names(registered)).toEqual(names(withColumn(column)));
  for (const table of registered) {
    const col = getTableConfig(table).columns.find((c) => snake(c.name) === column);
    expect(col?.notNull, `${getTableConfig(table).name}.${column} must be NOT NULL`).toBe(true);
  }
});

test('every table with owner_user_id is registered as user-owned and vice versa', () => {
  // `users.owner_user_id` names a preview principal's instructor (ADR-0003), not a data owner.
  const owned = withColumn('owner_user_id').filter((t) => t !== schema.users);
  expect(names([...userOwnedTables])).toEqual(names(owned));
});

test('forOwnRows reads across classes only from the tables of the recorded exception', () => {
  // ADR-0002 / docs/design/runner.md §8.4: the run cap counts a user's own runs in every class.
  expect(names([...ownRowsTables])).toEqual(['execution_jobs']);
  for (const table of ownRowsTables) {
    expect(names(classScopedTables)).toContain(getTableConfig(table).name);
    const col = getTableConfig(table).columns.find((c) => snake(c.name) === 'user_id');
    expect(col?.notNull).toBe(true);
  }
});
