/** The gate is full: too many callers are already waiting for a slot. */
export class GateBusy extends Error {}

/**
 * Lets at most `max` calls of `run` work at once and at most `maxWaiting` wait for a slot; one
 * more is refused with `GateBusy` rather than queued, so a burst cannot pile up work in memory.
 * Waiting is outside the work, so a caller's time bound can start when its slot is granted.
 */
export class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly max: number,
    private readonly maxWaiting: number,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.maxWaiting) throw new GateBusy();
      // The slot is handed over by `release`, which keeps `active` counted for the next caller.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
