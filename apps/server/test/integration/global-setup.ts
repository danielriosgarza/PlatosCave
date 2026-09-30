import pg from 'pg';
import { runMigrations } from '../../src/db/migrate';

export const TEMPLATE_DB = 'parallax_template';

function adminUrl(): URL {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for integration tests');
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return admin;
}

export default async function setup(): Promise<void> {
  const admin = adminUrl();
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`drop database if exists ${TEMPLATE_DB} with (force)`);
    await client.query(`create database ${TEMPLATE_DB}`);
  } finally {
    await client.end();
  }
  const template = new URL(admin);
  template.pathname = `/${TEMPLATE_DB}`;
  await runMigrations(template.toString());
}
