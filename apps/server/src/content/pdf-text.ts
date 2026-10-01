import { createHash } from 'node:crypto';
import { normaliseText } from './reading';
import { runInThread } from './thread';

export interface PdfPage {
  /** Text of the page in reading order (empty for scanned pages without a text layer). */
  text: string;
  /** sha256 of the normalised text: PDF anchors map to a new revision when it matches (ADR-0003). */
  textHash: string;
}

export interface PdfText {
  pageCount: number;
  pages: PdfPage[];
  /** Pages whose text could not be read; the rest of the file still ingests. */
  warnings: string[];
}

export interface ExtractOptions {
  /** Wall-clock bound for one file; well under the queue's 15-minute job expiry. */
  timeoutMs?: number;
  /** Aborts parsing (pg-boss signals this when the job is stopped). */
  signal?: AbortSignal;
}

/** What the thread answers: each page's raw text, null for a page it could not read. */
interface RawPages {
  pages: (string | null)[];
}

/** Page text as stored: Postgres refuses U+0000 inside jsonb, and it is never meaningful text. */
export const cleanPageText = (text: string): string => text.replaceAll('\u0000', '');

/**
 * Page count and per-page text of an uploaded PDF reading, for accessible text and anchors.
 * The file is untrusted: pdf.js runs in its own thread with a memory cap and a time bound
 * (without XFA, font loading, system fonts or eval), so it can neither block other jobs nor
 * exhaust the worker process. `data` is moved into the thread, not copied: it is detached here
 * afterwards. A file that cannot be read fails with `ThreadInputError`.
 */
export async function extractPdfText(
  data: Uint8Array,
  { timeoutMs = 120_000, signal }: ExtractOptions = {},
): Promise<PdfText> {
  const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
  const { pages: raw } = await runInThread<RawPages>(
    new URL('./pdf-text.worker.mjs', import.meta.url),
    data,
    {
      failed: 'The file could not be read as a PDF',
      timeout: 'Reading the PDF took too long',
      outOfMemory: 'The PDF is too complex to read',
    },
    {
      timeoutMs,
      maxHeapMb: 512,
      signal,
      // Only a view over a whole, unshared buffer can be moved; anything else is copied.
      ...(whole && data.buffer instanceof ArrayBuffer && { transferList: [data.buffer] }),
    },
  );
  const warnings: string[] = [];
  const pages = raw.map((value, i) => {
    if (value === null) warnings.push(`Page ${i + 1} could not be read; it has no text`);
    const text = cleanPageText(value ?? '');
    return { text, textHash: createHash('sha256').update(normaliseText(text)).digest('hex') };
  });
  return { pageCount: pages.length, pages, warnings };
}
