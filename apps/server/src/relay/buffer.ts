import { randomUUID } from 'node:crypto';
import type { ChannelServerMessageInput } from '@parallax/contracts';

/**
 * The relay's output buffer of one notebook session (docs/design/connector.md §10.5, §10.6). It
 * numbers every `output` event the kernel produced in this relay process life (`eventSeq`, from
 * 1, under one `epoch`) and keeps, per execution, the last 256 KiB of serialised events (older
 * ones are dropped and the first kept one is marked `truncated`), at most 8 MiB per session
 * (finished executions are evicted oldest first). A browser that reconnects with the same epoch
 * gets what it missed; one with another epoch gets everything still held and treats what is
 * missing as incomplete. Nothing here is durable: acknowledged outputs are the ones the browser
 * saved to its working copy (P3-09).
 */

export const EXECUTION_BUFFER_BYTES = 256 * 1024;
export const SESSION_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_EMPTY_RECORDS = 1000;
/** Finishes remembered for a resume, newest kept (at most 30 executions a second are bound). */
export const MAX_FINISHES = 1000;

export type OutputEvent = Extract<ChannelServerMessageInput, { t: 'output' }>;
/** An event before the buffer numbers it. */
export type NewOutputEvent = Omit<OutputEvent, 'v' | 't' | 'eventSeq' | 'truncated'>;

interface Held {
  event: OutputEvent;
  bytes: number;
}

interface ExecutionEvents {
  events: Held[];
  bytes: number;
  /** The highest `eventSeq` of this execution that was dropped, 0 when none was. */
  droppedThrough: number;
  finished: boolean;
}

export class OutputBuffer {
  readonly epoch: string = randomUUID();
  private seq = 0;
  private bytes = 0;
  /** Executions in the order their first event arrived, for oldest-first eviction. */
  private readonly executions = new Map<string, ExecutionEvents>();
  /**
   * Executions that reached a final state in this epoch, with the last `eventSeq` assigned when
   * they did, oldest first: a browser that resumes learns the outcome of those it missed, output
   * or not (§10.6).
   */
  private readonly finishes = new Map<string, number>();

  constructor(
    private readonly limits = {
      perExecution: EXECUTION_BUFFER_BYTES,
      perSession: SESSION_BUFFER_BYTES,
    },
  ) {}

  /** The last `eventSeq` assigned in this epoch (0 before any event). */
  get eventSeq(): number {
    return this.seq;
  }

  /** Bytes held, for tests and metrics. */
  get size(): number {
    return this.bytes;
  }

  /** Numbers `input`, keeps it within the limits, and returns the event to send now. */
  append(input: NewOutputEvent): OutputEvent {
    const event: OutputEvent = { v: 1, t: 'output', ...input, eventSeq: ++this.seq };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    let entry = this.executions.get(input.executionId);
    if (!entry) {
      entry = { events: [], bytes: 0, droppedThrough: 0, finished: false };
      this.executions.set(input.executionId, entry);
    }
    entry.events.push({ event, bytes });
    entry.bytes += bytes;
    this.bytes += bytes;
    while (entry.bytes > this.limits.perExecution && entry.events.length > 0) {
      this.dropOldest(entry);
    }
    this.evict(input.executionId);
    return event;
  }

  /** The execution reached a final state: its events may be evicted first. */
  finish(executionId: string): void {
    const entry = this.executions.get(executionId);
    if (entry) entry.finished = true;
    this.finishes.delete(executionId);
    this.finishes.set(executionId, this.seq);
    for (const id of this.finishes.keys()) {
      if (this.finishes.size <= MAX_FINISHES) break;
      this.finishes.delete(id);
    }
  }

  /**
   * The executions that finished after `resume`'s position in this epoch, oldest finish first.
   * One that finished at the position itself is included: the browser may have left between
   * that event and the finish. With another epoch (or none) every remembered finish is returned.
   */
  finishedSince(resume?: { epoch: string; afterEventSeq: number }): string[] {
    const after = resume?.epoch === this.epoch ? resume.afterEventSeq : 0;
    return [...this.finishes].filter(([, at]) => at >= after).map(([id]) => id);
  }

  /**
   * The events after `afterEventSeq` in this epoch, in order. With another epoch (or none) every
   * held event is returned and `sameEpoch` is false. The first returned event of an execution
   * whose earlier events were dropped after the position carries `truncated: true`;
   * `truncated` lists the executions whose missed events were all dropped.
   */
  replay(resume?: { epoch: string; afterEventSeq: number }): {
    sameEpoch: boolean;
    events: OutputEvent[];
    truncated: string[];
  } {
    const sameEpoch = resume?.epoch === this.epoch;
    const after = sameEpoch ? resume.afterEventSeq : 0;
    const events: OutputEvent[] = [];
    const truncated: string[] = [];
    for (const [id, entry] of this.executions) {
      let first = true;
      for (const held of entry.events) {
        if (held.event.eventSeq <= after) continue;
        const cut = first && entry.droppedThrough > after;
        events.push(cut ? { ...held.event, truncated: true } : held.event);
        first = false;
      }
      if (first && entry.droppedThrough > after) truncated.push(id);
    }
    events.sort((a, b) => a.eventSeq - b.eventSeq);
    return { sameEpoch, events, truncated };
  }

  private dropOldest(entry: ExecutionEvents): void {
    const dropped = entry.events.shift();
    if (!dropped) return;
    entry.bytes -= dropped.bytes;
    this.bytes -= dropped.bytes;
    entry.droppedThrough = Math.max(entry.droppedThrough, dropped.event.eventSeq);
  }

  /**
   * Keeps the session within its limit: finished executions go first, oldest first, whole (an
   * empty record stays, so a replay can say their output was dropped); if that is not enough,
   * the oldest events of the other executions are dropped.
   */
  private evict(keep: string): void {
    if (this.bytes <= this.limits.perSession) return;
    for (const [id, entry] of this.executions) {
      if (this.bytes <= this.limits.perSession) break;
      if (!entry.finished || id === keep) continue;
      while (entry.events.length > 0) this.dropOldest(entry);
    }
    this.forgetEmpty();
    if (this.bytes <= this.limits.perSession) return;
    for (const entry of this.executions.values()) {
      while (this.bytes > this.limits.perSession && entry.events.length > 0) {
        this.dropOldest(entry);
      }
      if (this.bytes <= this.limits.perSession) return;
    }
  }

  /** At most `MAX_EMPTY_RECORDS` emptied finished executions are remembered, oldest forgotten. */
  private forgetEmpty(): void {
    const empty = [...this.executions].filter(([, e]) => e.finished && e.events.length === 0);
    for (const [id] of empty.slice(0, Math.max(0, empty.length - MAX_EMPTY_RECORDS))) {
      this.executions.delete(id);
    }
  }
}
