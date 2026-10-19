import {
  type CourseManifest,
  type SyncHeader,
  siteIssueLines,
  syncHeader,
} from '@parallax/contracts';

/** The format `packages/cli/src/folder/bundle.ts` writes; its test holds the two equal. */
export const BUNDLE_FORMAT = 1;
/** The header carries every definition and is read whole, so its line is bounded. */
const MAX_HEADER = 64 * 2 ** 20;
const OTHER_FORMAT = `the bundle is not of format ${BUNDLE_FORMAT}, which this server reads: use parallax and a server of one release`;

type File = CourseManifest['files'][number];
export type Bundle = {
  header: SyncHeader;
  /**
   * One file's bytes for `checkedFile`, in the manifest's order: `size` bytes, and one more for the
   * last file, so that a byte after it is refused as that file's. Stopping early closes no input.
   */
  files(file: File): AsyncIterable<Uint8Array>;
};

/**
 * The script's reader of a `parallax sync` bundle (docs/design/course-folder.md §10): the header
 * as one line of JSON, then the bytes of `manifest.files` in order, each exactly its `size`, and
 * nothing after. The header names its `format` beside the fields of `syncHeader`, which checks
 * each definition again with `exerciseV1` or `testV1`. A malformed bundle gives lines that name
 * fields, never values.
 */
export async function readBundle(
  input: AsyncIterable<Uint8Array>,
): Promise<Bundle | { problems: string[] }> {
  const source = input[Symbol.asyncIterator]();
  let held = Buffer.alloc(0);
  /** The bytes read and not yet handed on, else the next chunk; undefined at the end. */
  const take = async () => {
    if (held.length > 0) return held;
    const next = await source.next();
    return next.done ? undefined : Buffer.from(next.value);
  };
  const malformed = (problem: string) => ({ problems: [problem] });
  const parts: Buffer[] = [];
  for (let length = 0; ; ) {
    const chunk = await take();
    if (!chunk) return malformed('the bundle ends before its header line does');
    const end = chunk.indexOf(10);
    held = end < 0 ? Buffer.alloc(0) : chunk.subarray(end + 1);
    parts.push(end < 0 ? chunk : chunk.subarray(0, end));
    if (end >= 0) break;
    length += chunk.length;
    if (length > MAX_HEADER) return malformed(`the header line is longer than ${MAX_HEADER} bytes`);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    // The parser's own message quotes the header.
    return malformed('the header is not JSON');
  }
  const { format, ...fields } = Object(json) as Record<string, unknown>;
  if (format !== BUNDLE_FORMAT) return malformed(OTHER_FORMAT);
  const parsed = syncHeader.safeParse(fields);
  if (!parsed.success) {
    return { problems: siteIssueLines(parsed.error.issues).map((line) => `header: ${line}`) };
  }
  const { files } = parsed.data.manifest;
  if (files.length === 0 && (await take())) {
    return malformed('bytes follow the header of a bundle without files');
  }
  async function* bytes(file: File) {
    for (let left = file.size + (file.path === files.at(-1)?.path ? 1 : 0); left > 0; ) {
      const chunk = await take();
      if (!chunk) return;
      const part = chunk.subarray(0, left);
      [held, left] = [chunk.subarray(part.length), left - part.length];
      yield part;
    }
  }
  return { header: parsed.data, files: bytes };
}
