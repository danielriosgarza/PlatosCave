import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { normaliseText } from './reading';

export interface PdfPage {
  /** Text of the page in reading order (empty for scanned pages without a text layer). */
  text: string;
  /** sha256 of the normalised text: PDF anchors map to a new revision when it matches (ADR-0003). */
  textHash: string;
}

export interface PdfText {
  pageCount: number;
  pages: PdfPage[];
}

/** The file could not be read as a PDF, or reading it went past the time or memory bound. */
export class PdfReadError extends Error {}

export interface ExtractOptions {
  /** Wall-clock bound for one file; well under the queue's 15-minute job expiry. */
  timeoutMs?: number;
  /** Aborts parsing (pg-boss signals this when the job is stopped). */
  signal?: AbortSignal;
}

/**
 * Page count and per-page text of an uploaded PDF reading, for accessible text and anchors.
 * The file is untrusted: pdf.js runs in its own thread with a memory cap and a time bound
 * (without XFA, font loading or system fonts), so it can neither block other jobs nor exhaust
 * the worker process.
 */
export function extractPdfText(
  data: Uint8Array,
  { timeoutMs = 120_000, signal }: ExtractOptions = {},
): Promise<PdfText> {
  return new Promise((resolve, reject) => {
    const thread = new Worker(new URL('./pdf-text.worker.mjs', import.meta.url), {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let done = false;
    const finish = (err: Error | null, value?: PdfText) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void thread.terminate();
      if (err) reject(err);
      else resolve(value as PdfText);
    };
    const onAbort = () => finish(new Error('PDF reading was aborted'));
    const timer = setTimeout(
      () => finish(new PdfReadError('Reading the PDF took too long')),
      timeoutMs,
    );
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    thread.once('message', (msg: { ok: true; pages: string[] } | { ok: false }) => {
      if (!msg.ok) return finish(new PdfReadError('The file could not be read as a PDF'));
      const pages = msg.pages.map((text) => ({
        text,
        textHash: createHash('sha256').update(normaliseText(text)).digest('hex'),
      }));
      finish(null, { pageCount: pages.length, pages });
    });
    // A thread that dies (memory cap) or exits without answering is a file problem.
    thread.once('error', () => finish(new PdfReadError('The PDF is too complex to read')));
    thread.once('exit', () => finish(new PdfReadError('The file could not be read as a PDF')));
  });
}
