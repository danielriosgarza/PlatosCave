import type { FastifyBaseLogger } from 'fastify';

/**
 * Work that starts during a request but must not hold its answer (mail delivery). Each task
 * handles its own failures; `settled()` lets shutdown, and tests, wait for what is still running.
 */
export class BackgroundTasks {
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly log?: FastifyBaseLogger) {}

  run(task: () => Promise<void>): void {
    const done: Promise<void> = task()
      .catch((err: unknown) => this.log?.error({ err }, 'background task failed'))
      .finally(() => this.running.delete(done));
    this.running.add(done);
  }

  /** Resolves once every task started so far, and any started meanwhile, has finished. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }
}
