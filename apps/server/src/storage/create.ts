import { resolve } from 'node:path';
import type { Config } from '../config';
import { FsStorage } from './fs';
import { S3Storage } from './s3';
import type { Storage } from './storage';

/** The object store STORAGE_DRIVER selects (config validation guarantees the s3 settings). */
export function createStorage(config: Config): Storage {
  if (config.STORAGE_DRIVER === 'fs') return new FsStorage(resolve(config.STORAGE_DIR));
  return new S3Storage({
    region: config.S3_REGION,
    bucket: config.S3_BUCKET as string,
    accessKeyId: config.S3_ACCESS_KEY_ID as string,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY as string,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    ...(config.S3_ENDPOINT && { endpoint: config.S3_ENDPOINT }),
  });
}
