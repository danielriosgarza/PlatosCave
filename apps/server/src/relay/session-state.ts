/**
 * The server's view of a notebook session (docs/design/connector.md §10.7) as a pure function:
 * every change of `notebook_sessions.state` is computed here, so the table in the design and the
 * table test in session-state.test.ts are the same thing. The server never decides that a process
 * stopped: only the connector's word (`stopped`) or the person's Forget (`abandoned`, which says
 * nothing about the process) ends a session.
 */

export const SESSION_STATES = [
  'starting',
  'ready',
  'disconnected',
  'unconfirmed',
  'stopping',
  'stopped',
  'failed',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** States a session can still leave; at most one such session per person and notebook. */
export const OPEN_STATES = [
  'starting',
  'ready',
  'disconnected',
  'unconfirmed',
  'stopping',
] as const satisfies readonly SessionState[];
export type OpenState = (typeof OPEN_STATES)[number];

export const isOpen = (state: SessionState): state is OpenState =>
  (OPEN_STATES as readonly string[]).includes(state);

/** What the connector reports in `session_state` or a heartbeat entry. */
export type ReportedState =
  | 'starting'
  | 'ready'
  | 'disconnected'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type SessionEvent =
  /** `session_state` from the connector, or a heartbeat entry for the session. */
  | { t: 'reported'; state: ReportedState; cause?: string | undefined; code?: string | undefined }
  /** 45 s without a heartbeat, or the link closed. */
  | { t: 'link_lost' }
  /** `close { stop: true }` was accepted and `close_session` sent. */
  | { t: 'stop_sent' }
  /**
   * The connector answered `close_session` with an error, or 30 s passed without `stopped`: the
   * session returns to the state it had before the stop.
   */
  | { t: 'stop_failed'; previous: { state: SessionState; cause: string | null } }
  /** The connector answered `open_session` with an error (`limit_exceeded`, …). */
  | { t: 'open_refused'; code: string }
  /** 300 s passed and the session is still `starting` (§5.1); never extended. */
  | { t: 'start_timeout' }
  /** The first heartbeat after `hello` does not list the session. */
  | { t: 'missing_after_hello' }
  /** The person gave up on a session that cannot be reached. */
  | { t: 'forget' }
  /** The connector was revoked or unpaired. */
  | { t: 'revoked' }
  /** This relay process started; nothing it held in memory survived. */
  | { t: 'relay_start' };

export interface SessionStatus {
  state: SessionState;
  cause: string | null;
}

const to = (state: SessionState, cause: string | null = null): SessionStatus => ({ state, cause });

/**
 * The state `event` moves a session in `current` to, or null when the event does not apply to
 * that state (the session is left as it is).
 */
export function nextSessionState(
  current: SessionStatus,
  event: SessionEvent,
): SessionStatus | null {
  const { state } = current;
  switch (event.t) {
    case 'reported':
      return reported(current, event);
    case 'link_lost':
      return state === 'starting' ||
        state === 'ready' ||
        state === 'disconnected' ||
        state === 'stopping'
        ? to('unconfirmed', 'link_lost')
        : null;
    case 'stop_sent':
      return isOpen(state) ? to('stopping') : null;
    case 'stop_failed':
      return state === 'stopping' &&
        isOpen(event.previous.state) &&
        event.previous.state !== 'stopping'
        ? to(event.previous.state, event.previous.cause)
        : null;
    case 'open_refused':
      return state === 'starting' ? to('failed', event.code) : null;
    case 'start_timeout':
      return state === 'starting' ? to('failed', 'test_timeout') : null;
    case 'missing_after_hello':
      return state === 'unconfirmed' ? to('stopped', 'connector_restarted') : null;
    case 'forget':
      return state === 'disconnected' || state === 'unconfirmed' || state === 'stopping'
        ? to('stopped', 'abandoned')
        : null;
    case 'revoked':
      return isOpen(state) ? to('unconfirmed', 'connector_revoked') : null;
    case 'relay_start':
      return state === 'starting' ||
        state === 'ready' ||
        state === 'disconnected' ||
        state === 'stopping'
        ? to('unconfirmed', 'link_lost')
        : null;
  }
}

function reported(
  current: SessionStatus,
  event: Extract<SessionEvent, { t: 'reported' }>,
): SessionStatus | null {
  const { state } = current;
  switch (event.state) {
    case 'ready':
      return state === 'starting' || state === 'disconnected' || state === 'unconfirmed'
        ? to('ready')
        : null;
    case 'disconnected':
      // The connector's own cause; a disconnected session may report a newer one.
      return state === 'ready' || state === 'unconfirmed' || state === 'disconnected'
        ? to('disconnected', event.cause ?? null)
        : null;
    case 'failed':
      return state === 'starting' ? to('failed', event.code ?? event.cause ?? 'internal') : null;
    case 'stopped':
      return isOpen(state) ? to('stopped', event.cause ?? null) : null;
    // `starting` and `stopping` from the connector confirm what the server already shows.
    case 'starting':
    case 'stopping':
      return null;
  }
}
