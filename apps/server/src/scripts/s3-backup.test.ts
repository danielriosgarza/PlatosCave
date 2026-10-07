import { describe, expect, test } from 'vitest';
import { BackupError, objectKeys, parseManifest } from './s3-backup';

const digest = 'a'.repeat(64);
const key = `courses/c1/objects/${digest}`;

describe('s3 backup helper', () => {
  test('lists content-addressed objects in order and skips in-flight uploads', () => {
    const other = `classes/k/submissions/objects/${'b'.repeat(64)}`;
    expect(objectKeys([key, 'tmp/123', other])).toEqual([other, key]);
  });

  test.each(['courses/notes.txt', '../escape', `courses/objects/${'A'.repeat(64)}`, '/abs'])(
    'refuses a bucket key that is not an object: %s',
    (bad) => {
      expect(() => objectKeys([key, bad])).toThrow(BackupError);
    },
  );

  test('reads storage.manifest lines', () => {
    expect(parseManifest(`${digest}\t12\t${key}\n`)).toEqual([{ sha256: digest, size: 12, key }]);
    expect(parseManifest('')).toEqual([]);
  });

  test.each([
    ['a digest that is not the key', `${'b'.repeat(64)}\t12\t${key}`],
    ['a size that is not a number', `${digest}\tx\t${key}`],
    ['an unsafe key', `${digest}\t12\t../objects/${digest}`],
    ['an extra field', `${digest}\t12\t${key}\textra`],
  ])('refuses a manifest with %s', (_what, line) => {
    expect(() => parseManifest(`${line}\n`)).toThrow(BackupError);
  });
});
