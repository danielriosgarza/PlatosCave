import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/*
 * The server limits what one person may do (connectionTests.routes.ts, connectors.routes.ts): six
 * Test connection starts a minute and five pairing codes an hour. Those limits outlive a
 * Playwright worker, so a retry after a failed test starts a new worker that remembers nothing.
 * The counts are therefore kept in a file shared by every worker of one run (named after the run's
 * process, which a restarted worker keeps as its parent).
 */

export type Person = 'reader' | 'instructor';
const people: Person[] = ['reader', 'instructor'];

interface State {
  starts: Record<Person, number[]>;
  pairings: Record<Person, number[]>;
}

const file = join(
  resolve(import.meta.dirname, '../../../.local/connector-e2e'),
  `limits-${process.ppid}.json`,
);

const MINUTE = 61_000;
const HOUR = 3_600_000;
const TESTS_PER_MINUTE = 5;
const PAIRINGS_PER_HOUR = 5;

function read(): State {
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as State;
    } catch {
      // A half-written file: start again.
    }
  }
  return { starts: { reader: [], instructor: [] }, pairings: { reader: [], instructor: [] } };
}

function write(state: State): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

const recent = (times: number[], within: number) => times.filter((t) => Date.now() - t < within);

/** Waits until `person` has fewer than five Test connection starts in the last minute, then counts one. */
export async function takeTestStart(
  person: Person,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  for (;;) {
    const state = read();
    const starts = recent(state.starts[person], MINUTE);
    if (starts.length < TESTS_PER_MINUTE) {
      state.starts[person] = [...starts, Date.now()];
      write(state);
      return;
    }
    await wait(1_000);
  }
}

/** Counts one pairing code for `person`. */
export function countPairing(person: Person): void {
  const state = read();
  state.pairings[person] = [...recent(state.pairings[person], HOUR), Date.now()];
  write(state);
}

/** `preferred`, or the other person when `preferred` has used all five codes this hour. */
export function personWithPairingLeft(preferred: Person): Person {
  const state = read();
  const left = (p: Person) => PAIRINGS_PER_HOUR - recent(state.pairings[p], HOUR).length;
  const order = [preferred, ...people.filter((p) => p !== preferred)];
  const found = order.find((p) => left(p) > 0);
  if (!found) throw new Error('both people have used their five pairing codes this hour');
  return found;
}
