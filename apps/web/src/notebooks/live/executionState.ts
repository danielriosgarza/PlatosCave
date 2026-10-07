import type {
  ChannelServerMessage,
  ExecutionState,
  KernelState,
  LiveOutput,
} from '@parallax/contracts';
import { MAX_LIVE_TEXT_CHARS, stripAnsi } from './liveOutput';

/**
 * The browser's view of one live notebook session (docs/design/connector.md §10.5, §10.6): a
 * reducer over the relay's `ready`, `execution`, `output`, `kernel_state`, `session_state` and
 * `error` messages. It holds only what the relay said; it never invents a state (§5.6). The
 * relay is the one that binds an `execute` to the kernel, so a cell the browser asked to run but
 * that the relay has not acknowledged is `pending`, and is resent only with its original `ref`.
 */

export interface OutputItem {
  eventSeq: number;
  generation: number;
  output: LiveOutput;
}

export interface InputPrompt {
  prompt: string;
  password: boolean;
}

export interface LiveExecution {
  executionId: string;
  ref: string;
  cellId: string;
  seq: number;
  state: ExecutionState;
  executionCount: number | undefined;
  outputsIncomplete: boolean;
  generation: number;
  outputs: OutputItem[];
  /** Characters of stream text kept in `outputs`; no more is kept past the display cap. */
  textChars: number;
  /** Earlier output of this execution was dropped from the relay's buffer (§10.6). */
  truncated: boolean;
  prompt: InputPrompt | null;
  /** It was running when the relay changed: its output stays incomplete whatever the relay says next. */
  carriedOver: boolean;
}

/** An `execute` the browser sent that no `execution` message has answered yet. */
export interface PendingExecute {
  ref: string;
  cellId: string;
  code: string;
}

export interface SessionInfo {
  state: string;
  cause: string | null;
  owned: boolean | null;
}

export interface KernelInfo {
  state: KernelState;
  /** Increases on every restart and new kernel (§10.6). */
  generation: number;
  name: string | null;
}

export interface LiveState {
  epoch: string | null;
  /** The last output event applied in this epoch; the position a resume asks from. */
  eventSeq: number;
  session: SessionInfo | null;
  kernel: KernelInfo | null;
  executions: Record<string, LiveExecution>;
  /** Execution ids in the order the relay numbered them. */
  order: string[];
  pending: PendingExecute[];
  /** The last refusal of an `execute`, by cell, for the cell to show. */
  refusals: Record<string, { code: string; detail?: string }>;
  /** The last error that answered no particular cell. */
  error: { code: string; detail?: string } | null;
}

export const initialLiveState: LiveState = {
  epoch: null,
  eventSeq: 0,
  session: null,
  kernel: null,
  executions: {},
  order: [],
  pending: [],
  refusals: {},
  error: null,
};

export type LiveAction =
  | { type: 'message'; message: ChannelServerMessage }
  | { type: 'sent'; execute: PendingExecute }
  | { type: 'dismiss_refusal'; cellId: string }
  | { type: 'prompt_answered'; executionId: string };

const FINAL = new Set<ExecutionState>(['ok', 'error', 'aborted', 'incomplete']);
/** An execution that is not over: it may still produce output or an outcome. */
export const isActive = (state: ExecutionState) => !FINAL.has(state) && state !== 'unconfirmed';

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'sent':
      return {
        ...state,
        pending: [...state.pending.filter((p) => p.ref !== action.execute.ref), action.execute],
        refusals: withoutKey(state.refusals, action.execute.cellId),
      };
    case 'dismiss_refusal':
      return { ...state, refusals: withoutKey(state.refusals, action.cellId) };
    case 'prompt_answered': {
      const execution = state.executions[action.executionId];
      if (!execution) return state;
      return {
        ...state,
        executions: { ...state.executions, [action.executionId]: { ...execution, prompt: null } },
      };
    }
    case 'message':
      return apply(state, action.message);
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

function apply(state: LiveState, message: ChannelServerMessage): LiveState {
  switch (message.t) {
    case 'ready': {
      const sameEpoch = state.epoch === null || state.epoch === message.epoch;
      let executions = state.executions;
      if (!sameEpoch) {
        // Another relay life: the old position means nothing, and whatever was running when the
        // relay changed is of unknown outcome. Output missing from the new buffer is not shown
        // as complete (§10.5).
        executions = Object.fromEntries(
          Object.entries(state.executions).map(([id, e]) => [
            id,
            isActive(e.state) || e.state === 'unconfirmed'
              ? { ...e, outputsIncomplete: true, prompt: null, carriedOver: true }
              : e,
          ]),
        );
      }
      return {
        ...state,
        epoch: message.epoch,
        eventSeq: sameEpoch ? state.eventSeq : 0,
        session: {
          state: message.session.state,
          cause: message.session.cause,
          owned: message.session.owned,
        },
        kernel: message.kernel
          ? {
              state: message.kernel.state,
              generation: message.kernel.generation,
              name: message.kernel.name,
            }
          : null,
        executions,
        error: null,
      };
    }
    case 'execution': {
      const existing = state.executions[message.executionId];
      const next: LiveExecution = {
        executionId: message.executionId,
        ref: message.ref,
        cellId: message.cellId,
        seq: message.seq,
        state: message.state,
        executionCount: message.executionCount ?? existing?.executionCount,
        outputsIncomplete: message.outputsIncomplete || (existing?.carriedOver ?? false),
        generation: message.generation,
        outputs: existing?.outputs ?? [],
        textChars: existing?.textChars ?? 0,
        truncated: existing?.truncated ?? false,
        prompt: existing && !FINAL.has(message.state) ? existing.prompt : null,
        carriedOver: existing?.carriedOver ?? false,
      };
      return {
        ...state,
        executions: { ...state.executions, [message.executionId]: next },
        order: existing ? state.order : insertBySeq(state, next),
        pending: state.pending.filter((p) => p.ref !== message.ref),
        refusals: withoutKey(state.refusals, message.cellId),
      };
    }
    case 'output': {
      // Output events are numbered in one sequence for the session; a replay after a reconnect
      // repeats ones already applied.
      if (message.eventSeq <= state.eventSeq) return state;
      const execution = state.executions[message.executionId];
      if (!execution) return { ...state, eventSeq: message.eventSeq };
      let next = execution;
      if (message.kind === 'output' && message.output) {
        next = appendOutput(next, message.eventSeq, message.generation, message.output);
      } else if (message.kind === 'clear_output') {
        next = { ...next, outputs: [], textChars: 0 };
      } else if (message.kind === 'input_request' && message.input) {
        next = { ...next, prompt: message.input };
      }
      if (message.truncated) next = { ...next, truncated: true };
      return {
        ...state,
        eventSeq: message.eventSeq,
        executions: { ...state.executions, [message.executionId]: next },
      };
    }
    case 'kernel_state': {
      const kernel: KernelInfo = {
        name: state.kernel?.name ?? null,
        state: message.state,
        generation: message.generation,
      };
      // A prompt is only open while the kernel waits for input.
      const executions =
        message.state === 'waiting_for_input'
          ? state.executions
          : Object.fromEntries(
              Object.entries(state.executions).map(([id, e]) => [
                id,
                e.prompt ? { ...e, prompt: null } : e,
              ]),
            );
      return { ...state, kernel, executions };
    }
    case 'session_state':
      return {
        ...state,
        session: {
          state: message.state,
          cause: message.cause ?? null,
          owned: state.session?.owned ?? null,
        },
      };
    case 'error': {
      const detail = message.detail === undefined ? {} : { detail: message.detail };
      if (message.ref) {
        const refused = state.pending.find((p) => p.ref === message.ref);
        return {
          ...state,
          pending: state.pending.filter((p) => p.ref !== message.ref),
          refusals: refused
            ? { ...state.refusals, [refused.cellId]: { code: message.code, ...detail } }
            : state.refusals,
        };
      }
      return { ...state, error: { code: message.code, ...detail } };
    }
  }
}

/**
 * Adds one output. Consecutive stream text of one stream and kernel generation joins the
 * previous item, and stream text past the display cap is not kept: the execution is marked
 * truncated instead, so memory stays bounded however long a cell prints.
 */
function appendOutput(
  execution: LiveExecution,
  eventSeq: number,
  generation: number,
  output: LiveOutput,
): LiveExecution {
  if (output.output_type !== 'stream') {
    return { ...execution, outputs: [...execution.outputs, { eventSeq, generation, output }] };
  }
  const room = Math.max(MAX_LIVE_TEXT_CHARS - execution.textChars, 0);
  const text = stripAnsi(output.text);
  if (text.length === 0) return execution;
  if (room === 0) return { ...execution, truncated: true };
  const kept = text.slice(0, room);
  const truncated = execution.truncated || kept.length < text.length;
  const textChars = execution.textChars + kept.length;
  const last = execution.outputs[execution.outputs.length - 1];
  if (
    last?.output.output_type === 'stream' &&
    last.output.name === output.name &&
    last.generation === generation
  ) {
    const merged: OutputItem = {
      eventSeq,
      generation,
      output: { ...last.output, text: last.output.text + kept },
    };
    return {
      ...execution,
      outputs: [...execution.outputs.slice(0, -1), merged],
      textChars,
      truncated,
    };
  }
  return {
    ...execution,
    outputs: [...execution.outputs, { eventSeq, generation, output: { ...output, text: kept } }],
    textChars,
    truncated,
  };
}

function insertBySeq(state: LiveState, added: LiveExecution): string[] {
  const order = [...state.order, added.executionId];
  return order.sort(
    (a, b) =>
      (a === added.executionId ? added : (state.executions[a] as LiveExecution)).seq -
      (b === added.executionId ? added : (state.executions[b] as LiveExecution)).seq,
  );
}

/** The latest execution of each cell, by the relay's numbering. */
export function latestByCell(state: LiveState): Record<string, LiveExecution> {
  const latest: Record<string, LiveExecution> = {};
  for (const id of state.order) {
    const execution = state.executions[id];
    if (execution) latest[execution.cellId] = execution;
  }
  return latest;
}

export const kernelIsBusy = (kernel: KernelState | undefined) =>
  kernel === 'busy' || kernel === 'waiting_for_input';
