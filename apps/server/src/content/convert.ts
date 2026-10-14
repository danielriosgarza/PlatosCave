import type { ResourceType } from '@parallax/contracts';
import { z } from 'zod';
import type { NotebookObject } from './notebook';
import { renderNotebookInThread } from './notebook-render';
import { extractPdfText } from './pdf-text';
import { renderReadingInThread, renderSlidesInThread } from './reading-render';
import { ThreadInputError } from './thread';

// The conversion entry (docs/design/course-folder.md §8): the reading job and a level 0 build
// convert a revision's source through it. It imports nothing under db/, and stores nothing.

/** Largest PDF the job reads into memory; P1-14 limits uploads below this. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Largest Markdown or HTML source: far more text than any reading, far less than a PDF. */
export const MAX_NATIVE_BYTES = 5 * 1024 * 1024;
/** Largest `.ipynb` file: uploads stop at 25 MB; images inside make notebooks large. */
export const MAX_NOTEBOOK_BYTES = 50 * 1024 * 1024;

/**
 * `content` of a `reading_native` revision: inline `markdown` or `html`, or an uploaded file
 * (`sourceKey` + `format`); `assets` maps image names in the source to the revision's objects.
 * `reading_pdf` names its file with `objectKey` (default: the revision's only object).
 */
const NativeContent = z.object({
  markdown: z.string().optional(),
  html: z.string().optional(),
  sourceKey: z.string().optional(),
  format: z.enum(['markdown', 'html']).optional(),
  assets: z.record(z.string(), z.string()).default({}),
});
/** `content` of a `slides_web` revision: the Markdown deck, slides separated by `---`. */
const WebSlidesContent = z.object({ markdown: z.string() });
/** Most slides one deck may have: far beyond a lecture, and the viewer's index lists every one. */
export const MAX_SLIDES = 500;
const PdfContent = z.object({ objectKey: z.string().optional() });
/** `content` of a `notebook` revision: its uploaded `.ipynb` file. */
const NotebookContent = z.object({ sourceKey: z.string() });

/**
 * A deck is raster-only when fewer than half of its pages carry any text: its slides are
 * images a screen reader cannot read, so publication requires a text alternative (spec §7).
 */
export function isRasterOnly(pages: readonly { text: string }[]): boolean {
  const withText = pages.filter((page) => page.text.trim() !== '').length;
  return withText * 2 < pages.length;
}

/** A problem with the reading itself: retrying cannot help, so the job ends failed at once. */
export class IngestError extends Error {}

/** A revision's source, as the revision stores it. */
export type ConvertSource = { type: ResourceType; content: unknown; objectKeys: readonly string[] };

export interface ConvertIo {
  /**
   * The bytes of one of the source's objects, in a buffer of their own (a PDF's buffer is moved
   * into its parsing thread); an `IngestError` when the object is missing or over `maxBytes`.
   */
  read(key: string, maxBytes: number): Promise<Uint8Array>;
  /** Where a notebook's output objects will be stored (`courses/{courseId}`); notebooks need it. */
  prefix?: string;
  /** Stops a conversion as it stops rendering. */
  signal?: AbortSignal;
}

/** Derived outputs (ADR-0003; `status` is not among them) and a notebook's output objects. */
export type Converted = { derived: Record<string, unknown>; objects: NotebookObject[] };

/** What editors call the revision's resource in job messages. */
const noun = (source: ConvertSource) =>
  source.type === 'slides_pdf' || source.type === 'slides_web'
    ? 'deck'
    : source.type === 'notebook'
      ? 'notebook'
      : 'reading';

export const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

/** A thread's final failure is the input's: the job ends failed at once rather than retrying. */
const bounded = <T>(work: Promise<T>): Promise<T> =>
  work.catch((err: unknown) => {
    throw err instanceof ThreadInputError ? new IngestError(err.message) : err;
  });

/**
 * Derived outputs of one reading, deck or notebook revision, rendered in the bounded threads.
 * A notebook is imported with its stored outputs; its images and HTML outputs are returned as
 * objects for the content origin, keyed under `io.prefix` as storage will name them.
 */
export async function convertRevision(source: ConvertSource, io: ConvertIo): Promise<Converted> {
  const { signal } = io;
  const read = (key: string, maxBytes: number) => {
    if (!source.objectKeys.includes(key)) {
      throw new IngestError(`The file is not part of this ${noun(source)}`);
    }
    return io.read(key, maxBytes);
  };
  if (source.type === 'notebook') {
    const content = NotebookContent.safeParse(source.content);
    if (!content.success) throw new IngestError('The notebook has no .ipynb file');
    const bytes = await read(content.data.sourceKey, MAX_NOTEBOOK_BYTES);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new IngestError('The notebook is not valid UTF-8 text');
    }
    if (io.prefix === undefined) throw new IngestError('This server cannot process uploaded files');
    const { notebook, objects, warnings } = await bounded(
      renderNotebookInThread(text, io.prefix, { signal }),
    );
    const types = Object.fromEntries(objects.map((o) => [o.key, o.contentType]));
    return { derived: { notebook, objects: types, warnings }, objects };
  }
  if (source.type === 'reading_native') {
    const content = NativeContent.safeParse(source.content);
    if (!content.success) throw new IngestError('The reading content is not valid');
    const { markdown, html, sourceKey, format, assets } = content.data;
    for (const key of Object.values(assets)) {
      if (!source.objectKeys.includes(key)) {
        throw new IngestError('An image is not an uploaded file of this reading');
      }
    }
    let text: string;
    let as: 'markdown' | 'html';
    if (markdown !== undefined) [text, as] = [markdown, 'markdown'];
    else if (html !== undefined) [text, as] = [html, 'html'];
    else if (sourceKey && format) {
      const bytes = await read(sourceKey, MAX_NATIVE_BYTES);
      text = new TextDecoder().decode(bytes);
      as = format;
    } else throw new IngestError('The reading has no Markdown or HTML source');
    if (Buffer.byteLength(text) > MAX_NATIVE_BYTES) {
      throw new IngestError(`The reading is larger than ${megabytes(MAX_NATIVE_BYTES)}`);
    }
    const rendered = await bounded(renderReadingInThread(text, as, assets, { signal }));
    const { blockMap, figures, warnings } = rendered;
    return { derived: { html: rendered.html, blockMap, figures, warnings }, objects: [] };
  }
  if (source.type === 'slides_web') {
    const content = WebSlidesContent.safeParse(source.content);
    if (!content.success) throw new IngestError('The deck has no Markdown source');
    if (Buffer.byteLength(content.data.markdown) > MAX_NATIVE_BYTES) {
      throw new IngestError(`The deck is larger than ${megabytes(MAX_NATIVE_BYTES)}`);
    }
    const { slides, blockMap, figures, warnings } = await bounded(
      renderSlidesInThread(content.data.markdown, { signal }),
    );
    if (slides.length === 0) throw new IngestError('The deck has no slides');
    if (slides.length > MAX_SLIDES) {
      throw new IngestError(`The deck has more than ${MAX_SLIDES} slides`);
    }
    // The slide count, as a PDF deck has: positions are validated against it.
    const derived = { slides, pageCount: slides.length, blockMap, figures, warnings };
    return { derived, objects: [] };
  }
  if (source.type === 'reading_pdf' || source.type === 'slides_pdf') {
    const content = PdfContent.safeParse(source.content);
    if (!content.success) throw new IngestError(`The ${noun(source)} content is not valid`);
    const key =
      content.data.objectKey ?? (source.objectKeys.length === 1 ? source.objectKeys[0] : undefined);
    if (!key) throw new IngestError(`The ${noun(source)} has no PDF file`);
    const bytes = await read(key, MAX_PDF_BYTES);
    const text = await bounded(extractPdfText(bytes, { signal, transfer: true }));
    if (source.type === 'reading_pdf') return { derived: { ...text }, objects: [] };
    // The original stays downloadable through content tokens; the viewer renders it in the browser.
    return { derived: { ...text, rasterOnly: isRasterOnly(text.pages) }, objects: [] };
  }
  throw new IngestError(`A ${source.type} resource has nothing to process`);
}
