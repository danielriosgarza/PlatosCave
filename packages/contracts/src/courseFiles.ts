import { parseNotebook } from './notebook';
import { MAX_UPLOAD_BYTES, type UploadFormat, uploadFormats } from './routes/authoring';
import { WorkspacePath } from './routes/transfers';

/**
 * The upload rules as functions over bytes, for the files of a course folder
 * (docs/design/course-folder.md §8). They restate, with the same sentences, the checks of the
 * upload routes (`checked` and `nonEmpty` in the server's `authoring.routes.ts`) and the editor's
 * `declareFiles`; `courseFiles.test.ts` and the A40 test of P5-18 hold the copies equal. The web
 * application imports the index, so no Node built-in: bytes are `Uint8Array`, hashing the caller's.
 */

/** The content type each kind of file is stored with; `data` is a notebook's data file. */
export const storedContentTypes = {
  markdown: 'text/markdown',
  html: 'text/html',
  pdf: 'application/pdf',
  notebook: 'application/x-ipynb+json',
  data: 'application/octet-stream',
} as const satisfies Record<UploadFormat | 'data', string>;
export type CourseFileFormat = keyof typeof storedContentTypes;

/** A notebook declares at most this many data files (the server reads no more). */
export const MAX_DATA_FILES = 100;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** A file the rules refuse. The message is the sentence the upload route or the editor gives. */
export class CourseFileRefused extends Error {}
function refuse(message: string): never {
  throw new CourseFileRefused(message);
}

/** The format an uploaded file has by the extension of its name, compared in lower case. */
export function uploadFormatOf(name: string): UploadFormat {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  // Own keys only: `constructor` and the like are not extensions.
  if (!name.includes('.') || !Object.hasOwn(uploadFormats, extension)) {
    refuse('Upload a Markdown (.md), HTML (.html), PDF (.pdf) or notebook (.ipynb) file');
  }
  return uploadFormats[extension as keyof typeof uploadFormats];
}

/**
 * The rules for one file, fed in order while it is stored: `push` each chunk, then `end`, which
 * gives the content type it is stored with. Only the first MAX_UPLOAD_BYTES are judged before a
 * longer file is refused for its size, as the route's parser hands on no more.
 */
export function courseFileCheck(format: CourseFileFormat) {
  const text = format !== 'pdf' && format !== 'data';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let notebook = '';
  let size = 0;
  const decode = (chunk?: Uint8Array) => {
    try {
      const part = text ? decoder.decode(chunk, { stream: chunk !== undefined }) : '';
      // A notebook is kept, to be checked whole against the import contract (§10.7).
      if (format === 'notebook') notebook += part;
    } catch {
      refuse('The text is not valid UTF-8');
    }
  };
  return {
    push(chunk: Uint8Array): void {
      const judged = chunk.subarray(0, MAX_UPLOAD_BYTES - size);
      // The first bytes may come in pieces; each is judged at its place in the file.
      const magic = format === 'pdf' ? PDF_MAGIC.slice(size, size + judged.length) : [];
      if (magic.some((byte, i) => judged[i] !== byte)) refuse('The file is not a PDF');
      if (text && judged.includes(0)) refuse('The file is not text');
      decode(judged);
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES)
        refuse(`The file is larger than ${MAX_UPLOAD_BYTES / 2 ** 20} MB`);
    },
    end(): string {
      if (format === 'pdf' && size > 0 && size < PDF_MAGIC.length) refuse('The file is not a PDF');
      decode();
      if (size === 0) refuse('The file is empty');
      const parsed = format === 'notebook' ? parseNotebook(notebook) : undefined;
      if (parsed && !parsed.ok) refuse(parsed.error);
      return storedContentTypes[format];
    },
  };
}

/** The rules for one file held whole; gives the content type it is stored with. */
export function checkCourseFile(format: CourseFileFormat, bytes: Uint8Array): string {
  const check = courseFileCheck(format);
  check.push(bytes);
  return check.end();
}

/** The rules for the data files of one notebook, by their workspace paths. */
export function checkDataPaths(paths: readonly string[]): void {
  if (paths.length > MAX_DATA_FILES) refuse(`A notebook declares at most ${MAX_DATA_FILES} files`);
  const bad = paths.find((path) => !WorkspacePath.safeParse(path).success);
  if (bad !== undefined)
    refuse(`“${bad}” is no relative path without empty, dot or hidden segments`);
}

/**
 * The editor's `declareFiles`, restated: the notebook with `metadata.parallax.files` set to the
 * declared files and every other part kept. Refuses a text that is not a JSON object.
 */
export function declareWorkspaceFiles(
  notebookText: string,
  files: readonly { path: string; resourceId: string }[],
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(notebookText);
  } catch {
    refuse('The notebook is not valid JSON');
  }
  const record = (value: unknown) =>
    typeof value === 'object' && value && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const notebook = record(parsed) ?? refuse('The notebook is not a Jupyter notebook');
  const metadata = record(notebook.metadata) ?? {};
  const parallax = { ...record(metadata.parallax), files: [...files] };
  return JSON.stringify({ ...notebook, metadata: { ...metadata, parallax } });
}
