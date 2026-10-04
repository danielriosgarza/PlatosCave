import { type RunnerFailureKind, TERMINAL_FAILURE_KINDS } from '@parallax/contracts';

/**
 * An infrastructure problem (design §3.3): not an outcome. The worker throws it so pg-boss
 * retries the job, or dead-letters it at once when the kind is terminal. `kind` is an own
 * enumerable property, so pg-boss's serialisation keeps it in the job's output.
 */
export class RunnerFailure extends Error {
  readonly kind: RunnerFailureKind;

  constructor(kind: RunnerFailureKind, message: string) {
    super(message);
    this.name = 'RunnerFailure';
    this.kind = kind;
  }

  get terminal(): boolean {
    return TERMINAL_FAILURE_KINDS.has(this.kind);
  }

  /** The `{ kind, message }` stored as the failed job's output. */
  toOutput(): { kind: RunnerFailureKind; message: string } {
    return { kind: this.kind, message: this.message.slice(0, 512) };
  }
}
