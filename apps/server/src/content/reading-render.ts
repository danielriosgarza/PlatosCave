import type { ReadingFormat, RenderedReading, RenderedSlides } from './reading';
import { runInThread } from './thread';

export interface RenderOptions {
  /** Wall-clock bound for one reading. */
  timeoutMs?: number;
  /** Stops rendering (pg-boss signals this when the job is stopped). */
  signal?: AbortSignal;
}

/**
 * `renderReading` in its own thread with a time bound and a heap cap: the source is untrusted
 * and the unified pipeline is synchronous, so a pathological reading must not stall the worker.
 * A reading the pipeline rejects, or one past either bound, fails with `ThreadInputError`.
 */
export function renderReadingInThread(
  source: string,
  format: ReadingFormat,
  assets: Record<string, string>,
  { timeoutMs = 60_000, signal }: RenderOptions = {},
): Promise<RenderedReading> {
  return runInThread<RenderedReading>(
    new URL('./reading.worker.mjs', import.meta.url),
    { source, format, assets },
    {
      failed: 'The reading could not be rendered',
      timeout: 'Rendering the reading took too long',
      outOfMemory: 'The reading is too complex to render',
    },
    { timeoutMs, maxHeapMb: 256, signal },
  );
}

/** `renderSlides` in the same bounded thread, for a Markdown slide deck. */
export function renderSlidesInThread(
  source: string,
  { timeoutMs = 60_000, signal }: RenderOptions = {},
): Promise<RenderedSlides> {
  return runInThread<RenderedSlides>(
    new URL('./reading.worker.mjs', import.meta.url),
    { source, format: 'markdown', assets: {}, deck: true },
    {
      failed: 'The slides could not be rendered',
      timeout: 'Rendering the slides took too long',
      outOfMemory: 'The slides are too complex to render',
    },
    { timeoutMs, maxHeapMb: 256, signal },
  );
}
