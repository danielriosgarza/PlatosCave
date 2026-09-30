import pg from 'pg';

/** Same URL (query params kept) pointing at the maintenance database `postgres`. */
export function adminUrl(url: string): string {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return admin.toString();
}

/** Runs `fn` with a client connected to the maintenance database, always closing it. */
export async function withAdminClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl(url) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
