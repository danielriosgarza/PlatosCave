import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import type { NbNotebook } from '@parallax/contracts';
import { checkNotebookInThread } from './submission-check';
import { ThreadInputError } from './thread';

/** A problem with the submitted file itself, answered as a 400 that names it. */
export class SubmissionRejected extends Error {}

/** The file went over the size limit, answered as a 413. */
export class SubmissionTooLarge extends Error {}

/** The file name as shown back: no directories, no control characters, at most 200 characters. */
export const submissionFilename = (name: string): string =>
  [...basename(name.replaceAll('\\', '/'))]
    .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
    .join('')
    .slice(0, 200);

/**
 * Passes a submitted `.ipynb` through while checking it: UTF-8 text without NUL bytes, not empty,
 * within the stream's size limit, and a valid nbformat 4 notebook of at most
 * MAX_SUBMISSION_CELLS cells (§10.7). The bytes are decoded and parsed in a bounded thread, off the
 * event loop, and kept as data; nothing in it is executed or rendered. What the file says about its
 * environment is handed to `onChecked` before the stream ends, so a refusal throws before the
 * object is recorded. A refusal
 * leaves the stream open for the caller to drain.
 */
export async function* checkedNotebook(
  stream: Readable & { truncated?: boolean },
  onChecked: (environment: Record<string, string | number>) => void,
): AsyncGenerator<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream.iterator({
    destroyOnReturn: false,
  }) as AsyncIterable<Buffer>) {
    if (chunk.includes(0)) throw new SubmissionRejected('The file is not text');
    chunks.push(chunk);
    size += chunk.length;
    yield chunk;
  }
  // The parser stops at the limit without an error; refusing here keeps the object unstored.
  if (stream.truncated) throw new SubmissionTooLarge();
  if (size === 0) throw new SubmissionRejected('The file is empty');
  // One copy that the thread takes over; it decodes (UTF-8 is checked there) and parses.
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  chunks.length = 0;
  try {
    onChecked(await checkNotebookInThread(bytes));
  } catch (err) {
    if (err instanceof ThreadInputError) throw new SubmissionRejected(err.message);
    throw err;
  }
}

const clean = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = [...value]
    .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, 80);
  return text || undefined;
};

/**
 * What the file says about where it was made: the kernel and language it names and whether it
 * carries Colab's metadata. Declared by the file, so recorded as a hint for review, never as a
 * fact about the machine or a trust signal (§10.5).
 */
export function notebookEnvironment(notebook: NbNotebook): Record<string, string | number> {
  const { kernelspec, language_info, colab } = notebook.metadata as {
    kernelspec?: { name?: unknown; display_name?: unknown };
    language_info?: { name?: unknown; version?: unknown };
    colab?: unknown;
  };
  const entries: [string, string | number | undefined][] = [
    ['runtime', colab !== undefined ? 'colab' : undefined],
    ['kernel', clean(kernelspec?.display_name) ?? clean(kernelspec?.name)],
    ['language', clean(language_info?.name)],
    ['languageVersion', clean(language_info?.version)],
    ['nbformat', `${notebook.nbformat}.${notebook.nbformat_minor}`],
  ];
  return Object.fromEntries(
    entries.filter((e): e is [string, string | number] => e[1] !== undefined),
  );
}
