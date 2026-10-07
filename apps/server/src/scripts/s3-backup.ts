import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

/**
 * The bucket side of scripts/backup.sh and scripts/restore.sh for `STORAGE_DRIVER=s3`
 * (spec §13, P4-07a). Reads the same S3_* variables as the server (src/config.ts):
 *
 *   s3-backup.ts download <dir>           every object of the bucket into <dir>/<key>
 *   s3-backup.ts check-empty              fails unless the bucket exists and holds no object
 *   s3-backup.ts upload <dir> <manifest> <written>
 *                                         every manifest object from <dir>/<key>, never over an
 *                                         existing key; each key is appended to <written> once
 *                                         stored, so a failed restore removes only its own
 *   s3-backup.ts verify <manifest>        the bucket holds exactly the manifest's objects,
 *                                         byte for byte
 *   s3-backup.ts remove <written>         deletes the keys listed in <written>
 *
 * The shell scripts keep the checks the fs driver has: the backup hashes what it downloaded,
 * and the restore checks the backup before any of these run.
 */

/** In-flight uploads of the s3 adapter (src/storage/s3.ts); the fs adapter's `.tmp` likewise. */
const TMP_PREFIX = 'tmp/';
/** A content-addressed key: safe path segments, then objects/<sha256> (src/storage/storage.ts). */
const OBJECT_KEY =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*\/objects\/[0-9a-f]{64}$/;

export class BackupError extends Error {}

export interface ManifestEntry {
  sha256: string;
  size: number;
  key: string;
}

/** storage.manifest: <sha256> TAB <size> TAB <key>, one line per object. */
export function parseManifest(text: string): ManifestEntry[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [sha256, size, key, ...rest] = line.split('\t');
      if (
        rest.length > 0 ||
        !sha256 ||
        !key ||
        !OBJECT_KEY.test(key) ||
        !/^[0-9]+$/.test(size ?? '') ||
        key.slice(-64) !== sha256
      ) {
        throw new BackupError(`malformed manifest line: ${JSON.stringify(line)}`);
      }
      return { sha256, size: Number(size), key };
    });
}

/** The objects a bucket listing must be: content-addressed keys, in-flight uploads aside. */
export function objectKeys(listed: string[]): string[] {
  const keys = listed.filter((key) => !key.startsWith(TMP_PREFIX));
  const bad = keys.filter((key) => !OBJECT_KEY.test(key));
  if (bad.length > 0) {
    throw new BackupError(
      `the bucket holds keys that are not content-addressed objects: ${bad.map((k) => JSON.stringify(k)).join(', ')}`,
    );
  }
  return keys.sort();
}

export function clientFromEnv(env: NodeJS.ProcessEnv): { client: S3Client; bucket: string } {
  for (const name of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
    if (!env[name]) throw new BackupError(`${name} is required for STORAGE_DRIVER=s3`);
  }
  const client = new S3Client({
    region: env.S3_REGION || 'garage',
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID as string,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    },
    ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
  });
  return { client, bucket: env.S3_BUCKET as string };
}

async function listAll(client: S3Client, bucket: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const object of res.Contents ?? []) keys.push(object.Key as string);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

const isMissing = (err: unknown) => {
  const name = (err as { name?: string }).name;
  return name === 'NoSuchKey' || name === 'NotFound';
};

async function exists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export async function download(client: S3Client, bucket: string, dir: string): Promise<number> {
  const keys = objectKeys(await listAll(client, bucket));
  for (const key of keys) {
    const path = join(dir, key);
    await mkdir(dirname(path), { recursive: true });
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    // `wx`: two listed keys never land on one file.
    await pipeline(res.Body as Readable, createWriteStream(path, { flags: 'wx' }));
  }
  return keys.length;
}

export async function checkEmpty(client: S3Client, bucket: string): Promise<void> {
  const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
  if ((res.KeyCount ?? res.Contents?.length ?? 0) > 0) {
    throw new BackupError(`bucket ${bucket} is not empty`);
  }
}

export async function upload(
  client: S3Client,
  bucket: string,
  dir: string,
  manifest: ManifestEntry[],
  written: string,
): Promise<void> {
  for (const { key } of manifest) {
    // The bucket was empty when the restore began; a key that appeared since is not ours.
    if (await exists(client, bucket, key)) {
      throw new BackupError(`bucket ${bucket} already holds ${key}`);
    }
    await new Upload({
      client,
      params: { Bucket: bucket, Key: key, Body: createReadStream(join(dir, key)) },
    }).done();
    await appendFile(written, `${key}\n`);
  }
}

export async function verify(
  client: S3Client,
  bucket: string,
  manifest: ManifestEntry[],
): Promise<void> {
  const listed = (await listAll(client, bucket)).sort();
  const expected = manifest.map((m) => m.key).sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    throw new BackupError(`objects in bucket ${bucket} differ from storage.manifest`);
  }
  for (const { key, sha256, size } of manifest) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const hash = createHash('sha256');
    let length = 0;
    for await (const chunk of res.Body as Readable) {
      hash.update(chunk as Buffer);
      length += (chunk as Buffer).length;
    }
    if (hash.digest('hex') !== sha256 || length !== size) {
      throw new BackupError(`object ${key} in bucket ${bucket} does not match storage.manifest`);
    }
  }
}

export async function remove(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  for (const key of keys) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

const USAGE =
  'usage: s3-backup.ts download <dir> | check-empty | upload <dir> <manifest> <written> | ' +
  'verify <manifest> | remove <written>';

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const { client, bucket } = clientFromEnv(process.env);
  try {
    if (command === 'download' && args.length === 1) {
      console.log(await download(client, bucket, args[0] as string));
    } else if (command === 'check-empty' && args.length === 0) {
      await checkEmpty(client, bucket);
    } else if (command === 'upload' && args.length === 3) {
      const [dir, manifest, written] = args as [string, string, string];
      await upload(client, bucket, dir, parseManifest(await readFile(manifest, 'utf8')), written);
    } else if (command === 'verify' && args.length === 1) {
      await verify(client, bucket, parseManifest(await readFile(args[0] as string, 'utf8')));
    } else if (command === 'remove' && args.length === 1) {
      const keys = (await readFile(args[0] as string, 'utf8')).split('\n').filter(Boolean);
      await remove(client, bucket, keys);
    } else {
      throw new BackupError(USAGE);
    }
  } finally {
    client.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof BackupError ? err.message : err);
    process.exit(1);
  });
}
