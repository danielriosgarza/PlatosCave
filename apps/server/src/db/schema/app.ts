import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const appSettings = pgTable('app_settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow(),
});
