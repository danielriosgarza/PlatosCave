import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import readingStyles from '../../reading/Reading.module.css';
import { ResourceTools } from '../../workspace/ResourceTools';
import {
  errorCode,
  type NotebookSession,
  restartKernel,
  startKernel,
  useSessionActions,
} from '../connect/api';
import { LossNotice } from '../connect/LossNotice';
import { causeText, codeText } from '../connect/messages';
import styles from '../Notebook.module.css';
import { Markdown, Outline, Output } from '../NotebookView';
import type { Notebook, NotebookCell } from '../notebooks';
import { CellEditor } from './CellEditor';
import { kernelIsBusy, type LiveExecution, latestByCell } from './executionState';
import live from './Live.module.css';
import { LiveOutputs } from './Outputs';
import { SessionPanels, useCopyInGate } from './SessionPanels';
import { LiveToolbar, type SessionAction } from './Toolbar';
import { useChannel } from './useChannel';

interface Props {
  classId: string;
  /** The session as the server last read it; the channel refines it with what the relay says. */
  session: NotebookSession;
  connectionName: string | undefined;
  notebook: Notebook;
  outlineOpen: boolean;
  showCode: boolean;
  showOutputs: boolean;
  /** The person's edits by cell id; they outlive the session (kept by the notebook's panel). */
  sources: Record<string, string>;
  onEdit: (cellId: string, value: string) => void;
  /** The toolbar's leading tools; the target button gets the live mode label. */
  lead: (label: string) => ReactNode;
  trail: ReactNode;
  /** Opens the Connect panel: to reconnect, choose another target or start a new session. */
  onOpenConnect: () => void;
  /** The server's session list no longer has this session; `session` is the last state read. */
  unlisted?: boolean;
}

const INTERRUPT_STALL_MS = 5000;
const RUNNABLE = new Set(['idle', 'busy', 'waiting_for_input']);
const LOST = new Set(['disconnected', 'unconfirmed', 'stopping', 'stopped', 'failed']);

const KERNEL_LABEL: Record<string, string> = {
  starting: 'Starting',
  idle: 'Ready',
  busy: 'Running',
  waiting_for_input: 'Waiting for input',
  restarting: 'Restarting',
  dead: 'Kernel stopped',
  unknown: 'Unconfirmed',
};

const languageOf = (kernelName: string | null | undefined, fallback: string | null) => {
  const name = kernelName ?? fallback ?? '';
  if (/^python/i.test(name)) return 'Python';
  if (/^(ir|r)$/i.test(name)) return 'R';
  return name || 'Kernel';
};

/** §5.6: a mode label that names only a state the server read. */
export function modeLabel(args: {
  connectionName: string | undefined;
  language: string;
  sessionState: string;
  kernelState: string | undefined;
  confirmed: boolean;
}): string {
  const { sessionState, kernelState, confirmed } = args;
  let state: string;
  if (sessionState === 'disconnected') state = 'Disconnected';
  else if (sessionState === 'stopping') state = 'Stopping';
  else if (sessionState === 'stopped') state = 'Stopped';
  else if (sessionState === 'failed') state = 'Failed';
  else if (sessionState === 'unconfirmed' || !confirmed) state = 'Unconfirmed';
  else state = KERNEL_LABEL[kernelState ?? 'unknown'] ?? 'Unconfirmed';
  return `${args.connectionName ?? 'Computer'} · ${args.language} · ${state}`;
}

interface RunAll {
  queue: string[];
  cellId: string;
  /** The cell as the page names it, for messages. */
  name: string;
  ref: string | null;
}

/**
 * A notebook running on the person's own computer (spec §10.4, design §2, §10.5, §10.6). Cells
 * are editable; running one sends it over the channel and the outputs stream back into the same
 * full-width notebook. Opening a notebook never runs a cell, and nothing is run again without
 * the person asking: a dropped socket reattaches and reads what happened, and an execution with
 * no confirmed reply says `Unconfirmed` or `Incomplete`. When the connection is lost, execution
 * is disabled and editing is kept.
 */
export function LiveNotebook({
  classId,
  session,
  connectionName,
  notebook,
  outlineOpen,
  showCode,
  showOutputs,
  sources,
  onEdit,
  lead,
  trail,
  onOpenConnect,
  unlisted = false,
}: Props) {
  const root = useRef<HTMLElement | null>(null);
  const [left, setLeft] = useState(false);
  const detached = left || unlisted;
  const channel = useChannel(classId, session.id, !detached);
  const { state } = channel;
  const actions = useSessionActions(classId);
  const [ask, setAsk] = useState<SessionAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [startingKernel, setStartingKernel] = useState(false);
  const [runAll, setRunAll] = useState<RunAll | null>(null);
  const [runAllNote, setRunAllNote] = useState<string | null>(null);
  const [interruptedAt, setInterruptedAt] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  // Cells opened one by one; a change of the toolbar's Show/Hide resets them.
  const [opened, setOpened] = useState<{
    code: boolean;
    outputs: boolean;
    cells: Record<string, { code?: boolean; output?: boolean }>;
  }>({ code: showCode, outputs: showOutputs, cells: {} });
  const revealed = opened.code === showCode && opened.outputs === showOutputs ? opened.cells : {};
  const reveal = (id: string, part: 'code' | 'output') =>
    setOpened({
      code: showCode,
      outputs: showOutputs,
      cells: { ...revealed, [id]: { ...revealed[id], [part]: true } },
    });
  const confirmRef = useRef<HTMLDivElement>(null);

  const channelOpen = !detached && channel.status === 'open' && !channel.offline;
  const sessionState = channelOpen && state.session ? state.session.state : session.state;
  const cause = (channelOpen && state.session ? state.session.cause : null) ?? session.cause;
  const sessionReady = sessionState === 'ready' && session.state === 'ready' && !unlisted;
  const kernel = state.kernel;
  const kernelState = kernel?.state;
  const connected = sessionReady && channelOpen && !left;
  // The socket dropped and is being retried while the session was last known ready.
  const reattaching =
    !detached &&
    session.state === 'ready' &&
    (state.session?.state ?? 'ready') === 'ready' &&
    (channel.status === 'closed' || channel.status === 'connecting' || channel.offline);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const stableEdit = useCallback((id: string, value: string) => onEditRef.current(id, value), []);
  const gate = useCopyInGate(classId, session.id, sessionReady && !left);
  const canRun =
    connected && kernelState !== undefined && RUNNABLE.has(kernelState) && !gate.pending;
  const busy = connected && kernelIsBusy(kernelState);
  const owned = state.session?.owned ?? session.owned;
  const latest = useMemo(() => latestByCell(state), [state]);

  const codeOf = (cell: NotebookCell) =>
    cell.type === 'code' ? (sources[cell.id] ?? cell.source) : '';

  // The cell as the page names it ("3 [2]"), not by its id in the file.
  const nameOf = (cellId: string) => {
    const index = notebook.cells.findIndex((c) => c.id === cellId);
    const cell = notebook.cells[index];
    const count =
      latest[cellId]?.executionCount ?? (cell?.type === 'code' ? cell.executionCount : null);
    return `${index + 1} [${count ?? ' '}]`;
  };

  const runCell = (cellId: string): string | null => {
    const cell = notebook.cells.find((c) => c.id === cellId);
    if (cell?.type !== 'code') return null;
    return channel.execute(cellId, codeOf(cell));
  };

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

  // An Interrupt that has not returned the kernel to idle after 5 s offers a restart (spec §10.4).
  useEffect(() => {
    if (interruptedAt === null) return;
    if (!busy) {
      setInterruptedAt(null);
      setStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), INTERRUPT_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [interruptedAt, busy]);

  // Focus follows the confirmation, and returns to the session menu when it closes.
  const askedBefore = useRef<SessionAction | null>(null);
  useEffect(() => {
    if (ask) confirmRef.current?.focus();
    else if (askedBefore.current) document.getElementById('live-session-menu')?.focus();
    askedBefore.current = ask;
  }, [ask]);

  const fail = (e: unknown, fallback: string) =>
    setActionError(errorCode(e) ? codeText(errorCode(e)) : fallback);

  const doRestart = async () => {
    setBusyAction(true);
    setActionError(null);
    try {
      await restartKernel(classId, session.id);
      setStalled(false);
      setInterruptedAt(null);
      setRunAll(null);
      setAsk(null);
    } catch (e) {
      fail(e, 'The kernel could not be restarted.');
    } finally {
      setBusyAction(false);
    }
  };
  const doStop = () => {
    setActionError(null);
    actions.close.mutate(
      { sessionId: session.id, stop: true },
      {
        onSuccess: () => setAsk(null),
        onError: (e) => fail(e, 'The session could not be stopped.'),
      },
    );
  };
  const doDisconnect = () => {
    setActionError(null);
    actions.close.mutate(
      { sessionId: session.id, stop: false },
      {
        onSuccess: () => {
          setAsk(null);
          setLeft(true);
        },
        onError: (e) => fail(e, 'The session could not be disconnected.'),
      },
    );
  };
  const doForget = () => {
    setActionError(null);
    actions.forget.mutate(session.id, {
      onError: (e) => fail(e, 'The session could not be given up on.'),
    });
  };
  const newKernel = async () => {
    const name =
      session.kernelName ?? session.runtime.kernelName ?? session.runtime.kernelspecs?.[0]?.name;
    if (!name) return;
    if (startingKernel) return;
    setStartingKernel(true);
    setActionError(null);
    try {
      await startKernel(classId, session.id, name);
    } catch (e) {
      fail(e, 'The kernel could not be started.');
    } finally {
      setStartingKernel(false);
    }
  };

  const kernelNameShown = kernel?.name ?? session.kernelName ?? undefined;
  const environment = useMemo(
    () => ({
      os: session.environment?.os,
      arch: session.environment?.arch,
      interpreter: session.environment?.runtime,
      kernel: kernelNameShown,
    }),
    [session.environment, kernelNameShown],
  );

  const label = modeLabel({
    connectionName,
    language: languageOf(kernel?.name ?? session.kernelName, notebook.language),
    sessionState,
    kernelState,
    confirmed: connected,
  });

  const kernelMissing = sessionReady && channelOpen && state.epoch !== null && kernel === null;
  const kernelLost = kernelMissing && (cause === 'kernel_lost' || session.cause === 'kernel_lost');

  const banner: ReactNode[] = [];
  if (left) {
    banner.push(
      <div key="left" className={live.banner} role="status">
        <p>
          <strong>You disconnected from this session.</strong> Parallax did not stop the kernel and
          does not know whether it is still running on that computer. Your edits are kept, and cells
          cannot run until you reconnect.
        </p>
        <div className={live.row}>
          <button type="button" className={buttons.outline} onClick={() => setLeft(false)}>
            Reconnect to this session
          </button>
          <button type="button" className={buttons.outline} onClick={onOpenConnect}>
            Connect a computer
          </button>
        </div>
      </div>,
    );
  } else if (unlisted) {
    banner.push(
      <div key="unlisted" className={live.banner} role="alert">
        <p>
          <strong>Parallax no longer has news of this session.</strong> It was last read as{' '}
          {session.state}, and Parallax does not know whether it still runs. Your edits are kept,
          and cells cannot run.
        </p>
        <div className={live.row}>
          <button type="button" className={buttons.outline} onClick={onOpenConnect}>
            Connect a computer
          </button>
        </div>
      </div>,
    );
  } else if (LOST.has(session.state) || LOST.has(sessionState)) {
    banner.push(
      <LossNotice
        key="loss"
        session={
          {
            ...session,
            state: LOST.has(sessionState) ? sessionState : session.state,
            cause,
          } as NotebookSession
        }
        busy={actions.forget.isPending || actions.close.isPending}
        onReconnect={onOpenConnect}
        onForget={doForget}
        onChooseAnother={onOpenConnect}
        onNewSession={onOpenConnect}
      />,
    );
  } else if (channel.status === 'ended') {
    banner.push(
      <div key="ended" className={live.banner} role="alert">
        <p>
          Parallax closed the connection to this session. Your edits are kept, and cells cannot run.
        </p>
      </div>,
    );
  } else if (!channelOpen) {
    banner.push(
      <div key="channel" className={live.banner} role="alert">
        <p>
          <strong>
            {channel.offline
              ? 'This browser is offline.'
              : 'The connection to this session was lost.'}
          </strong>{' '}
          Parallax is trying again. Your edits are kept, and cells cannot run until it returns. The
          kernel state shown is the last one Parallax read and is unconfirmed. Nothing runs again
          when the connection returns.
        </p>
      </div>,
    );
  }
  if (gate.pending && gate.listing.isPending) {
    banner.push(
      <div key="copyin" className={live.banner} role="status">
        <p>
          Reading the workspace to find any files this notebook declares. Cells cannot run until
          then.
        </p>
      </div>,
    );
  } else if (gate.pending) {
    banner.push(
      <div key="copyin" className={live.banner} role="status">
        <p>
          This notebook declares {gate.declared} {gate.declared === 1 ? 'file' : 'files'}. Cells
          cannot run until you copy {gate.declared === 1 ? 'it' : 'them'} in from Files below, or
          choose to run without {gate.declared === 1 ? 'it' : 'them'}.
        </p>
        <button type="button" className={buttons.outline} onClick={gate.settle}>
          Run without the files
        </button>
      </div>,
    );
  }
  if (kernelMissing && !detached) {
    banner.push(
      <div key="kernel" className={live.banner} role="status">
        <p>
          {kernelLost
            ? `${causeText('kernel_lost')} A new kernel starts empty.`
            : 'No kernel is running in this session yet.'}
        </p>
        <button
          type="button"
          className={buttons.outline}
          disabled={startingKernel}
          onClick={() => void newKernel()}
        >
          {kernelLost ? 'Start a new kernel' : 'Start the kernel'}
        </button>
      </div>,
    );
  }
  if (stalled && busy) {
    banner.push(
      <div key="stalled" className={live.banner} role="alert">
        <p>
          The kernel did not stop after Interrupt. Restarting it stops the cell, and its variables
          will be lost.
        </p>
        <button type="button" className={buttons.outline} onClick={() => setAsk('restart')}>
          Restart kernel
        </button>
      </div>,
    );
  }
  if (runAllNote) {
    banner.push(
      <div key="runall" className={live.banner} role="status">
        <p>{runAllNote}</p>
      </div>,
    );
  }
  if (actionError) {
    banner.push(
      <div key="error" className={live.banner} role="alert">
        <p>{actionError}</p>
      </div>,
    );
  }
  if (ask) {
    banner.push(
      <section
        key="confirm"
        ref={confirmRef}
        tabIndex={-1}
        className={live.banner}
        aria-label={
          ask === 'restart' ? 'Restart kernel' : ask === 'stop' ? 'Stop session' : 'Disconnect'
        }
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          // Handled here, so Focus's document listener leaves the workspace alone.
          e.preventDefault();
          setAsk(null);
        }}
      >
        {ask === 'restart' ? (
          <p>
            Restart the kernel? Its variables will be lost and cells that are running stop. Output
            already shown stays, marked as from the previous kernel session.
          </p>
        ) : ask === 'disconnect' ? (
          <p>
            Disconnect from this session? Parallax leaves the kernel running under the session's
            lease and does not stop it; it cannot tell you whether it is still running. Your edits
            are kept, and cells cannot run until you reconnect.
          </p>
        ) : (
          <p>
            Stop this session? The connector stops the Jupyter server it started and its kernel, and
            the variables are lost. Your edits to the notebook are kept.
          </p>
        )}
        <div className={live.row}>
          <button
            type="button"
            className={buttons.primary}
            disabled={busyAction || actions.close.isPending}
            onClick={() =>
              ask === 'restart'
                ? void doRestart()
                : ask === 'disconnect'
                  ? doDisconnect()
                  : doStop()
            }
          >
            {ask === 'restart'
              ? 'Restart kernel'
              : ask === 'disconnect'
                ? 'Disconnect'
                : 'Stop session'}
          </button>
          <button type="button" className={buttons.outline} onClick={() => setAsk(null)}>
            Cancel
          </button>
        </div>
      </section>,
    );
  }

  const sessionActive = !detached && session.state === 'ready' && sessionReady && channelOpen;

  return (
    <>
      <ResourceTools>
        {lead(label)}
        {trail}
        <LiveToolbar
          canRun={canRun}
          busy={busy}
          runningAll={runAll !== null}
          owned={owned}
          sessionActive={sessionActive}
          onRunAll={startRunAll}
          onInterrupt={() => {
            if (channel.interrupt()) {
              setStalled(false);
              setInterruptedAt(Date.now());
            }
          }}
          onAsk={(action) => {
            setAsk(action);
          }}
        />
      </ResourceTools>
      <article ref={root} className={styles.notebook} aria-label="Live notebook">
        {banner}
        {outlineOpen ? <Outline notebook={notebook} root={root} /> : null}
        {notebook.cells.map((cell, index) => {
          if (cell.type === 'markdown') {
            return (
              <section key={cell.id} data-cell-id={cell.id} tabIndex={-1}>
                <Markdown html={cell.html} className={`${styles.prose} ${readingStyles.native}`} />
              </section>
            );
          }
          if (cell.type === 'raw') {
            return (
              <section key={cell.id} data-cell-id={cell.id} tabIndex={-1} className={styles.cell}>
                <span className={styles.num} />
                <pre className={styles.raw}>{cell.text}</pre>
              </section>
            );
          }
          const execution: LiveExecution | undefined = latest[cell.id];
          const count = execution?.executionCount ?? cell.executionCount;
          const marker = `[${count ?? ' '}]`;
          // Cells that have not run share a marker, so their names carry their position.
          const name = `${index + 1} ${marker}`;
          const codeHidden = (!showCode || cell.sourceHidden) && !revealed[cell.id]?.code;
          const outputHidden = (!showOutputs || cell.outputsHidden) && !revealed[cell.id]?.output;
          return (
            <section
              key={cell.id}
              data-cell-id={cell.id}
              tabIndex={-1}
              aria-label={`Code cell ${name}`}
            >
              <div className={styles.cell}>
                <span className={styles.num}>{marker}</span>
                <div className={live.cellEditor}>
                  {codeHidden ? (
                    <button
                      type="button"
                      className={buttons.textButton}
                      aria-label={`Show code of cell ${name}`}
                      onClick={() => reveal(cell.id, 'code')}
                    >
                      Show code
                    </button>
                  ) : (
                    <CellEditor
                      label={`Code of cell ${name}`}
                      value={sources[cell.id] ?? cell.source}
                      onChange={(value) => onEdit(cell.id, value)}
                      onRun={() => canRun && runAll === null && runCell(cell.id)}
                    />
                  )}
                  <div className={live.cellTools}>
                    <button
                      type="button"
                      className={buttons.tool}
                      aria-label={`Run cell ${name}`}
                      disabled={!canRun || runAll !== null}
                      onClick={() => runCell(cell.id)}
                    >
                      Run
                    </button>
                    {state.refusals[cell.id] ? (
                      <span className={live.refusal} role="alert">
                        {codeText(state.refusals[cell.id]?.code)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              {outputHidden && (execution || cell.outputs.length > 0) ? (
                <div className={styles.cell}>
                  <span className={styles.num}>Out</span>
                  <div>
                    <button
                      type="button"
                      className={buttons.textButton}
                      aria-label={`Show output of cell ${name}`}
                      onClick={() => reveal(cell.id, 'output')}
                    >
                      Show output
                    </button>
                  </div>
                </div>
              ) : execution ? (
                <div className={styles.cell}>
                  <span className={styles.num}>Out</span>
                  <LiveOutputs
                    classId={classId}
                    sessionId={session.id}
                    execution={execution}
                    kernelGeneration={kernel?.generation}
                    canRun={canRun && runAll === null}
                    onRunAgain={() => {
                      if (runAll === null) runCell(cell.id);
                    }}
                    onInputReply={(value) => channel.inputReply(execution.executionId, value)}
                  />
                </div>
              ) : cell.outputs.length > 0 ? (
                <div className={styles.cell}>
                  <span className={styles.num}>Out</span>
                  <div className={styles.outputs}>
                    {cell.outputs.map((output, i) => (
                      // Stored outputs never move: their order is their identity.
                      // biome-ignore lint/suspicious/noArrayIndexKey: see above
                      <Output key={i} output={output} cellCount={cell.executionCount} />
                    ))}
                    <div className={styles.provenance}>
                      Stored output · {notebook.kernel ?? 'kernel not recorded'}
                    </div>
                  </div>
                </div>
              ) : null}
            </section>
          );
        })}
      </article>
      {sessionReady && !detached ? (
        <SessionPanels
          classId={classId}
          sessionId={session.id}
          revisionId={session.resourceRevisionId}
          notebook={notebook}
          sources={sources}
          onEdit={stableEdit}
          environment={environment}
          workspace={gate.listing.data?.workspace}
          host={gate.listing.data?.host ?? null}
          workspacePending={gate.listing.isPending}
          onCopyInSettled={gate.settle}
        />
      ) : null}
    </>
  );
}
