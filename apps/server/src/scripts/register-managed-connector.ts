import { createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConnectorName } from '@parallax/contracts';
import { registerManagedConnector, withDatabase } from '../db/connectors/managed';

/**
 * `pnpm --filter @parallax/server connectors:register-managed --name NAME --public-key KEY`
 * (docs/design/connector.md §12): registers a managed connector, an `active` row with no owner,
 * and prints its id for `PARALLAX_CONNECTOR_ID`. KEY is the connector identity's Ed25519 public
 * key, as unpadded base64url of the 32 raw bytes or as the PEM that
 * `openssl pkey -in identity.key -pubout` prints. Needs `DATABASE_URL`.
 */

export const USAGE =
  'Usage: connectors:register-managed --name NAME --public-key KEY\n' +
  '  KEY: the Ed25519 public key of PARALLAX_IDENTITY_KEY_FILE, as unpadded base64url\n' +
  '       or as the PEM of `openssl pkey -in identity.key -pubout`. Needs DATABASE_URL.\n' +
  '  Both `--public-key KEY` and `--public-key=KEY` are accepted; a base64url key can start\n' +
  '  with "-", which is fine in either form.';

export class UsageError extends Error {}

const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;

/** The raw 32-byte Ed25519 key in `text`: unpadded base64url, or an SPKI PEM public key. */
export function parsePublicKey(text: string): Buffer {
  const value = text.trim();
  if (BASE64URL_KEY.test(value)) {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length === 32 && raw.toString('base64url') === value) return raw;
  }
  if (value.startsWith('-----BEGIN PUBLIC KEY-----')) {
    let key: ReturnType<typeof createPublicKey>;
    try {
      key = createPublicKey({ key: value, format: 'pem' });
    } catch {
      throw new UsageError('--public-key is not a readable PEM public key');
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new UsageError(`--public-key is a ${key.asymmetricKeyType} key, not an Ed25519 key`);
    }
    const x = key.export({ format: 'jwk' }).x;
    if (x) return Buffer.from(x, 'base64url');
  }
  throw new UsageError(
    '--public-key must be the 32-byte Ed25519 key as unpadded base64url, or a PEM public key',
  );
}

/**
 * `parseArgs` refuses `--public-key -abc…` as ambiguous (the value looks like an option), and an
 * unpadded base64url key starts with "-" about 1 time in 64. Joining the value to its option as
 * `--public-key=VALUE` is unambiguous, so the space form is rewritten to it.
 */
function joinPublicKeyValue(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    if (arg === '--public-key' && next !== undefined) {
      out.push(`--public-key=${next}`);
      i++;
    } else {
      out.push(arg);
    }
  }
  return out;
}

/** The command line, checked. */
export function parseCommandLine(argv: string[]): { name: string; publicKey: Buffer } {
  let values: { name?: string; 'public-key'?: string };
  try {
    ({ values } = parseArgs({
      args: joinPublicKeyValue(argv),
      options: { name: { type: 'string' }, 'public-key': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (values.name === undefined || values['public-key'] === undefined) {
    throw new UsageError('--name and --public-key are required');
  }
  const name = ConnectorName.safeParse(values.name.trim());
  if (!name.success) {
    throw new UsageError('--name must be 1–60 characters without control characters');
  }
  return { name: name.data, publicKey: parsePublicKey(values['public-key']) };
}

async function main(): Promise<number> {
  let input: ReturnType<typeof parseCommandLine>;
  try {
    input = parseCommandLine(process.argv.slice(2).filter((a) => a !== '--'));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    return 2;
  }
  const result = await withDatabase(url, (db) => registerManagedConnector(db, input, new Date()));
  if (!result.ok) {
    console.error('That public key is already registered to a connector; generate a new identity.');
    return 1;
  }
  console.log(`Registered managed connector "${input.name}", identity ${result.fingerprint}.`);
  console.log(`PARALLAX_CONNECTOR_ID=${result.connectorId}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
