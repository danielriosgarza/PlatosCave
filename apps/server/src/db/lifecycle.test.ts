import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import { accountDeletion } from './lifecycle';
import * as schema from './schema';

const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

test('every table that refers to a person declares what account deletion does to it', () => {
  // P3-AUD10: Phase 3 tables were missed once; a new table must be decided on, not forgotten.
  const referring = tables
    .filter((t) =>
      getTableConfig(t).foreignKeys.some((fk) => fk.reference().foreignTable === schema.users),
    )
    .map((t) => getTableConfig(t).name)
    .sort();
  expect(Object.keys(accountDeletion).sort()).toEqual(referring);
});
