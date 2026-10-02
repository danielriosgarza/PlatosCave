import type { FastifyBaseLogger } from 'fastify';

/**
 * Work that starts during a request but must not hold its answer (mail delivery). Each task
 * handles its own failures; `settled()` lets shutdown, and tests, wait for what is still running.
 */
export class BackgroundTasks {
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly log?: FastifyBaseLogger) {}

  run(task: () => Promise<void>): void {
    // Started from a resolved promise, so a task that throws before returning one is caught too
    // and never escapes into the request that queued it.
    const done: Promise<void> = Promise.resolve()
      .then(task)
      .catch((err: unknown) => this.log?.error({ err }, 'background task failed'))
      .finally(() => this.running.delete(done));
    this.running.add(done);
  }

  /**
   * Resolves once every task started so far, and any started meanwhile, has finished, or after
   * `timeoutMs` when given. Returns how many tasks were still running.
   */
  async settled(timeoutMs?: number): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    const deadline =
      timeoutMs === undefined
        ? undefined
        : new Promise<'late'>((resolve) => {
            timer = setTimeout(() => resolve('late'), timeoutMs);
          });
    const drained = (async () => {
      while (this.running.size > 0) await Promise.all([...this.running]);
      return 'done' as const;
    })();
    try {
      await Promise.race(deadline ? [drained, deadline] : [drained]);
    } finally {
      clearTimeout(timer);
    }
    return this.running.size;
  }
}
