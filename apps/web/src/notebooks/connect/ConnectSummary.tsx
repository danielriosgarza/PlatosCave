import { useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import type { ComputeTemplate, Connection, ConnectionTest, Connector } from './api';
import { ISOLATION_TEXT } from './ClassComputers';
import styles from './Connect.module.css';

interface Props {
  connection: Connection;
  connector: Connector | undefined;
  /** The class computer the connection was made from; its lease is the default (§9). */
  template?: ComputeTemplate | undefined;
  /** The operator's default lease, used when the class computer sets none. */
  defaultLease?: { idleTimeoutMin: number; gracePeriodMin: number } | undefined;
  test: ConnectionTest;
  busy: boolean;
  onConnect: (choice: {
    kernelName: string | undefined;
    idleTimeoutMin: number;
    gracePeriodMin: number;
  }) => void;
}

/** The words of design §9: what happens to the kernel when the tab closes or goes quiet. */
export const leaseSentence = (idle: number, grace: number) =>
  `Closing this tab keeps your kernel for ${grace} ${grace === 1 ? 'minute' : 'minutes'}. An open notebook with no activity stops after ${idle} minutes. If this computer sleeps past that deadline, the session stops when it wakes.`;

/**
 * What Connect will do, before it does it: the host, account and the exact working directory the
 * connector reported, whether Jupyter is started or attached, the lease in words and the networks
 * the connector reaches. A personal connection may reach this person's files with their own
 * privileges.
 */
export function ConnectSummary({
  connection,
  connector,
  template,
  defaultLease,
  test,
  busy,
  onConnect,
}: Props) {
  const specs = test.kernelspecs ?? [];
  const wanted = connection.runtime.kernelName;
  const [kernel, setKernel] = useState(
    specs.find((k) => k.name === wanted)?.name ?? specs[0]?.name ?? '',
  );
  // Kept as typed and checked on Connect, so any value can be typed.
  const [idleText, setIdleText] = useState(
    String(template?.lease?.idleTimeoutMin ?? defaultLease?.idleTimeoutMin ?? 30),
  );
  const [graceText, setGraceText] = useState(
    String(template?.lease?.gracePeriodMin ?? defaultLease?.gracePeriodMin ?? 5),
  );
  const [problem, setProblem] = useState<string | null>(null);
  // A class computer that sets a lease holds it; the server refuses any other.
  const leaseFixed = Boolean(template?.lease);
  const idle = Number(idleText);
  const grace = Number(graceText);
  const idleOk = /^\d+$/.test(idleText.trim()) && idle >= 5 && idle <= 240;
  const graceOk = /^\d+$/.test(graceText.trim()) && grace >= 1 && grace <= 60;
  const target = connection.target;
  const resolved = test.stages.find((s) => s.name === 'workspace')?.data?.resolvedPath;
  const workspace = resolved ?? ('workspace' in target ? target.workspace : '');
  const where =
    target.kind === 'ssh' ? `${target.host}:${target.port}` : (connector?.name ?? 'This computer');
  const account = target.kind === 'ssh' ? target.user : 'the account running the connector';
  const attach = connection.runtime.mode === 'attach';
  const scope = connector?.networkScope;
  const reach = scope
    ? `This connector reaches public hosts${scope.cidrs.length ? ` and ${scope.cidrs.join(', ')}` : ''}${scope.hosts.length ? `, and ${scope.hosts.join(', ')}` : ''}.`
    : null;

  return (
    <div className={styles.section}>
      <dl className={styles.summary}>
        <dt>Computer</dt>
        <dd>{where}</dd>
        <dt>Account</dt>
        <dd>{account}</dd>
        {template ? (
          <>
            <dt>Class computer</dt>
            <dd>{`${template.name}. ${ISOLATION_TEXT[template.isolation]}`}</dd>
          </>
        ) : null}
        <dt>Working directory</dt>
        <dd className={styles.mono}>{workspace}</dd>
        <dt>Jupyter</dt>
        <dd>
          {attach
            ? `Attach to the server on port ${connection.runtime.mode === 'attach' ? connection.runtime.port : ''}. Stopping the session leaves that server running.`
            : 'Start a server for this session. Stopping the session stops it.'}
        </dd>
        {test.jupyterVersion ? (
          <>
            <dt>Jupyter version</dt>
            <dd>{test.jupyterVersion}</dd>
          </>
        ) : null}
      </dl>
      {specs.length > 0 ? (
        <label className={styles.field}>
          <span>Kernel</span>
          <select value={kernel} onChange={(e) => setKernel(e.target.value)}>
            {specs.map((k) => (
              <option key={k.name} value={k.name}>
                {k.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>Stop after minutes with no activity (5 to 240)</span>
          <input
            inputMode="numeric"
            readOnly={leaseFixed}
            value={idleText}
            onChange={(e) => setIdleText(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Keep the kernel after closing this tab, minutes (1 to 60)</span>
          <input
            inputMode="numeric"
            readOnly={leaseFixed}
            value={graceText}
            onChange={(e) => setGraceText(e.target.value)}
          />
        </label>
      </div>
      {problem ? (
        <div className={styles.alert} role="alert">
          <p>{problem}</p>
        </div>
      ) : null}
      {idleOk && graceOk ? <p>{leaseSentence(idle, grace)}</p> : null}
      {leaseFixed ? (
        <p className={styles.muted}>The instructor set these times for this class computer.</p>
      ) : null}
      {reach ? <p className={styles.muted}>{reach}</p> : null}
      <p className={styles.muted}>
        This connection can read and change the files this account can, with that account's
        privileges. Only connect to a computer you are allowed to use.
      </p>
      <div className={styles.row}>
        <button
          type="button"
          className={buttons.primary}
          disabled={busy}
          onClick={() => {
            if (!idleOk) return setProblem('Stop after: enter whole minutes from 5 to 240.');
            if (!graceOk) return setProblem('Keep the kernel: enter whole minutes from 1 to 60.');
            setProblem(null);
            onConnect({
              kernelName: kernel || undefined,
              idleTimeoutMin: idle,
              gracePeriodMin: grace,
            });
          }}
        >
          Connect
        </button>
      </div>
    </div>
  );
}
