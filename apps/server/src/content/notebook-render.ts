import type { RenderedNotebook } from './notebook';
import { runInThread } from './thread';

/**
 * `renderNotebook` in its own thread with a time bound and a heap cap, as for readings: the file
 * is untrusted JSON with Markdown, HTML and base64 images inside, and parsing it is synchronous.
 * A notebook that fails the import contract, or one past either bound, fails with
 * `ThreadInputError` carrying the reason.
 */
export function renderNotebookInThread(
  text: string,
  prefix: string,
  { timeoutMs = 120_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RenderedNotebook> {
  return runInThread<RenderedNotebook>(
    new URL('./notebook.worker.mjs', import.meta.url),
    { text, prefix },
    {
      failed: 'The notebook could not be rendered',
      timeout: 'Rendering the notebook took too long',
      outOfMemory: 'The notebook is too large to render',
    },
    { timeoutMs, maxHeapMb: 512, signal },
  );
}
