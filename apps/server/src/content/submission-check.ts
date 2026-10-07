import { runInThread } from './thread';

/**
 * Checks a submitted notebook's text in its own thread with a time bound and a heap cap, as
 * ingestion does for course notebooks (notebook-render.ts): the file is untrusted JSON up to
 * MAX_SUBMISSION_BYTES, and parsing and validating it is synchronous, so on the request path it
 * would stall every other request (§13). Answers the environment the file declares; a notebook
 * that fails the nbformat contract, has too many cells, or passes either bound fails with
 * `ThreadInputError` carrying the reason.
 */
export async function checkNotebookInThread(
  text: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<Record<string, string | number>> {
  return runInThread<Record<string, string | number>>(
    new URL('./submission-check.worker.mjs', import.meta.url),
    { text },
    {
      failed: 'The file is not a valid notebook',
      timeout: 'Checking the notebook took too long',
      outOfMemory: 'The notebook is too large to check',
    },
    { timeoutMs, maxHeapMb: 512 },
  );
}
