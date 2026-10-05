import { type FormEvent, useId, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import type { Connection, ConnectionRuntime, ConnectionTarget, Connector } from './api';
import styles from './Connect.module.css';

export type TargetKind = 'local' | 'ssh';

export interface TargetValues {
  name: string;
  connectorId: string;
  target: ConnectionTarget;
  runtime: ConnectionRuntime;
}

interface Props {
  kind: TargetKind;
  /** Active connectors only. */
  connectors: Connector[];
  /** A saved connection being edited; its values fill the form. */
  saved?: Connection;
  busy: boolean;
  /** A refusal from the server, in words. */
  error?: string | null;
  onSubmit: (values: TargetValues) => void;
}

const LOGIN_NODE = /(^|[.-])(login|head|submit|gateway|hpc|cluster)\d*([.-]|$)/i;

/**
 * The fields of spec §10.3. It has no field for a password, passphrase or token: a key is a path
 * on the connector's computer, an agent is the SSH agent there, and a passphrase or second factor
 * is typed in the connector's own terminal.
 */
export function TargetForm({ kind, connectors, saved, busy, error, onSubmit }: Props) {
  const id = useId();
  const sshSaved = saved?.target.kind === 'ssh' ? saved.target : undefined;
  const localSaved = saved?.target.kind === 'local' ? saved.target : undefined;
  const runtimeSaved = saved?.runtime;
  const startSaved = runtimeSaved?.mode === 'start' ? runtimeSaved : undefined;
  const attachSaved = runtimeSaved?.mode === 'attach' ? runtimeSaved : undefined;

  const [name, setName] = useState(saved?.name ?? '');
  const [connectorId, setConnectorId] = useState(saved?.connectorId ?? connectors[0]?.id ?? '');
  const [host, setHost] = useState(sshSaved?.host ?? '');
  const [port, setPort] = useState(String(sshSaved?.port ?? 22));
  const [user, setUser] = useState(sshSaved?.user ?? '');
  const [useJump, setUseJump] = useState(Boolean(sshSaved?.jump));
  const [jumpHost, setJumpHost] = useState(sshSaved?.jump?.host ?? '');
  const [jumpPort, setJumpPort] = useState(String(sshSaved?.jump?.port ?? 22));
  const [jumpUser, setJumpUser] = useState(sshSaved?.jump?.user ?? '');
  const [method, setMethod] = useState<'key' | 'agent'>(
    sshSaved?.auth.method === 'agent' ? 'agent' : 'key',
  );
  const [keyPath, setKeyPath] = useState(
    sshSaved?.auth.method === 'key' ? sshSaved.auth.keyPath : '',
  );
  const [workspace, setWorkspace] = useState(sshSaved?.workspace ?? localSaved?.workspace ?? '');
  const [mode, setMode] = useState<'start' | 'attach'>(attachSaved ? 'attach' : 'start');
  const [python, setPython] = useState(startSaved?.python ?? '');
  const [login, setLogin] = useState(startSaved?.login ?? false);
  const [attachPort, setAttachPort] = useState(attachSaved ? String(attachSaved.port) : '');
  const [kernelName, setKernelName] = useState(
    startSaved?.kernelName ?? attachSaved?.kernelName ?? '',
  );
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = (v: string) => v.trim();
    const num = (v: string) => Number.parseInt(v, 10);
    if (!trimmed(name)) return setProblem('Name this connection.');
    if (!connectorId) return setProblem('Choose the computer that runs the connector.');
    if (!trimmed(workspace)) return setProblem('Enter the working directory.');
    let target: ConnectionTarget;
    if (kind === 'local') {
      target = { kind: 'local', workspace: trimmed(workspace) };
    } else {
      if (!trimmed(host) || !trimmed(user)) return setProblem('Enter the host and the account.');
      if (!(num(port) >= 1 && num(port) <= 65535)) return setProblem('The port is 1 to 65535.');
      if (method === 'key' && !trimmed(keyPath))
        return setProblem('Enter the path of the key file.');
      if (useJump && (!trimmed(jumpHost) || !trimmed(jumpUser))) {
        return setProblem('Enter the jump host and its account.');
      }
      target = {
        kind: 'ssh',
        host: trimmed(host),
        port: num(port),
        user: trimmed(user),
        auth: method === 'key' ? { method: 'key', keyPath: trimmed(keyPath) } : { method: 'agent' },
        workspace: trimmed(workspace),
        ...(useJump
          ? {
              jump: {
                host: trimmed(jumpHost),
                port: num(jumpPort) || 22,
                user: trimmed(jumpUser),
                // A jump host is reached the way the target is.
                auth:
                  method === 'key'
                    ? { method: 'key' as const, keyPath: trimmed(keyPath) }
                    : { method: 'agent' as const },
              },
            }
          : {}),
      };
    }
    let runtime: ConnectionRuntime;
    if (mode === 'attach') {
      if (!(num(attachPort) >= 1024 && num(attachPort) <= 65535)) {
        return setProblem('Enter the port of the running Jupyter server (1024 to 65535).');
      }
      runtime = {
        mode: 'attach',
        port: num(attachPort),
        ...(trimmed(kernelName) ? { kernelName: trimmed(kernelName) } : {}),
      };
    } else {
      runtime = {
        mode: 'start',
        ...(trimmed(python) ? { python: trimmed(python) } : {}),
        ...(login ? { login: true } : {}),
        ...(trimmed(kernelName) ? { kernelName: trimmed(kernelName) } : {}),
      };
    }
    setProblem(null);
    onSubmit({ name: trimmed(name), connectorId, target, runtime });
  };

  const shownError = problem ?? error;
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {shownError ? (
        <div className={styles.alert} role="alert">
          <p>{shownError}</p>
        </div>
      ) : null}
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>Connection name</span>
          <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Computer running the connector</span>
          <select value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.online ? c.name : `${c.name} (offline)`}
              </option>
            ))}
          </select>
        </label>
        {kind === 'ssh' ? (
          <>
            <label className={styles.field}>
              <span>Host</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>Port</span>
              <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>Account</span>
              <input value={user} onChange={(e) => setUser(e.target.value)} />
            </label>
          </>
        ) : null}
        <label className={styles.field}>
          <span>Working directory</span>
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
        </label>
      </div>
      {kind === 'ssh' && LOGIN_NODE.test(host.trim()) ? (
        <div className={styles.notice} role="note">
          <p>
            This looks like a login node. SSH access to a login node does not authorise computing
            there: connect to an allocated compute node, or use the scheduler your institution
            approves.
          </p>
        </div>
      ) : null}
      {kind === 'ssh' ? (
        <>
          <label className={styles.choice}>
            <input
              type="checkbox"
              checked={useJump}
              onChange={(e) => setUseJump(e.target.checked)}
            />
            Reach this host through a jump host
          </label>
          {useJump ? (
            <div className={styles.fields}>
              <label className={styles.field}>
                <span>Jump host</span>
                <input value={jumpHost} onChange={(e) => setJumpHost(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span>Jump host port</span>
                <input
                  inputMode="numeric"
                  value={jumpPort}
                  onChange={(e) => setJumpPort(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>Jump host account</span>
                <input value={jumpUser} onChange={(e) => setJumpUser(e.target.value)} />
              </label>
            </div>
          ) : null}
          <fieldset className={styles.fieldset}>
            <legend>Authentication</legend>
            <label className={styles.choice}>
              <input
                type="radio"
                name={`${id}-auth`}
                checked={method === 'key'}
                onChange={() => setMethod('key')}
              />
              Key file on the connector's computer
            </label>
            <label className={styles.choice}>
              <input
                type="radio"
                name={`${id}-auth`}
                checked={method === 'agent'}
                onChange={() => setMethod('agent')}
              />
              SSH agent on the connector's computer
            </label>
            {method === 'key' ? (
              <label className={styles.field}>
                <span>Key file path</span>
                <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
              </label>
            ) : null}
            <span className={styles.muted}>
              A passphrase or second factor is typed in the connector's terminal, never here.
            </span>
          </fieldset>
        </>
      ) : null}
      <fieldset className={styles.fieldset}>
        <legend>Jupyter</legend>
        <label className={styles.choice}>
          <input
            type="radio"
            name={`${id}-mode`}
            checked={mode === 'start'}
            onChange={() => setMode('start')}
          />
          Start Jupyter for this session
        </label>
        <label className={styles.choice}>
          <input
            type="radio"
            name={`${id}-mode`}
            checked={mode === 'attach'}
            onChange={() => setMode('attach')}
          />
          Attach to a Jupyter server that is already running
        </label>
        <div className={styles.fields}>
          {mode === 'start' ? (
            <>
              <label className={styles.field}>
                <span>Python interpreter (optional)</span>
                <input value={python} onChange={(e) => setPython(e.target.value)} />
              </label>
              <label className={styles.choice}>
                <input
                  type="checkbox"
                  checked={login}
                  onChange={(e) => setLogin(e.target.checked)}
                />
                Start it in a login shell
              </label>
            </>
          ) : (
            <label className={styles.field}>
              <span>Port of the running server</span>
              <input
                inputMode="numeric"
                value={attachPort}
                onChange={(e) => setAttachPort(e.target.value)}
              />
            </label>
          )}
          <label className={styles.field}>
            <span>Kernel name (optional)</span>
            <input value={kernelName} onChange={(e) => setKernelName(e.target.value)} />
          </label>
        </div>
      </fieldset>
      <div className={styles.row}>
        <button
          type="submit"
          className={buttons.primary}
          disabled={busy || connectors.length === 0}
        >
          Save and test connection
        </button>
      </div>
    </form>
  );
}
