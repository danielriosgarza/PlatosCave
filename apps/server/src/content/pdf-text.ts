import { createHash } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
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

/**
 * Page count and per-page text of an uploaded PDF reading, for accessible text and anchors.
 * Runs pdf.js without XFA forms, font loading or system fonts: the file is untrusted.
 */
export async function extractPdfText(data: Uint8Array): Promise<PdfText> {
  const task = getDocument({
    data,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      pages.push({
        text,
        textHash: createHash('sha256').update(normaliseText(text)).digest('hex'),
      });
      page.cleanup();
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await task.destroy();
  }
}
