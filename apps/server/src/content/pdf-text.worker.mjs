// Parses one untrusted PDF off the job worker's event loop (see pdf-text.ts). Plain JavaScript so
// the thread starts without a TypeScript loader.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const task = getDocument({
  data: workerData,
  enableXfa: false,
  disableFontFace: true,
  useSystemFonts: false,
  // pdfjs-dist 6.3 has no eval path and ignores this; set for builds that compile PostScript
  // functions with `new Function` when it is true. Text extraction needs none.
  isEvalSupported: false,
  stopAtErrors: false,
  verbosity: 0,
});
let reply;
try {
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    // One unreadable page leaves that page without text; the rest of the document still counts.
    try {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      }
      pages.push(text);
      page.cleanup();
    } catch {
      pages.push(null);
    }
  }
  reply = { ok: true, value: { pages } };
} catch {
  reply = { ok: false };
}
parentPort?.postMessage(reply);
await task.destroy();
