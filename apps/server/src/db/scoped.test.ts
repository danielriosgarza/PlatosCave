import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import * as schema from './schema';
import { classScopedTables, courseScopedTables } from './scoped';

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
