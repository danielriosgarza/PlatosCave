import { useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import type { Connection, ConnectionTest, Connector } from './api';
import styles from './Connect.module.css';

interface Props {
  connection: Connection;
  connector: Connector | undefined;
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * What Connect will do, before it does it: the host, account and the exact working directory the
 * connector reported, whether Jupyter is started or attached, the lease in words and the networks
 * the connector reaches. A personal connection may reach this person's files with their own
 * privileges.
 */
export function ConnectSummary({ connection, connector, test, busy, onConnect }: Props) {
  const specs = test.kernelspecs ?? [];
  const wanted = connection.runtime.kernelName;
  const [kernel, setKernel] = useState(
    specs.find((k) => k.name === wanted)?.name ?? specs[0]?.name ?? '',
  );
  const [idle, setIdle] = useState(30);
  const [grace, setGrace] = useState(5);
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
            value={idle}
            onChange={(e) => setIdle(clamp(Number.parseInt(e.target.value, 10) || 5, 5, 240))}
          />
        </label>
        <label className={styles.field}>
          <span>Keep the kernel after closing this tab, minutes (1 to 60)</span>
          <input
            inputMode="numeric"
            value={grace}
            onChange={(e) => setGrace(clamp(Number.parseInt(e.target.value, 10) || 1, 1, 60))}
          />
        </label>
      </div>
      <p>{leaseSentence(idle, grace)}</p>
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
          onClick={() =>
            onConnect({
              kernelName: kernel || undefined,
              idleTimeoutMin: idle,
              gracePeriodMin: grace,
            })
          }
        >
          Connect
        </button>
      </div>
    </div>
  );
}
