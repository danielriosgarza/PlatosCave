import { Worker } from 'node:worker_threads';

/**
 * The input the thread was given is the problem: the script said so, or the work went past the
 * memory cap or the time bound. Retrying the same input cannot help.
 */
export class ThreadInputError extends Error {}

/** What the caller tells the person for each final failure. */
export interface ThreadMessages {
  /** The script replied `{ ok: false }` (it could not process the input). */
  failed: string;
  /** The time bound passed. */
  timeout: string;
  /** The thread hit its heap cap. */
  outOfMemory: string;
}

export interface ThreadOptions {
  /** Wall-clock bound for one input; well under the queue's 15-minute job expiry. */
  timeoutMs: number;
  /**
   * Heap cap of the thread, so one input cannot exhaust the worker process. A process-wide
   * `--max-old-space-size` (for example in NODE_OPTIONS) overrides it; workers must not set one.
   */
  maxHeapMb: number;
  /** Stops the thread (pg-boss signals this when the job is stopped); not a file problem. */
  signal?: AbortSignal;
  /** Buffers moved into the thread rather than copied; they are detached here afterwards. */
  transferList?: ArrayBuffer[];
}

/**
 * A thread script answers once with `{ ok: true, value }`, or `{ ok: false }` for bad input,
 * optionally with the reason to show instead of `messages.failed`.
 */
export type ThreadReply<T> = { ok: true; value: T } | { ok: false; error?: string };

/**
 * Runs one script in its own thread on `input`, bounded in time and memory, so untrusted input
 * can neither block the job worker's event loop nor exhaust its process. Only the script's own
 * `{ ok: false }`, the heap cap and the time bound are final (`ThreadInputError`); every other
 * failure (the thread cannot start, its imports fail, it exits without answering, an abort) is a
 * plain `Error`, so pg-boss retries the job.
 */
export function runInThread<T>(
  script: URL,
  input: unknown,
  messages: ThreadMessages,
  { timeoutMs, maxHeapMb, signal, transferList = [] }: ThreadOptions,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let thread: Worker | undefined;
    const finish = (err: Error | null, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void thread?.terminate();
      if (err) reject(err);
      else resolve(value as T);
    };
    const onAbort = () => finish(new Error('The work was stopped before it finished'));
    if (signal?.aborted) return onAbort();
    try {
      thread = new Worker(script, {
        workerData: input,
        transferList,
        resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
      });
    } catch (err) {
      return finish(err instanceof Error ? err : new Error(String(err)));
    }
    timer = setTimeout(() => finish(new ThreadInputError(messages.timeout)), timeoutMs);
    signal?.addEventListener('abort', onAbort);
    thread.once('message', (reply: ThreadReply<T>) => {
      if (reply.ok) finish(null, reply.value);
      else finish(new ThreadInputError(reply.error ?? messages.failed));
    });
    thread.once('error', (err: Error & { code?: string }) => {
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY')
        finish(new ThreadInputError(messages.outOfMemory));
      else finish(new Error(`The processing thread failed: ${err.message}`));
    });
    thread.once('exit', (code) => {
      finish(new Error(`The processing thread exited (code ${code}) without a result`));
    });
  });
}
