import { withAdminClient } from '../../src/db/admin';
import { runMigrations } from '../../src/db/migrate';

export const TEMPLATE_DB = 'parallax_template';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for integration tests');
  return url;
}

async function dropStale(): Promise<void> {
  await withAdminClient(databaseUrl(), async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      `select datname from pg_database where datname like 'test\\_%'`,
    );
    for (const { datname } of rows) {
      await client.query(`drop database if exists "${datname}" with (force)`);
    }
    await client.query(`drop database if exists ${TEMPLATE_DB} with (force)`);
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  const url = databaseUrl();
  await dropStale();
  await withAdminClient(url, (client) => client.query(`create database ${TEMPLATE_DB}`));
  const template = new URL(url);
  template.pathname = `/${TEMPLATE_DB}`;
  await runMigrations(template.toString());
  return dropStale;
}
