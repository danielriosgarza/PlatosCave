import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { siteIssueLines, siteSetup } from '@parallax/contracts';
import { withDatabase } from '../db/connectors/managed';
import { applySetup } from '../db/setup';

/**
 * The server side of `parallax apply` (docs/design/site.md §8), run on the server's host as
 * `docker compose run --rm -T server node_modules/.bin/tsx src/scripts/apply-site.ts` with the
 * `siteSetup` document on standard input, so no address or code is on a command line. Needs
 * DATABASE_URL. Prints one line for each class as it is done (for an open class its join link)
 * and exits with what `applySetup` returns: 0 when every class is set up, 1 when an account is
 * missing or a class is pending or refused. A malformed document exits 2 before the database is
 * opened, and its lines name fields, never the document's values.
 */
export async function applySite(
  input: string,
  url: string | undefined,
  print: (line: string) => void,
  warn: (line: string) => void,
): Promise<0 | 1 | 2> {
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    // The parser's own message quotes the input.
    warn('the setup document is not JSON');
    return 2;
  }
  const doc = siteSetup.safeParse(json);
  if (!doc.success) {
    for (const line of siteIssueLines(doc.error.issues)) warn(`setup document: ${line}`);
    return 2;
  }
  if (!url) {
    warn('DATABASE_URL is required');
    return 2;
  }
  return withDatabase(url, (db) => applySetup(db, doc.data, print));
}

/**
 * The one line for an error that ends the run, which `applySetup` does not catch; the lines of
 * the classes done before it are already printed. A failed query's message holds the query's
 * parameters, the document's addresses among them, so only the code is named (a SQLSTATE such
 * as `40001`, or a system code such as `ECONNREFUSED`), else the error's kind.
 */
export function stopLine(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const code = (cause as { code?: unknown } | null)?.code;
  const kind = cause instanceof Error ? cause.name : typeof cause;
  return `apply stopped by an error: ${typeof code === 'string' ? code : kind}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const input = await text(process.stdin);
  const print = (line: string) => console.log(line);
  const warn = (line: string) => console.error(line);
  applySite(input, process.env.DATABASE_URL, print, warn).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(stopLine(err));
      process.exit(1);
    },
  );
}
