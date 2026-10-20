import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** A file is read in parts of this size, in turn: nothing holds a whole one. */
export const PART = 2 ** 20;

/**
 * A file's `sha256` and size, hashed part by part: a course file, or an image archive of the
 * release, which may pass the 2 GiB that `readFileSync` can return.
 */
export function fileDigest(file: string, part = PART) {
  if (!(Number.isInteger(part) && part > 0)) {
    throw new RangeError(`A part is a positive whole number of bytes, not ${part}`);
  }
  const [hash, buffer] = [createHash('sha256'), Buffer.allocUnsafe(part)];
  const descriptor = fs.openSync(file, 'r');
  let [size, length] = [0, part];
  try {
    while (length > 0) {
      length = fs.readSync(descriptor, buffer, 0, part, size);
      hash.update(buffer.subarray(0, length));
      size += length;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: hash.digest('hex'), size };
}
