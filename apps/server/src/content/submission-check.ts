import { Gate } from './gate';
import { runInThread } from './thread';

/**
 * Checks run two at a time in the API process, with at most 8 more waiting: each may hold a heap
 * of up to 512 MB, so unbounded threads could take the process down (§13). A burst past that is
 * refused with `GateBusy` (a retryable 503), never blamed on the file.
 */
const checks = new Gate(2, 8);

/**
 * Checks a submitted notebook's bytes in its own thread with a time bound and a heap cap, as
 * ingestion does for course notebooks (notebook-render.ts): the file is untrusted JSON up to
 * MAX_SUBMISSION_BYTES, and decoding, parsing and validating it is synchronous, so on the request
 * path it would stall every other request (§13). The bytes are moved into the thread, not
 * copied. Answers the environment the file declares; a notebook that is not valid UTF-8, fails
 * the nbformat contract, has too many cells, or passes either bound fails with `ThreadInputError`
 * carrying the reason. The time bound starts when a slot is free, not when the call is made.
 */
export function checkNotebookInThread(
  bytes: Uint8Array<ArrayBuffer>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<Record<string, string | number>> {
  return checks.run(() =>
    runInThread<Record<string, string | number>>(
      new URL('./submission-check.worker.mjs', import.meta.url),
      { bytes },
      {
        failed: 'The file is not a valid notebook',
        timeout: 'Checking the notebook took too long',
        outOfMemory: 'The notebook is too large to check',
      },
      { timeoutMs, maxHeapMb: 512, transferList: [bytes.buffer] },
    ),
  );
}
