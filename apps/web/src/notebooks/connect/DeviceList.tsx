import { useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import { Loading } from '../../components/Loading';
import { RetryNotice } from '../../components/RetryNotice';
import { type Connector, errorCode, useConnectorActions, useConnectors } from './api';
import styles from './Connect.module.css';
import { useCancelOnEscape } from './escape';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const REFUSALS: Record<string, string> = {
  recent_auth_required:
    'Approving a computer needs a recent sign-in. Sign in again, then approve it.',
  not_pending: 'This computer is no longer waiting for approval.',
  too_many_connectors: 'Five computers are already active. Revoke one first.',
  forbidden: 'A draft preview cannot manage computers.',
  rate_limited: 'Too many pairing codes this hour. Try again later.',
};

// Connector binaries are GitHub release assets of this repository (tag connector-v<version>), each
// release carrying its own SHA256SUMS file (docs/operations.md, "Connector downloads").
export const CONNECTOR_RELEASES = 'https://github.com/danielriosgarza/PlatosCave/releases';

/** The message for a refused request: its own reason when the API gave one, else a plain failure. */
const refusal = (error: unknown, fallback: string) => REFUSALS[errorCode(error) ?? ''] ?? fallback;

/**
 * This person's connectors (§3): name, system, version, whether it is online, its fingerprint,
 * and Approve, Reject, Revoke and Rename. With none, or on request, it shows the pairing line to
 * run on the computer to connect, with its code and when the code expires.
 */
export function DeviceList() {
  const actions = useConnectorActions();
  // While a code is live the computer may register from another machine at any moment.
  const codeExpiry = actions.pair.data ? new Date(actions.pair.data.expiresAt).getTime() : 0;
  const connectors = useConnectors(codeExpiry > Date.now());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (connectors.isError) {
    return (
      <RetryNotice
        message="Your computers could not be loaded."
        onRetry={() => void connectors.refetch()}
      />
    );
  }
  if (!connectors.data) return <Loading label="Loading your computers" />;
  const shown = connectors.data.filter((c) => c.status !== 'revoked');
  const code = actions.pair.data;

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(refusal(e, fallback));
    }
  };

  return (
    <div className={styles.section}>
      {error ? (
        <div className={styles.alert} role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ul className={styles.list} aria-label="Your computers">
          {shown.map((c) => (
            <Device
              key={c.id}
              connector={c}
              renaming={renaming === c.id}
              name={name}
              revoking={revoking === c.id}
              busy={
                actions.approve.isPending || actions.revoke.isPending || actions.rename.isPending
              }
              onName={setName}
              onStartRename={() => {
                setRenaming(c.id);
                setName(c.name);
              }}
              onCancelRename={() => setRenaming(null)}
              onRename={() =>
                run(async () => {
                  await actions.rename.mutateAsync({ connectorId: c.id, name: name.trim() });
                  setRenaming(null);
                }, 'The computer could not be renamed.')
              }
              onApprove={() =>
                run(() => actions.approve.mutateAsync(c.id), 'The computer could not be approved.')
              }
              onAskRevoke={() => setRevoking(c.id)}
              onCancelRevoke={() => setRevoking(null)}
              onRevoke={() =>
                run(async () => {
                  await actions.revoke.mutateAsync(c.id);
                  setRevoking(null);
                }, 'The computer could not be revoked.')
              }
            />
          ))}
        </ul>
      ) : (
        <p>No computer is paired. Pair the computer that will run your notebooks.</p>
      )}
      <p>
        The connector is a program for the computer that will run your notebooks. Download the file
        named <code>parallax-connector_&lt;version&gt;_&lt;system&gt;_&lt;chip&gt;</code> that
        matches that computer (linux, darwin for macOS or windows; amd64, or arm64 for Apple silicon
        and ARM Linux) from the{' '}
        <a href={CONNECTOR_RELEASES} target="_blank" rel="noreferrer">
          connector releases
        </a>
        . Check it against the <code>SHA256SUMS</code> file of the same release. On Linux and macOS,
        make it executable with <code>chmod +x</code>; the release notes say how to clear the macOS
        quarantine flag. Run it as <code>parallax-connector</code> (rename it or put it on your
        path).
      </p>
      <div className={styles.row}>
        <button
          type="button"
          className={buttons.outline}
          disabled={actions.pair.isPending}
          onClick={() =>
            void run(() => actions.pair.mutateAsync(), 'A pairing code could not be created.')
          }
        >
          Pair a computer
        </button>
      </div>
      {code ? (
        <div className={styles.notice}>
          <p>
            On the computer to connect, install the connector and run this line. The code works once
            and expires at {time(code.expiresAt)}.
          </p>
          <p className={styles.line}>
            {`parallax-connector pair --server ${window.location.origin} --code ${code.code}`}
          </p>
          <p>
            The connector then prints a fingerprint. When the computer appears here as waiting,
            compare the two before you approve it.
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface DeviceProps {
  connector: Connector;
  renaming: boolean;
  name: string;
  revoking: boolean;
  busy: boolean;
  onName: (name: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: () => void;
  onApprove: () => void;
  onAskRevoke: () => void;
  onCancelRevoke: () => void;
  onRevoke: () => void;
}

function Device(p: DeviceProps) {
  const c = p.connector;
  const pending = c.status === 'pending';
  const rename = useCancelOnEscape(p.renaming, p.onCancelRename);
  const revoke = useCancelOnEscape(p.revoking, p.onCancelRevoke);
  return (
    <li>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape cancels the open confirmation in this row */}
      <div className={styles.row} onKeyDown={rename.onKeyDown}>
        {p.renaming ? (
          <>
            <label className={styles.field}>
              <span>{`New name for ${c.name}`}</span>
              <input value={p.name} maxLength={64} onChange={(e) => p.onName(e.target.value)} />
            </label>
            <button
              type="button"
              className={buttons.outline}
              disabled={p.busy || p.name.trim() === ''}
              onClick={p.onRename}
            >
              Save name
            </button>
            <button type="button" className={buttons.textButton} onClick={p.onCancelRename}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <strong>{c.name}</strong>
            <span className={styles.state}>
              {pending ? 'Waiting for approval' : c.online ? 'Online' : 'Offline'}
            </span>
          </>
        )}
      </div>
      <div className={styles.muted}>
        {`${c.os} ${c.arch} · connector ${c.version}`}
        {pending && c.approveBy ? ` · approve by ${time(c.approveBy)}` : ''}
      </div>
      <div>
        <span className={styles.muted}>Fingerprint </span>
        <span className={styles.mono}>{c.fingerprint}</span>
      </div>
      {pending ? (
        <p className={styles.muted}>
          Approve only if this fingerprint matches the one the connector printed.
        </p>
      ) : null}
      {p.revoking ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape cancels the open confirmation in this row
        <div className={styles.notice} onKeyDown={revoke.onKeyDown}>
          <p>
            {`Revoke ${c.name}? It will disconnect now, and sessions on it will be shown as unconfirmed. This does not revoke any SSH account.`}
          </p>
          <div className={styles.row}>
            <button
              type="button"
              className={buttons.primary}
              disabled={p.busy}
              onClick={p.onRevoke}
            >
              {`Revoke ${c.name}`}
            </button>
            <button type="button" className={buttons.textButton} onClick={p.onCancelRevoke}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.row}>
          {pending ? (
            <>
              <button
                type="button"
                className={buttons.primary}
                disabled={p.busy}
                onClick={p.onApprove}
                aria-label={`Approve ${c.name}`}
              >
                Approve
              </button>
              <button
                type="button"
                className={buttons.outline}
                disabled={p.busy}
                onClick={p.onRevoke}
                aria-label={`Reject ${c.name}`}
              >
                Reject
              </button>
            </>
          ) : (
            <button
              ref={revoke.trigger}
              type="button"
              className={buttons.outline}
              onClick={p.onAskRevoke}
              aria-label={`Revoke ${c.name}`}
            >
              Revoke
            </button>
          )}
          {p.renaming ? null : (
            <button
              ref={rename.trigger}
              type="button"
              className={buttons.textButton}
              onClick={p.onStartRename}
              aria-label={`Rename ${c.name}`}
            >
              Rename
            </button>
          )}
        </div>
      )}
    </li>
  );
}
