import buttons from '../../components/Buttons.module.css';
import type { NotebookSession } from './api';
import styles from './Connect.module.css';
import {
  CAUSE_RECOVERIES,
  CODE_RECOVERIES,
  CODE_STAGE,
  causeText,
  codeText,
  recoveryText,
  STAGE_LABEL,
} from './messages';

interface Props {
  session: NotebookSession;
  busy: boolean;
  onReconnect: () => void;
  onForget: () => void;
  onChooseAnother: () => void;
  onNewSession: () => void;
}

/**
 * Recoveries a failed session does not list: the buttons below cover choosing another target and
 * starting a new session (there is no retry of its own), and the host-key steps need the connection
 * test's fingerprint and Trust or Replace buttons, which this notice does not have.
 */
const HAS_OWN_ACTION = new Set([
  'verify_host_key',
  'replace_host_key',
  'pick_other_target',
  'new_session',
  'retry',
]);

const FORGETTABLE = new Set(['disconnected', 'unconfirmed', 'stopping']);

/**
 * A session that is no longer running, said truthfully (§5.5, spec §10.4, A36): the cause, that
 * the notebook stays editable, and what can be done. It never calls a disconnect completion and
 * never promises the old process or its files survived. Forget gives up on a session Parallax
 * cannot reach and says plainly that the process may still run.
 */
export function LossNotice({
  session,
  busy,
  onReconnect,
  onForget,
  onChooseAnother,
  onNewSession,
}: Props) {
  const failed = session.state === 'failed';
  const cause = failed ? codeText(session.cause ?? undefined) : causeText(session.cause);
  const open = FORGETTABLE.has(session.state);
  const stage = failed ? CODE_STAGE[session.cause ?? ''] : undefined;
  const recoveries = recoveryText(
    ((failed ? CODE_RECOVERIES : CAUSE_RECOVERIES)[session.cause ?? ''] ?? []).filter(
      (r) => !failed || !HAS_OWN_ACTION.has(r),
    ),
  );
  const canReconnect =
    open &&
    session.state !== 'stopping' &&
    (CAUSE_RECOVERIES[session.cause ?? ''] ?? ['reconnect']).includes('reconnect');
  return (
    <div className={styles.alert} role="alert" data-state={session.state}>
      <p>
        <strong>
          {session.state === 'unconfirmed'
            ? 'Parallax cannot confirm this session.'
            : session.state === 'stopped'
              ? 'This session has stopped.'
              : session.state === 'failed'
                ? 'This session could not start.'
                : session.state === 'stopping'
                  ? 'Stopping this session. The connector has not confirmed that it stopped.'
                  : 'This session is disconnected.'}
        </strong>{' '}
        {session.state === 'stopping'
          ? null
          : stage
            ? `${STAGE_LABEL[stage]} failed. ${cause}`
            : cause}
      </p>
      {open ? (
        <p>
          Your edits to the notebook are kept. Cells cannot run until a session is connected, and
          Parallax does not know whether the process on that computer still runs.
        </p>
      ) : (
        <p>Your edits to the notebook are kept. Cells cannot run until you connect again.</p>
      )}
      {recoveries.length > 0 ? (
        <ul>
          {recoveries.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <div className={styles.row}>
        {canReconnect ? (
          <button type="button" className={buttons.outline} disabled={busy} onClick={onReconnect}>
            Reconnect
          </button>
        ) : null}
        {open ? (
          <button type="button" className={buttons.outline} disabled={busy} onClick={onForget}>
            Forget this session
          </button>
        ) : (
          <>
            <button
              type="button"
              className={buttons.primary}
              disabled={busy}
              onClick={onNewSession}
            >
              Start a new session
            </button>
            <button
              type="button"
              className={buttons.outline}
              disabled={busy}
              onClick={onChooseAnother}
            >
              Choose another target
            </button>
          </>
        )}
      </div>
    </div>
  );
}
