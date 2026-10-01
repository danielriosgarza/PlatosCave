// Parses one untrusted PDF off the job worker's event loop (see pdf-text.ts). Plain JavaScript so
// the thread starts without a TypeScript loader.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const task = getDocument({
  data: workerData,
  enableXfa: false,
  disableFontFace: true,
  useSystemFonts: false,
  stopAtErrors: false,
  verbosity: 0,
});
try {
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
    }
    pages.push(text);
    page.cleanup();
  }
  parentPort?.postMessage({ ok: true, pages });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.name : 'Error' });
} finally {
  await task.destroy();
}
