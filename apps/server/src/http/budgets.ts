/**
 * In-memory limits that @fastify/rate-limit cannot express: a budget of failures (not
 * requests) per key, and a minimum interval per key known only after the body is read. Each map
 * holds at most `maxKeys` entries, dropping the oldest, so a flood of keys cannot grow memory.
 */

const DEFAULT_MAX_KEYS = 10_000;

function remember<V>(map: Map<string, V>, key: string, value: V, maxKeys: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxKeys) {
    const oldest = map.keys().next().value as string;
    map.delete(oldest);
  }
}

/** Blocks a key for `blockMs` once it failed `max` times within `windowMs`. */
export class FailureBudget {
  private readonly entries = new Map<string, { failures: number[]; blockedUntil: number }>();

  constructor(
    private readonly opts: { max: number; windowMs: number; blockMs: number; maxKeys?: number },
  ) {}

  blocked(key: string, now: Date): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.blockedUntil > now.getTime();
  }

  fail(key: string, now: Date): void {
    const at = now.getTime();
    const entry = this.entries.get(key);
    const failures = (entry?.failures ?? []).filter((t) => t > at - this.opts.windowMs);
    failures.push(at);
    const blocked = failures.length >= this.opts.max;
    const blockedUntil = blocked ? at + this.opts.blockMs : (entry?.blockedUntil ?? 0);
    remember(
      this.entries,
      key,
      { failures: blocked ? [] : failures, blockedUntil },
      this.opts.maxKeys ?? DEFAULT_MAX_KEYS,
    );
  }
}

/** Allows a key once per `intervalMs`. */
export class Throttle {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly maxKeys = DEFAULT_MAX_KEYS,
  ) {}

  allow(key: string, now: Date): boolean {
    const at = now.getTime();
    const previous = this.last.get(key);
    if (previous !== undefined && at - previous < this.intervalMs) return false;
    remember(this.last, key, at, this.maxKeys);
    return true;
  }
}

/** Allows a key `max` times within any `windowMs`. */
export class WindowLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly opts: { max: number; windowMs: number; maxKeys?: number }) {}

  take(key: string, now: Date): boolean {
    const at = now.getTime();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > at - this.opts.windowMs);
    if (recent.length >= this.opts.max) return false;
    recent.push(at);
    remember(this.hits, key, recent, this.opts.maxKeys ?? DEFAULT_MAX_KEYS);
    return true;
  }
}
