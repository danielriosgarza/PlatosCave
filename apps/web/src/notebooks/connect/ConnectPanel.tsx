import { useEffect, useRef, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import { Loading } from '../../components/Loading';
import {
  type Confirmation,
  type Connection,
  errorCode,
  isOpenState,
  type NotebookSession,
  restartKernel,
  startKernel,
  startTest,
  useComputeTemplates,
  useConnectionActions,
  useConnections,
  useConnectionTest,
  useConnectors,
  useKernel,
  useNotebookSession,
  useSessionActions,
  useSessions,
} from './api';
import { TemplateConnectForm } from './ClassComputers';
import styles from './Connect.module.css';
import { ConnectSummary } from './ConnectSummary';
import { DeviceList } from './DeviceList';
import { useCancelOnEscape } from './escape';
import { LossNotice } from './LossNotice';
import { CODE_COPY, CODE_RECOVERIES, causeText, codeText, recoveryText } from './messages';
import { StageList } from './StageList';
import { TargetForm, type TargetKind, type TargetValues } from './TargetForm';
import { TemplateManager } from './TemplateManager';

interface Props {
  classId: string;
  /** The notebook revision a session is opened for. */
  revisionId: string;
  /** An instructor of the class also publishes its class computers here. */
  instructor?: boolean;
  onClose: () => void;
}

const REFUSALS: Record<string, string> = {
  recent_auth_required:
    'Replacing a host key needs a recent sign-in. Sign in again, then replace it.',
  replacing_mismatch:
    "The host's key changed again. Test the connection again to see the current key.",
  connector_offline:
    'That computer is not connected to Parallax. Start the connector there and try again.',
  connector_not_active: 'That computer is not approved yet.',
  name_taken: 'Another connection already has this name.',
  wrong_class: 'This connection belongs to another class.',
  class_archived: 'This class is archived.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  forbidden: 'A draft preview cannot connect a computer.',
  not_owned:
    'Parallax did not start this Jupyter server, so it cannot stop it. Disconnect leaves it running.',
  not_open: 'This session has already ended.',
  not_forgettable: 'This session can no longer be given up on; its state has changed.',
  template_archived:
    'Your instructor archived this class computer. Choose another class computer or target.',
};

function refusalText(error: unknown, fallback: string): string {
  const body = (error as { body?: { error?: string; code?: string } } | null)?.body;
  if (body?.error === 'target_not_allowed') return codeText(body.code);
  return REFUSALS[errorCode(error) ?? ''] ?? fallback;
}

/**
 * Why a kernel start or restart was refused. A 409 `kernel_failed` carries a catalogue code
 * (design §5.4): its copy and recovery follow the generic sentence.
 */
function kernelRefusalText(error: unknown, fallback: string): string {
  const body = (error as { body?: { error?: string; code?: string } } | null)?.body;
  const code = body?.error === 'kernel_failed' ? body.code : undefined;
  if (!code || !CODE_COPY[code]) return refusalText(error, fallback);
  return [fallback, CODE_COPY[code], ...recoveryText(CODE_RECOVERIES[code] ?? [])].join(' ');
}

/**
 * Connect computer (spec §10.3), opened from the notebook toolbar's target label: pair and
 * approve the computers that run the connector, describe a target, test it stage by stage, and
 * connect. **Ready** appears only when the session is ready and its kernel reports idle (§5.6);
 * SSH alone never shows Connected.
 */
export function ConnectPanel({ classId, revisionId, instructor = false, onClose }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const connectors = useConnectors();
  const connections = useConnections();
  const templates = useComputeTemplates(classId);
  const sessions = useSessions(classId);
  const connectionActions = useConnectionActions();
  const sessionActions = useSessionActions(classId);

  const [kind, setKind] = useState<TargetKind | 'template'>('local');
  const [selected, setSelected] = useState<string>('new');
  const [connection, setConnection] = useState<Connection | undefined>();
  const [testRef, setTestRef] = useState<{ connectionId: string; testId: string } | undefined>();
  const [chosenKernel, setChosenKernel] = useState<string | undefined>();
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Sessions the person has left: the cached list may still call them open.
  const [left, setLeft] = useState<string[]>([]);
  // Keyed by session: a refusal for one session says nothing about the next.
  // `again` is the action that was refused, so the retry repeats it.
  const [kernelError, setKernelError] = useState<{
    id: string;
    text: string;
    again: 'start' | 'restart';
  } | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => heading.current?.focus(), []);

  const test = useConnectionTest(testRef?.connectionId, testRef?.testId);
  const open = sessions.data?.find(
    (s) => s.resourceRevisionId === revisionId && isOpenState(s.state) && !left.includes(s.id),
  );
  const activeId = sessionId ?? open?.id;
  const session = useNotebookSession(classId, activeId);
  const kernel = useKernel(classId, activeId, session.data?.state === 'ready');
  const startedKernel = useRef<string | null>(null);

  const active = (connectors.data ?? []).filter((c) => c.status === 'active');
  const saved = connections.data ?? [];
  const classComputers = templates.data ?? [];

  // Ready is a state of the kernel, so the chosen kernel is started once, for a session that has
  // never had one. A kernel the relay lost is only replaced when the person asks (design §10.6).
  const readySession = session.data?.state === 'ready' ? session.data : undefined;
  const kernelKnown = kernel.data !== undefined;
  const kernelView = kernel.data?.kernel ?? null;
  const kernelLost = Boolean(
    readySession && kernelKnown && !kernelView && readySession.cause === 'kernel_lost',
  );
  const kernelToStart =
    chosenKernel ??
    readySession?.kernelName ??
    readySession?.runtime.kernelName ??
    readySession?.runtime.kernelspecs?.[0]?.name;
  const startFor = (id: string, name: string) =>
    startKernel(classId, id, name)
      .then(() => setKernelError(null))
      .catch((e) =>
        setKernelError({
          id,
          text: kernelRefusalText(e, 'The kernel could not be started.'),
          again: 'start',
        }),
      );
  const restartFor = (id: string) =>
    restartKernel(classId, id)
      .then(() => setKernelError(null))
      .catch((e) =>
        setKernelError({
          id,
          text: kernelRefusalText(e, 'The kernel could not be restarted.'),
          again: 'restart',
        }),
      );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `startFor` is rebuilt every render; the effect runs once per ready session
  useEffect(() => {
    if (!readySession || !kernelKnown || kernelView || kernelLost || !kernelToStart) return;
    if (startedKernel.current === readySession.id) return;
    startedKernel.current = readySession.id;
    void startFor(readySession.id, kernelToStart);
  }, [readySession, kernelKnown, kernelView, kernelLost, kernelToStart, classId]);

  // A refusal says nothing once the kernel is running again: its note and retry would act on a
  // healthy kernel.
  const kernelRecovered =
    kernelView !== null && kernelView.state !== 'dead' && kernelView.state !== 'unknown';
  useEffect(() => {
    if (kernelRecovered) setKernelError(null);
  }, [kernelRecovered]);
  const kernelFailure =
    kernelError && !kernelRecovered && kernelError.id === readySession?.id
      ? kernelError.text
      : null;
  let kernelNote: KernelNote | null = null;
  if (readySession && kernelFailure) {
    kernelNote = {
      text: kernelFailure,
      actionLabel:
        kernelError?.again === 'restart' ? 'Restart the kernel' : 'Start the kernel again',
      onAction: () => {
        setKernelError(null);
        if (kernelError?.again === 'restart') void restartFor(readySession.id);
        else if (kernelToStart) void startFor(readySession.id, kernelToStart);
      },
    };
  } else if (readySession && kernelLost) {
    kernelNote = {
      text: `${causeText('kernel_lost')} A new kernel starts empty.`,
      actionLabel: 'Start a new kernel',
      onAction: () => {
        if (kernelToStart) void startFor(readySession.id, kernelToStart);
      },
    };
  } else if (readySession && (kernelView?.state === 'dead' || kernelView?.state === 'unknown')) {
    kernelNote = {
      text:
        kernelView.state === 'dead'
          ? 'The kernel is not running. Its variables are gone.'
          : 'Parallax cannot tell what state the kernel is in. Restarting it loses its variables.',
      actionLabel: 'Restart the kernel',
      onAction: () => {
        void restartFor(readySession.id);
      },
    };
  }

  const runTest = async (conn: Connection, confirmations?: Confirmation[]) => {
    const { testId } = await startTest(conn.id, confirmations);
    setTestRef({ connectionId: conn.id, testId });
  };

  const submit = async (values: TargetValues & { templateId?: string }) => {
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      const existing = selected === 'new' ? undefined : saved.find((c) => c.id === selected);
      const conn = existing
        ? await connectionActions.update.mutateAsync({
            connectionId: existing.id,
            body: { name: values.name, target: values.target, runtime: values.runtime },
          })
        : await connectionActions.create.mutateAsync(values);
      setConnection(conn);
      setSelected(conn.id);
      await runTest(conn);
    } catch (e) {
      setError(refusalText(e, 'The connection could not be saved and tested.'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (confirmation: Confirmation) => {
    if (!connection) return;
    setBusy(true);
    setActionError(null);
    try {
      await runTest(connection, [confirmation]);
    } catch (e) {
      setActionError(refusalText(e, 'The key could not be confirmed.'));
    } finally {
      setBusy(false);
    }
  };

  const retest = async () => {
    if (!connection) return;
    setBusy(true);
    setActionError(null);
    try {
      await runTest(connection);
    } catch (e) {
      setActionError(refusalText(e, 'The test could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (choice: {
    kernelName: string | undefined;
    idleTimeoutMin: number;
    gracePeriodMin: number;
  }) => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    setChosenKernel(choice.kernelName);
    setKernelError(null);
    startedKernel.current = null;
    try {
      const runtime = choice.kernelName
        ? { ...connection.runtime, kernelName: choice.kernelName }
        : connection.runtime;
      const opened = await sessionActions.open.mutateAsync({
        connectionId: connection.id,
        revisionId,
        runtime,
        lease: { idleTimeoutMin: choice.idleTimeoutMin, gracePeriodMin: choice.gracePeriodMin },
      });
      setSessionId(opened.sessionId);
    } catch (e) {
      const body = (e as { body?: { error?: string; sessionId?: string } } | null)?.body;
      if (body?.error === 'session_exists' && body.sessionId) setSessionId(body.sessionId);
      else setError(refusalText(e, 'The session could not be opened.'));
    } finally {
      setBusy(false);
    }
  };

  const pick = (id: string) => {
    setSelected(id);
    setTestRef(undefined);
    setConnection(undefined);
    setError(null);
    const found = saved.find((c) => c.id === id);
    if (found)
      setKind(found.templateId ? 'template' : found.target.kind === 'ssh' ? 'ssh' : 'local');
  };

  const leaveSession = () => {
    if (activeId) setLeft((ids) => [...ids, activeId]);
    void sessions.refetch();
    setSessionError(null);
    setKernelError(null);
    startedKernel.current = null;
    setSessionId(undefined);
    setTestRef(undefined);
  };

  const target = connection?.target;
  const hosts = {
    jump:
      target?.kind === 'ssh' && target.jump
        ? { host: target.jump.host, port: target.jump.port }
        : undefined,
    target: target?.kind === 'ssh' ? { host: target.host, port: target.port } : undefined,
  };
  const testDone = test.data?.state === 'done' ? test.data : undefined;
  const connectable =
    testDone && (testDone.outcome === 'ready' || testDone.outcome === 'ready_to_start');
  const editing = selected === 'new' ? undefined : saved.find((c) => c.id === selected);
  const choose = (next: TargetKind | 'template') => {
    setKind(next);
    setSelected('new');
    setTestRef(undefined);
  };
  const templateMissing =
    kind === 'template' &&
    editing?.templateId &&
    !classComputers.some((t) => t.id === editing.templateId);

  return (
    <section
      className={styles.panel}
      aria-labelledby="connect-heading"
      onKeyDown={(e) => {
        // An inline confirmation that is open took the key and cancelled itself.
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className={styles.head}>
        <h2 id="connect-heading" tabIndex={-1} ref={heading}>
          Connect a computer
        </h2>
        <button type="button" className={buttons.tool} onClick={onClose}>
          Close
        </button>
      </div>

      {session.data && activeId ? (
        <SessionBlock
          session={session.data}
          connectionName={saved.find((c) => c.id === session.data?.connectionId)?.name}
          kernelState={kernelLost ? 'lost' : kernelView?.state}
          kernelNote={kernelNote}
          busy={sessionActions.close.isPending || sessionActions.forget.isPending}
          onRefresh={() => void session.refetch()}
          error={sessionError}
          onClose={(stop) => {
            setSessionError(null);
            sessionActions.close.mutate(
              { sessionId: session.data.id, stop },
              {
                onError: (e) => setSessionError(refusalText(e, 'The session could not be closed.')),
              },
            );
          }}
          onForget={() => {
            setSessionError(null);
            sessionActions.forget.mutate(session.data.id, {
              onError: (e) =>
                setSessionError(refusalText(e, 'The session could not be given up on.')),
            });
          }}
          onLeave={leaveSession}
        />
      ) : activeId ? (
        <Loading label="Reading the session" />
      ) : null}
      {error ? (
        <div className={styles.alert} role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      {activeId && session.data && isOpenState(session.data.state) ? null : (
        <>
          <div className={styles.section}>
            <h3>Computers</h3>
            <DeviceList />
          </div>
          <div className={styles.section}>
            <h3>Target</h3>
            <fieldset className={styles.fieldset}>
              <legend>Where should the notebook run?</legend>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="connect-kind"
                  checked={kind === 'local'}
                  onChange={() => choose('local')}
                />
                This computer
              </label>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="connect-kind"
                  checked={kind === 'ssh'}
                  onChange={() => choose('ssh')}
                />
                SSH host
              </label>
              {classComputers.length > 0 || kind === 'template' ? (
                <label className={styles.choice}>
                  <input
                    type="radio"
                    name="connect-kind"
                    checked={kind === 'template'}
                    onChange={() => choose('template')}
                  />
                  Class computers
                </label>
              ) : null}
            </fieldset>
            {saved.length > 0 ? (
              <label className={styles.field}>
                <span>Saved connection</span>
                <select value={selected} onChange={(e) => pick(e.target.value)}>
                  <option value="new">New connection</option>
                  {saved.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {active.length === 0 ? (
              <p>Pair and approve a computer above, then describe the target.</p>
            ) : templateMissing ? (
              <p>
                This connection was made from a class computer this class does not offer now. Choose
                another target.
              </p>
            ) : kind === 'template' ? (
              <TemplateConnectForm
                key={`template-${selected}`}
                templates={classComputers}
                connectors={active}
                saved={editing}
                busy={busy}
                onSubmit={(v) => void submit(v)}
              />
            ) : (
              <TargetForm
                key={`${kind}-${selected}`}
                kind={kind}
                connectors={active}
                saved={editing}
                busy={busy}
                onSubmit={(v) => void submit(v)}
              />
            )}
          </div>
          {testRef && connection ? (
            <div className={styles.section}>
              <h3>Test</h3>
              {test.isError ? (
                <div className={styles.alert} role="alert">
                  <p>The test result could not be read.</p>
                </div>
              ) : (
                <StageList
                  kind={connection.target.kind === 'ssh' ? 'ssh' : 'local'}
                  test={test.data}
                  hosts={hosts}
                  busy={busy}
                  actionError={actionError}
                  onTrust={(c) => void confirm(c)}
                  onReplace={(c) => void confirm(c)}
                  onRetest={() => void retest()}
                />
              )}
            </div>
          ) : null}
          {connectable && connection ? (
            <div className={styles.section}>
              <h3>Connect</h3>
              <ConnectSummary
                connection={connection}
                connector={(connectors.data ?? []).find((c) => c.id === connection.connectorId)}
                template={classComputers.find((t) => t.id === connection.templateId)}
                test={testDone}
                busy={busy}
                onConnect={(c) => void connect(c)}
              />
            </div>
          ) : null}
          {instructor ? <TemplateManager classId={classId} /> : null}
        </>
      )}
    </section>
  );
}

interface KernelNote {
  text: string;
  actionLabel: string;
  onAction: () => void;
}

const KERNEL_LABEL: Record<string, string> = {
  idle: 'Ready',
  busy: 'Running',
  waiting_for_input: 'Waiting for input',
  restarting: 'Restarting',
  dead: 'Kernel stopped',
  unknown: 'Kernel state unknown',
  lost: 'No kernel',
};

function runtimeLabel(session: NotebookSession) {
  return session.runtime.mode === 'attach' ? 'Attached' : 'Python';
}

/** The state line of §5.6 and what can be done with the session. */
function SessionBlock({
  session,
  connectionName,
  kernelState,
  busy,
  error,
  kernelNote,
  onRefresh,
  onClose,
  onForget,
  onLeave,
}: {
  session: NotebookSession;
  connectionName: string | undefined;
  kernelState: string | undefined;
  busy: boolean;
  error: string | null;
  kernelNote: KernelNote | null;
  onRefresh: () => void;
  onClose: (stop: boolean) => void;
  onForget: () => void;
  onLeave: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  const stop = useCancelOnEscape(stopping, () => setStopping(false));
  const name = connectionName ?? 'Connection';
  if (session.state === 'starting' || session.state === 'ready') {
    // Ready is the kernel's word, not the session's (§5.6).
    const label =
      session.state === 'starting' || !kernelState || kernelState === 'starting'
        ? 'Starting'
        : (KERNEL_LABEL[kernelState] ?? 'Kernel state unknown');
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: Escape cancels the open stop confirmation
      <div className={styles.section} onKeyDown={stop.onKeyDown}>
        <p role="status">
          <span className={styles.state}>{`${name} · ${runtimeLabel(session)} · ${label}`}</span>
        </p>
        {error ? (
          <div className={styles.alert} role="alert">
            <p>{error}</p>
          </div>
        ) : null}
        {kernelNote ? (
          <div className={styles.alert} role="alert">
            <p>{kernelNote.text}</p>
            <button type="button" className={buttons.outline} onClick={kernelNote.onAction}>
              {kernelNote.actionLabel}
            </button>
          </div>
        ) : null}
        {label === 'Starting' && session.state === 'ready' && !kernelNote ? (
          <p className={styles.muted}>Jupyter is running. Waiting for the kernel to be idle.</p>
        ) : null}
        <div className={styles.row}>
          <button
            type="button"
            className={buttons.outline}
            disabled={busy}
            onClick={() => onClose(false)}
          >
            Disconnect
          </button>
          {session.owned ? (
            stopping ? (
              <>
                <button
                  type="button"
                  className={buttons.primary}
                  disabled={busy}
                  onClick={() => onClose(true)}
                >
                  Stop the session and its kernel
                </button>
                <button
                  type="button"
                  className={buttons.textButton}
                  onClick={() => setStopping(false)}
                >
                  Keep it running
                </button>
              </>
            ) : (
              <button
                ref={stop.trigger}
                type="button"
                className={buttons.outline}
                onClick={() => setStopping(true)}
              >
                Stop session
              </button>
            )
          ) : null}
        </div>
        {session.owned ? null : (
          <p className={styles.muted}>
            Parallax did not start this Jupyter server, so it can only disconnect from it.
          </p>
        )}
      </div>
    );
  }
  return (
    <>
      {error ? (
        <div className={styles.alert} role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      <LossNotice
        session={session}
        busy={busy}
        onReconnect={onRefresh}
        onForget={onForget}
        onChooseAnother={onLeave}
        onNewSession={onLeave}
      />
    </>
  );
}
