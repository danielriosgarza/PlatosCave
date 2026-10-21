import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import connectStyles from '../../notebooks/connect/Connect.module.css';
import { CODE_COPY, codeText } from '../../notebooks/connect/messages';
import { CONNECTOR_RELEASES } from '../../notebooks/connect/releases';
import { kernelIsBusy, latestByCell } from '../../notebooks/live/executionState';
import live from '../../notebooks/live/Live.module.css';
import { LiveCells } from '../../notebooks/live/LiveCells';
import { modeLabel } from '../../notebooks/live/modeLabel';
import { LiveToolbar, type SessionAction } from '../../notebooks/live/Toolbar';
import { useRunAll } from '../../notebooks/live/useRunAll';
import styles from '../../notebooks/Notebook.module.css';
import type { Notebook, NotebookCell } from '../../notebooks/notebooks';
import { ResourceTools } from '../../workspace/ResourceTools';
import { ConnectorError } from './connector';
import { LocalRichOutput } from './LocalRichOutput';
import { type ConnectPhase, connect, forget, type LocalRun, stop } from './session';
import { useLocalKernel } from './useLocalKernel';

/**
 * Running a level 0 notebook on this computer (docs/design/open-site.md §14): the panel that
 * connects the page to `parallax-connector open`, and the live notebook once it has. The cells
 * run in Jupyter on this computer, in a folder of the connector's workspace; nothing is saved on
 * the site or handed in.
 */

const RUNNABLE = new Set(['idle', 'busy', 'waiting_for_input']);
const INTERRUPT_STALL_MS = 5000;

/** Why connecting failed, in the visitor's terms. */
export function failureText(error: unknown): string {
  if (!(error instanceof ConnectorError)) return 'Connecting failed. Try again.';
  switch (error.code) {
    case 'unreachable':
      return 'No connector answered on this computer. Start parallax-connector open in a terminal, then choose Connect again.';
    case 'refused':
      return "The connector's terminal refused this site. To be asked again, stop the connector and start it again.";
    case 'no_answer':
      return "Nobody answered in the connector's terminal in time. Choose Connect to be asked again.";
    case 'cannot_ask':
      return 'The connector has no terminal to ask in. Start parallax-connector open in a terminal.';
    case 'busy':
      return 'The connector is asking about another page. Answer it in the terminal, then choose Connect again.';
    case 'too_many_sessions':
      return 'Three notebooks already run on this computer. Stop one of them, then choose Connect again.';
    case 'files_unavailable':
      return `The notebook's data files could not be copied to this computer: ${error.message}`;
    case 'workspace_not_writable':
      return `The connector cannot make the notebook's folder: ${error.message}`;
    case 'origin_refused':
      return 'The connector does not serve pages of this site.';
    case 'stopping':
      return 'The connector is stopping.';
    default:
      return CODE_COPY[error.code]
        ? codeText(error.code)
        : `The connector refused: ${error.message}`;
  }
}

const PHASE_TEXT: Record<Exclude<ConnectPhase['phase'], 'asking'>, string> = {
  looking: 'Looking for the connector on this computer…',
  starting: "Starting Jupyter on this computer and copying the notebook's files…",
  kernel: 'Starting the kernel…',
};

export function ConnectThisComputer({
  notebook,
  folder,
  data,
  kernel,
  language,
  onConnected,
  onClose,
}: {
  notebook: string;
  folder: string[];
  data: string | null;
  kernel: string | null;
  language: string | null;
  onConnected: (run: LocalRun) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<ConnectPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const go = async () => {
    setError(null);
    try {
      const run = await connect({
        notebook,
        folder,
        files: data,
        kernel,
        language,
        onPhase: setPhase,
      });
      onConnected(run);
    } catch (e) {
      setError(failureText(e));
    } finally {
      setPhase(null);
    }
  };
  return (
    <section className={connectStyles.panel} aria-labelledby="run-local-heading">
      <div className={connectStyles.head}>
        <h2 id="run-local-heading" tabIndex={-1} ref={heading}>
          Run on this computer
        </h2>
        <button type="button" className={buttons.tool} onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        The cells run in Jupyter on this computer, through the Parallax connector, with the
        notebook's files in a folder of its own. Nothing you run or change is saved on this site.
      </p>
      <ol className={styles.colabSteps}>
        <li>
          Install the connector from the{' '}
          <a href={CONNECTOR_RELEASES} target="_blank" rel="noreferrer">
            connector releases
          </a>
          , and Jupyter Server with a kernel: <code>pip install jupyter-server ipykernel</code>.
        </li>
        <li>
          In a terminal, run <code>parallax-connector open</code> and leave it running.
        </li>
        <li>
          Choose Connect. Your browser may ask whether this site may reach apps on this device;
          allow it. Then the terminal asks whether this site may run notebooks.
        </li>
      </ol>
      {phase?.phase === 'asking' ? (
        <div className={connectStyles.notice} role="status">
          <p>
            Answer in the connector's terminal. It shows the code{' '}
            <strong className={connectStyles.mono}>{phase.code}</strong>: answer y only if it is the
            code on this page.
          </p>
        </div>
      ) : phase ? (
        <p role="status">{PHASE_TEXT[phase.phase]}</p>
      ) : null}
      {error ? (
        <div className={connectStyles.alert} role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      <div className={connectStyles.row}>
        <button
          type="button"
          className={buttons.primary}
          disabled={phase !== null}
          onClick={() => void go()}
        >
          Connect
        </button>
      </div>
    </section>
  );
}

const languageOf = (kernelName: string | null | undefined, fallback: string | null) => {
  const name = kernelName ?? fallback ?? '';
  if (/^python/i.test(name)) return 'Python';
  if (/^(ir|r)$/i.test(name)) return 'R';
  return name || 'Kernel';
};

interface Props {
  /** The notebook's data file address: its run is kept under it. */
  address: string;
  run: LocalRun;
  notebook: Notebook;
  outlineOpen: boolean;
  showCode: boolean;
  showOutputs: boolean;
  sources: Record<string, string>;
  onEdit: (cellId: string, value: string) => void;
  /** The toolbar's tools after the mode label. */
  trail: ReactNode;
  /** The run ended (stopped, or the connector no longer has it): back to the saved outputs. */
  onEnded: () => void;
}

/**
 * The notebook running on this computer: the same cells and outputs as at level 1, with the
 * kernel channel of the connector's open mode. A dropped channel never runs anything again: what
 * was running is Unconfirmed, and Connect again reaches the same kernel if the connector runs.
 */
export function OpenLiveNotebook({
  address,
  run,
  notebook,
  outlineOpen,
  showCode,
  showOutputs,
  sources,
  onEdit,
  trail,
  onEnded,
}: Props) {
  const root = useRef<HTMLElement | null>(null);
  const target = useMemo(
    () => ({
      client: run.client,
      session: run.opened.session,
      kernel: {
        id: run.kernel.id,
        name: run.kernel.name,
        state: run.kernel.execution_state,
      },
    }),
    [run],
  );
  const channel = useLocalKernel(target);
  const { state } = channel;
  const [ask, setAsk] = useState<SessionAction | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [interruptedAt, setInterruptedAt] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  const confirmRef = useRef<HTMLElement>(null);

  const connected = channel.status === 'open';
  const kernelState = state.kernel?.state;
  const canRun = connected && kernelState !== undefined && RUNNABLE.has(kernelState);
  const busy = connected && kernelIsBusy(kernelState);
  const latest = useMemo(() => latestByCell(state), [state]);
  const codeOf = (cell: NotebookCell) =>
    cell.type === 'code' ? (sources[cell.id] ?? cell.source) : '';
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
  const { runAll, runAllNote, startRunAll, cancelRunAll } = useRunAll({
    notebook,
    state,
    connected,
    reattaching: false,
    canRun,
    kernelState,
    codeOf,
    nameOf,
    runCell,
  });

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
  useEffect(() => {
    if (ask) confirmRef.current?.focus();
  }, [ask]);

  const doRestart = async () => {
    setBusyAction(true);
    setActionError(null);
    try {
      await channel.restart();
      setStalled(false);
      setInterruptedAt(null);
      cancelRunAll();
      setAsk(null);
    } catch {
      setActionError('The kernel could not be restarted.');
    } finally {
      setBusyAction(false);
    }
  };
  const doStop = async () => {
    setBusyAction(true);
    setActionError(null);
    try {
      await stop(address);
      onEnded();
    } catch (e) {
      // The connector no longer has it: it stopped, and so did the notebook's Jupyter.
      if (e instanceof ConnectorError && (e.status === 404 || e.code === 'unreachable')) {
        forget(address);
        onEnded();
        return;
      }
      setActionError('The notebook could not be stopped.');
    } finally {
      setBusyAction(false);
    }
  };

  const label = modeLabel({
    connectionName: 'This computer',
    language: languageOf(run.kernel.name, notebook.language),
    sessionState: state.session?.state ?? 'ready',
    kernelState,
    confirmed: connected,
  });

  const files = run.opened.files;
  const banner: ReactNode[] = [];
  if (channel.status === 'closed') {
    banner.push(
      <div key="lost" className={live.banner} role="alert">
        <p>
          <strong>The connection to the connector on this computer was lost.</strong> Your edits are
          kept, and cells cannot run. If the connector still runs, Connect again reaches the same
          kernel; nothing runs again by itself.
        </p>
        <div className={live.row}>
          <button type="button" className={buttons.outline} onClick={channel.reconnect}>
            Connect again
          </button>
          <button
            type="button"
            className={buttons.outline}
            onClick={() => {
              // If the connector still runs, its Jupyter for this notebook stops too.
              stop(address).catch(() => {});
              onEnded();
            }}
          >
            Stop and show saved outputs
          </button>
        </div>
      </div>,
    );
  }
  if (files && (files.written.length > 0 || files.kept.length > 0)) {
    banner.push(
      <div key="files" className={live.banner} role="status">
        <p>
          The notebook's files are in {run.opened.folder}, in the connector's folder on this
          computer.
          {files.kept.length > 0
            ? ` Your own ${files.kept.length === 1 ? 'version' : 'versions'} of ${files.kept.join(', ')} ${files.kept.length === 1 ? 'was' : 'were'} kept, not replaced.`
            : ''}
        </p>
      </div>,
    );
  }
  if (connected && kernelState === 'dead') {
    banner.push(
      <div key="dead" className={live.banner} role="alert">
        <p>The kernel stopped. Restarting it starts it empty.</p>
        <button type="button" className={buttons.outline} onClick={() => setAsk('restart')}>
          Restart kernel
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
  if (actionError || state.error) {
    banner.push(
      <div key="error" className={live.banner} role="alert">
        <p>{actionError ?? state.error?.detail ?? 'Something failed on this computer.'}</p>
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
        aria-label={ask === 'restart' ? 'Restart kernel' : 'Stop session'}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          setAsk(null);
        }}
      >
        {ask === 'restart' ? (
          <p>
            Restart the kernel? Its variables will be lost and cells that are running stop. Output
            already shown stays, marked as from the previous kernel session.
          </p>
        ) : (
          <p>
            Stop running this notebook on this computer? The connector stops its Jupyter server and
            kernel, and the variables are lost. The files in its folder stay, and your edits stay on
            this page until you leave it.
          </p>
        )}
        <div className={live.row}>
          <button
            type="button"
            className={buttons.primary}
            disabled={busyAction}
            onClick={() => void (ask === 'restart' ? doRestart() : doStop())}
          >
            {ask === 'restart' ? 'Restart kernel' : 'Stop session'}
          </button>
          <button type="button" className={buttons.outline} onClick={() => setAsk(null)}>
            Cancel
          </button>
        </div>
      </section>,
    );
  }

  return (
    <>
      <ResourceTools>
        <span className={styles.mode}>{label}</span>
        {trail}
        <LiveToolbar
          canRun={canRun}
          busy={busy}
          runningAll={runAll !== null}
          owned
          sessionActive={connected}
          canDisconnect={false}
          onRunAll={startRunAll}
          onInterrupt={() => {
            if (channel.interrupt()) {
              setStalled(false);
              setInterruptedAt(Date.now());
            }
          }}
          onAsk={setAsk}
        />
      </ResourceTools>
      <LiveCells
        notebook={notebook}
        root={root}
        banner={banner}
        outlineOpen={outlineOpen}
        showCode={showCode}
        showOutputs={showOutputs}
        sources={sources}
        onEdit={onEdit}
        latest={latest}
        refusals={state.refusals}
        kernelGeneration={state.kernel?.generation}
        canRun={canRun && runAll === null}
        runCell={runCell}
        onInputReply={channel.inputReply}
        renderRich={(item) => (
          <LocalRichOutput data={item.data} executionCount={item.executionCount} />
        )}
      />
    </>
  );
}
