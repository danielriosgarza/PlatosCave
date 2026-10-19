import { Readable } from 'node:stream';
import type { SyncHeader } from '@parallax/contracts';

/** The bundle's format, which the server's reader checks first (`content/folder-bundle.ts`). */
export const BUNDLE_FORMAT = 1;

/**
 * One course's bundle for the server's script (docs/design/course-folder.md §10): the header as
 * one line of JSON with the bundle's format, then the bytes of `manifest.files` in order, each
 * piped from disk and cut at its `size`, so a file that grew since it was read goes as it was
 * read. A file that shrank or cannot be read ends the bundle, so the script names it as short,
 * and `stopped` says why. The stream never fails: a failed source would leave the pipe open.
 */
export function syncBundle(header: SyncHeader, open: (file: string) => AsyncIterable<Uint8Array>) {
  let stopped: string | undefined;
  async function* bytes() {
    yield Buffer.from(`${JSON.stringify({ format: BUNDLE_FORMAT, ...header })}\n`);
    for (const { path, size } of header.manifest.files) {
      let left = size;
      try {
        for await (const chunk of open(path)) {
          const part = chunk.subarray(0, left);
          left -= part.length;
          if (part.length > 0) yield part;
          if (left === 0) break;
        }
      } catch (error) {
        stopped = `${path}: cannot be read (${(error as NodeJS.ErrnoException).code ?? error})`;
        return;
      }
      if (left > 0) {
        stopped = `${path}: shorter than when it was read`;
        return;
      }
    }
  }
  return { stream: Readable.from(bytes(), { objectMode: false }), stopped: () => stopped };
}
