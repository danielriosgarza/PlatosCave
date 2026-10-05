import { useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import type { Confirmation, ConnectionTest, Stage } from './api';
import styles from './Connect.module.css';
import {
  CATALOGUE_CAUSE_COPY,
  CODE_RECOVERIES,
  codeText,
  recoveryText,
  STAGE_LABEL,
} from './messages';

const SSH_STAGES = [
  'reachability',
  'host_identity',
  'ssh_auth',
  'workspace',
  'forwarding',
  'runtime',
  'notebook_auth',
  'kernels',
];
const LOCAL_STAGES = ['workspace', 'runtime', 'notebook_auth', 'kernels'];

/** The cause of spec §14 each stage reports, for a failure the catalogue has no code for. */
const STAGE_CAUSE: Record<string, string> = {
  reachability: 'reachability',
  host_identity: 'host_key',
  ssh_auth: 'authentication',
  workspace: 'workspace',
  forwarding: 'tunnel',
  runtime: 'runtime',
  notebook_auth: 'authentication',
  kernels: 'kernel',
};

interface Props {
  kind: 'local' | 'ssh';
  test: ConnectionTest | undefined;
  /** Host and port of each hop as the connection names them, to address a key confirmation. */
  hosts: { jump?: { host: string; port: number }; target?: { host: string; port: number } };
  busy: boolean;
  /** A refusal of the last Trust or Replace, in words. */
  actionError?: string | null;
  onTrust: (confirmation: Confirmation) => void;
  onReplace: (confirmation: Confirmation) => void;
  onRetest: () => void;
}

function statusText(stage: Stage | undefined, previousFailed: boolean): string {
  if (!stage) return previousFailed ? 'Not run' : 'Waiting';
  switch (stage.status) {
    case 'ok':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'needs_action':
      return 'Needs your confirmation';
    case 'running':
      return 'Waiting for you';
    case 'skipped':
      return stage.data?.reason === 'not_started' ? 'Checked when you connect' : 'Not run';
  }
}

function announce(stage: Stage): string {
  const label = STAGE_LABEL[stage.name] ?? stage.name;
  if (stage.status === 'failed') return `${label}: failed. ${codeText(stage.code)}`;
  if (stage.status === 'needs_action') return `${label}: needs your confirmation.`;
  if (stage.status === 'running') {
    return `${label}: waiting for you to answer in the connector's terminal.`;
  }
  return `${label}: ${statusText(stage, false).toLowerCase()}.`;
}

/**
 * The stages of Test connection as `test_progress` arrives (§5.1). Each failing stage names the
 * stage, says what failed and lists the catalogue's recoveries. A first-use key shows its
 * fingerprint with Trust this key; a changed key stops everything, shows both fingerprints and
 * offers Replace trusted key only behind a confirmation that names the host.
 */
export function StageList({
  kind,
  test,
  hosts,
  busy,
  actionError,
  onTrust,
  onReplace,
  onRetest,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const names = kind === 'ssh' ? SSH_STAGES : LOCAL_STAGES;
  const byName = new Map<string, Stage>((test?.stages ?? []).map((s) => [s.name, s]));
  const stopped = test?.stages.find((s) => s.status === 'failed' || s.status === 'needs_action');
  const latest = test?.stages.at(-1);

  return (
    <div className={styles.section}>
      <ol className={styles.stages} aria-label="Connection test">
        {names.map((name) => {
          const stage = byName.get(name);
          return (
            <li key={name} data-stage={name} data-status={stage?.status ?? 'pending'}>
              <span className={styles.state}>{STAGE_LABEL[name]}</span>
              <div className={styles.body}>
                <span>{statusText(stage, Boolean(stopped))}</span>
                {stage?.status === 'running' ? (
                  <p>
                    Waiting for you: answer the prompt in the connector's terminal on the computer
                    running it.
                  </p>
                ) : null}
                {stage?.status === 'failed' ? (
                  <Failure
                    stage={stage}
                    hosts={hosts}
                    busy={busy}
                    confirming={confirming}
                    onAskReplace={() => setConfirming(true)}
                    onCancel={() => setConfirming(false)}
                    onReplace={(c) => {
                      setConfirming(false);
                      onReplace(c);
                    }}
                  />
                ) : null}
                {stage?.status === 'needs_action' ? (
                  <Unknown stage={stage} hosts={hosts} busy={busy} onTrust={onTrust} />
                ) : null}
                {stage?.status === 'skipped' && stage.data?.blockedBy ? (
                  <span className={styles.muted}>
                    {`Not run because ${(STAGE_LABEL[stage.data.blockedBy] ?? '').toLowerCase()} did not pass.`}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {actionError ? (
        <div className={styles.alert} role="alert">
          <p>{actionError}</p>
        </div>
      ) : null}
      {test?.state === 'done' && test.code && !stopped ? (
        <div className={styles.alert} role="alert">
          <p>{codeText(test.code)}</p>
          <Recoveries code={test.code} />
        </div>
      ) : null}
      {test?.state === 'done' && test.outcome === 'failed' ? (
        <div className={styles.row}>
          <button type="button" className={buttons.outline} disabled={busy} onClick={onRetest}>
            Test again
          </button>
        </div>
      ) : null}
      <div className={styles.visuallyHidden} role="status" aria-live="polite">
        {latest ? announce(latest) : ''}
      </div>
    </div>
  );
}

function Recoveries({ code }: { code: string | undefined }) {
  const lines = recoveryText(
    (code ? (CODE_RECOVERIES[code] ?? []) : []).filter(
      // These two have a button of their own.
      (r) => r !== 'verify_host_key' && r !== 'replace_host_key',
    ),
  );
  if (lines.length === 0) return null;
  return (
    <ul>
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

function hostFor(stage: Stage, hosts: Props['hosts']) {
  return stage.data?.hop === 'jump' ? hosts.jump : hosts.target;
}

function Unknown({
  stage,
  hosts,
  busy,
  onTrust,
}: {
  stage: Stage;
  hosts: Props['hosts'];
  busy: boolean;
  onTrust: Props['onTrust'];
}) {
  const host = hostFor(stage, hosts);
  const fingerprint = stage.data?.fingerprint;
  if (!host || !fingerprint) return null;
  return (
    <div className={styles.notice}>
      <p>{`First connection to ${host.host}:${host.port}. Its key fingerprint is:`}</p>
      <p className={styles.mono}>{fingerprint}</p>
      <p>Compare it with the fingerprint the host's owner publishes before you trust it.</p>
      <div className={styles.row}>
        <button
          type="button"
          className={buttons.primary}
          disabled={busy}
          onClick={() => onTrust({ host: host.host, port: host.port, sha256: fingerprint })}
        >
          Trust this key
        </button>
      </div>
    </div>
  );
}

function Failure({
  stage,
  hosts,
  busy,
  confirming,
  onAskReplace,
  onCancel,
  onReplace,
}: {
  stage: Stage;
  hosts: Props['hosts'];
  busy: boolean;
  confirming: boolean;
  onAskReplace: () => void;
  onCancel: () => void;
  onReplace: Props['onReplace'];
}) {
  const cause = stage.code ? undefined : STAGE_CAUSE[stage.name];
  const changed = stage.code === 'host_key_changed';
  const host = hostFor(stage, hosts);
  const { expected, presented } = stage.data ?? {};
  return (
    <div className={styles.alert} role="alert">
      <p>
        {`${STAGE_LABEL[stage.name]} failed. `}
        {codeText(stage.code)}
        {cause ? ` (${CATALOGUE_CAUSE_COPY[cause]})` : ''}
      </p>
      {stage.detail ? <p className={styles.muted}>{stage.detail}</p> : null}
      {changed && host && expected && presented ? (
        <>
          <p>{`The host ${host.host}:${host.port} presented a key different from the trusted one.`}</p>
          <dl className={styles.summary}>
            <dt>Trusted key</dt>
            <dd className={styles.mono}>{expected}</dd>
            <dt>Presented key</dt>
            <dd className={styles.mono}>{presented}</dd>
          </dl>
          <p>The connection was stopped. It will not be tried again unless you replace the key.</p>
        </>
      ) : null}
      <Recoveries code={stage.code} />
      {changed && host && expected && presented ? (
        confirming ? (
          <div className={styles.notice}>
            <p>
              {`Replace the trusted key for ${host.host}:${host.port}? Do this only if the host's owner confirmed that its key changed. You must have signed in within the last 15 minutes.`}
            </p>
            <div className={styles.row}>
              <button
                type="button"
                className={buttons.primary}
                disabled={busy}
                onClick={() =>
                  onReplace({
                    host: host.host,
                    port: host.port,
                    sha256: presented,
                    replacing: expected,
                  })
                }
              >
                {`Replace key for ${host.host}`}
              </button>
              <button type="button" className={buttons.textButton} onClick={onCancel}>
                Keep the trusted key
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.row}>
            <button type="button" className={buttons.outline} onClick={onAskReplace}>
              Replace trusted key…
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
