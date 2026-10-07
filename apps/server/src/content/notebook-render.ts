import type { StoredNotebookOutput } from '@parallax/contracts';
import type { NotebookObject, RenderedNotebook } from './notebook';
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

/**
 * `renderLiveOutput` in the same thread script, bounded more tightly: one output, answered while
 * the person waits (docs/design/connector.md §14). Over a bound it fails with `ThreadInputError`.
 */
export function renderLiveOutputInThread(
  live: { data: Record<string, unknown>; executionCount: number | null },
  prefix: string,
  { timeoutMs = 20_000 }: { timeoutMs?: number } = {},
): Promise<{ output: StoredNotebookOutput; objects: NotebookObject[] }> {
  return runInThread(
    new URL('./notebook.worker.mjs', import.meta.url),
    { live, prefix },
    {
      failed: 'The output could not be rendered',
      timeout: 'Rendering the output took too long',
      outOfMemory: 'The output is too large to render',
    },
    { timeoutMs, maxHeapMb: 256 },
  );
}
