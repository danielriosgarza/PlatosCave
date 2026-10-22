import type { KernelState } from '@parallax/contracts';
import { useEffect, useState } from 'react';
import type { Notebook, NotebookCell } from '../notebooks';
import type { LiveState } from './executionState';

interface RunAll {
  queue: string[];
  cellId: string;
  /** The cell as the page names it, for messages. */
  name: string;
  ref: string | null;
}

interface Args {
  notebook: Notebook;
  state: LiveState;
  /** Cells can be sent now. */
  connected: boolean;
  /** The channel is being reattached: the cell waited on keeps running meanwhile. */
  reattaching: boolean;
  canRun: boolean;
  kernelState: KernelState | undefined;
  codeOf: (cell: NotebookCell) => string;
  nameOf: (cellId: string) => string;
  runCell: (cellId: string) => string | null;
}

/**
 * Run all, at level 1 and at level 0 (spec §10.4): one cell at a time in notebook order, stopping
 * at the first that does not finish cleanly, with a note that says why.
 */
export function useRunAll({
  notebook,
  state,
  connected,
  reattaching,
  canRun,
  kernelState,
  codeOf,
  nameOf,
  runCell,
}: Args) {
  const [runAll, setRunAll] = useState<RunAll | null>(null);
  const [runAllNote, setRunAllNote] = useState<string | null>(null);

  // Run all: one cell at a time in notebook order, stopping at the first that does not finish
  // cleanly. Each is a new execute with its own ref; none is ever resent by this logic. While the
  // channel is being reattached nothing is sent, and the cell it waits on keeps running on the
  // kernel: the resume tells how it ended (§10.6), and Run all goes on from there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: advances on each message and on connection changes only
  useEffect(() => {
    if (!runAll) return;
    const stop = (note: string) => {
      setRunAll(null);
      setRunAllNote(note);
    };
    if (!connected) {
      if (reattaching) return;
      stop('Run all stopped because the connection was lost.');
      return;
    }
    if (!canRun) {
      stop(
        kernelState === 'dead'
          ? 'Run all stopped: the kernel stopped.'
          : kernelState === 'restarting'
            ? 'Run all stopped: the kernel was restarted.'
            : 'Run all stopped: the kernel is not ready.',
      );
      return;
    }
    if (runAll.ref === null) return;
    const execution = Object.values(state.executions).find((e) => e.ref === runAll.ref);
    if (!execution) {
      if (!state.pending.some((p) => p.ref === runAll.ref)) {
        stop('Run all stopped: a cell could not be run.');
      }
      return;
    }
    if (execution.state === 'ok' && execution.outputsIncomplete) {
      // Its output carried over a relay restart and is labelled Incomplete: not a clean finish.
      stop(`Run all stopped at cell ${nameOf(runAll.cellId)}: its output is incomplete.`);
    } else if (execution.state === 'ok') {
      const [next, ...rest] = runAll.queue;
      if (next === undefined) {
        setRunAll(null);
        return;
      }
      const ref = runCell(next);
      if (ref === null) stop('Run all stopped because the connection was lost.');
      else setRunAll({ queue: rest, cellId: next, name: nameOf(next), ref });
    } else if (execution.state === 'sent' || execution.state === 'running') {
      // Still going.
    } else {
      stop(
        `Run all stopped at cell ${runAll.name}: it ${
          execution.state === 'error' ? 'ended with an error' : 'did not finish'
        }.`,
      );
    }
  }, [state, canRun, connected, reattaching, kernelState, runAll]);

  const startRunAll = () => {
    const ids = notebook.cells
      .filter((c) => c.type === 'code' && codeOf(c).trim() !== '')
      .map((c) => c.id);
    const [first, ...rest] = ids;
    setRunAllNote(null);
    if (first === undefined) return;
    const ref = runCell(first);
    if (ref) setRunAll({ queue: rest, cellId: first, name: nameOf(first), ref });
  };

  return { runAll, runAllNote, startRunAll, cancelRunAll: () => setRunAll(null) };
}
