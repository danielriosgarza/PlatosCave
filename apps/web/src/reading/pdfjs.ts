import 'pdfjs-dist/web/pdf_viewer.css';

/**
 * The one place pdf.js is imported. The legacy build is used because the modern one needs
 * `Map.prototype.getOrInsertComputed`, which Chromium 141 (the pinned Playwright browser) and
 * browsers of the same age lack. Loaded on first use so the shell stays light (§14). Tests
 * replace this module: pdf.js needs a canvas and a worker, which jsdom does not provide.
 */
export interface PdfDocument {
  pageCount: number;
  /** Draws page `n` (1-based) at `width` CSS pixels, with its selectable text layer. */
  renderPage(
    n: number,
    target: { canvas: HTMLCanvasElement; text: HTMLElement },
    width: number,
  ): Promise<{ width: number; height: number }>;
  destroy(): void;
}

export async function openPdf(data: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  return {
    pageCount: doc.numPages,
    async renderPage(n, { canvas, text }, width) {
      const page = await doc.getPage(n);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / natural.width });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas is not available');
      text.replaceChildren();
      text.style.setProperty('--scale-factor', String(viewport.scale));
      text.style.setProperty('--total-scale-factor', String(viewport.scale));
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: text,
        viewport,
      });
      await Promise.all([
        page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        }).promise,
        layer.render(),
      ]);
      return { width: viewport.width, height: viewport.height };
    },
    destroy: () => void task.destroy(),
  };
}
