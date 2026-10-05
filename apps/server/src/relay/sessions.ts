import { randomUUID } from 'node:crypto';
import { type LinkRuntime, validateTarget } from '@parallax/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { ClassScope } from '../auth/scope';
import type { Db } from '../db/client';
import type { SessionConnection } from '../db/connectors/connections';
import {
  type Applied,
  applyConnectorEvent,
  applyOwnEvent,
  connectorSessions,
  markLinkLost,
  markRelayStart,
  type OwnedSession,
  openSession,
  recordHeartbeat,
  type SessionReport,
} from '../db/notebooks/sessions';
import type {
  Link,
  LinkAnswer,
  LinkHeartbeat,
  LinkNotice,
  LinkRegistry,
  LinkRequest,
  LinkTimers,
  LiveLinkRegistry,
} from './links';
import { LinkRequestError } from './links';
import { checkTargetPolicy } from './netpolicy';
import { isOpen, type SessionEvent, type SessionState, type SessionStatus } from './session-state';

/**
 * Notebook sessions on the relay (docs/design/connector.md §2, §9, §10.4, §10.7). It sends
 * `open_session` and `close_session`, applies what connectors report (answers, `session_state`
 * notices, heartbeats), and keeps the deadlines: 300 s for a session to leave `starting` (never
 * extended), 30 s for a stop to be confirmed. It never stops a session itself: a session ends on
 * the connector's word or the person's Forget.
 *
 * After a link goes live nothing is concluded about a session before the first heartbeat after
 * `hello` was processed: that heartbeat lists every session the connector holds, stopped ones
 * with their cause (§9), so a session missing from it is `connector_restarted` and an owned one
 * the server has as `stopped` or `failed` is cleaned up with `close_session { stop: true }`.
 */

/** §5.1: the server's deadline for a session to leave `starting`; never extended. */
export const START_TIMEOUT_MS = 300_000;
/** §10.7: a stop not confirmed within this time returns to the state before it. */
export const STOP_TIMEOUT_MS = 30_000;
/** §9 defaults. */
export const DEFAULT_LEASE = { idleTimeoutMin: 30, gracePeriodMin: 5 };

export type OpenResult =
  | { ok: true; sessionId: string; state: 'starting' }
  | { ok: false; reason: 'not_found' | 'class_archived' | 'connector_offline' | 'wrong_class' }
  | { ok: false; reason: 'session_exists'; sessionId: string }
  | {
      ok: false;
      reason: 'target_not_allowed';
      code: 'invalid_target' | 'network_scope_denied';
      rules?: number[];
    };

export type CloseResult =
  | { ok: true; session: OwnedSession }
  | { ok: false; reason: 'not_owned' | 'connector_offline' | 'not_open' };

interface PendingStop {
  previous: SessionStatus;
  cancel: () => void;
}

/** The session relay following each live registry, so tests can wait for it to settle. */
export const sessionRelays = new WeakMap<LinkRegistry, SessionRelay>();

export class SessionRelay {
  /** Live links whose first heartbeat after `hello` has not been processed yet. */
  private readonly awaitingFirstHeartbeat = new Set<Link>();
  private readonly stops = new Map<string, PendingStop>();
  private readonly starts = new Map<string, () => void>();
  /** Sessions a browser is attached to (§9), by session id, with their connector. */
  private readonly attached = new Map<string, string>();
  /** Sessions a clean-up `close_session` was sent for and not yet answered. */
  private readonly cleaning = new Set<string>();
  /** Per-connector chains, so one connector's reports are applied in the order they came. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Connector messages naming a session that is not on that connector's own list (§10.4). */
  unmatchedMessages = 0;
  /** Listeners told the id of every session whose state or cause changed (the browser channel). */
  private readonly changeListeners = new Set<(sessionId: string) => void>();

  constructor(
    private readonly options: {
      db: Db;
      links: LinkRegistry;
      timers: LinkTimers;
      now: () => Date;
      log: FastifyBaseLogger;
    },
  ) {}

  /**
   * Done once the sessions that were open when this process started are marked unconfirmed.
   * Every report and every request waits for it. A failure (no database yet, as when the e2e
   * server starts before its database is created) is logged, not fatal to the process.
   */
  private started: Promise<void> = Promise.resolve();

  /**
   * Marks sessions that were open when this process started as unconfirmed and follows the
   * links. Returns the unsubscribe.
   */
  start(registry: LiveLinkRegistry): () => void {
    this.started = markRelayStart(this.options.db, this.options.now()).then(
      () => undefined,
      (err) => this.options.log.error({ err }, 'marking sessions unconfirmed at start failed'),
    );
    sessionRelays.set(registry, this);
    return registry.on({
      open: (link) => {
        this.awaitingFirstHeartbeat.add(link);
        this.resendPresence(link);
      },
      close: (link) => {
        this.awaitingFirstHeartbeat.delete(link);
        this.serial(link.connectorId, async () => {
          const lost = await markLinkLost(this.options.db, link.connectorId, this.options.now());
          for (const id of lost) this.changed(id);
        });
      },
      notice: (link, message) => this.serial(link.connectorId, () => this.notice(link, message)),
    });
  }

  /** Subscribes to session changes; returns the unsubscribe. */
  onChange(listener: (sessionId: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(sessionId: string): void {
    for (const listener of this.changeListeners) {
      try {
        listener(sessionId);
      } catch (err) {
        this.options.log.error({ err, sessionId }, 'session change listener failed');
      }
    }
  }

  /** Waits until everything already received for `connectorId` has been applied (tests). */
  async settled(connectorId: string): Promise<void> {
    await this.started;
    await this.chains.get(connectorId);
  }

  private serial(connectorId: string, task: () => Promise<void>): void {
    const next = (this.chains.get(connectorId) ?? this.started)
      .then(task)
      .catch((err) => this.options.log.error({ err, connectorId }, 'session update failed'));
    this.chains.set(connectorId, next);
    void next.then(() => {
      if (this.chains.get(connectorId) === next) this.chains.delete(connectorId);
    });
  }

  private get now() {
    return this.options.now();
  }

  /** Applies a connector-side event; logs and counts one that names a foreign session. */
  private async apply(
    connectorId: string,
    sessionId: string,
    event: SessionEvent,
    report?: SessionReport,
  ): Promise<Applied | null> {
    const applied = await applyConnectorEvent(
      this.options.db,
      connectorId,
      sessionId,
      event,
      this.now,
      report,
    );
    if (!applied) {
      this.unmatchedMessages++;
      this.options.log.warn(
        { connectorId, relay_unmatched_messages: this.unmatchedMessages },
        'connector message names a session that is not its own',
      );
      return null;
    }
    this.settle(sessionId, applied.session.state);
    if (applied.changed) this.changed(sessionId);
    return applied;
  }

  /**
   * Tells the connector whether a browser is attached to an open session (§9); the browser
   * channel (P3-06a) calls this. The relay remembers it, because a connector whose link drops
   * counts its sessions as detached until it hears `presence` again.
   */
  presence(session: OwnedSession, attached: boolean): void {
    if (attached && isOpen(session.state)) this.attached.set(session.id, session.connectorId);
    else this.attached.delete(session.id);
    this.options.links
      .get(session.connectorId)
      ?.send({ v: 1, t: 'presence', sessionId: session.id, attached });
  }

  /**
   * A returning link gets `presence { attached: true }` again for every session whose browser
   * is still attached, so the connector does not stop it when its grace period ends (§9).
   */
  private resendPresence(link: Link): void {
    for (const [sessionId, connectorId] of this.attached) {
      if (connectorId === link.connectorId) {
        link.send({ v: 1, t: 'presence', sessionId, attached: true });
      }
    }
  }

  /** Clears the deadlines a session in `state` no longer has. */
  private settle(sessionId: string, state: SessionState): void {
    if (!isOpen(state)) this.attached.delete(sessionId);
    if (state !== 'starting') {
      this.starts.get(sessionId)?.();
      this.starts.delete(sessionId);
    }
    if (state !== 'stopping') {
      this.stops.get(sessionId)?.cancel();
      this.stops.delete(sessionId);
    }
  }

  /**
   * Connect (§2, step 4): inserts the `starting` row and sends `open_session` with the lease.
   * The connection is the caller's (`connectionForSession`); the connector must hold a live link
   * and its reported scope must still cover the target (§8).
   */
  async open(
    scope: ClassScope,
    found: SessionConnection,
    input: {
      revisionId: string;
      runtime?: LinkRuntime | undefined;
      lease?: { idleTimeoutMin: number; gracePeriodMin: number } | undefined;
    },
  ): Promise<OpenResult> {
    await this.started;
    const { connection } = found;
    if (found.templateClassId !== null && found.templateClassId !== scope.classId) {
      return { ok: false, reason: 'wrong_class' };
    }
    const link = this.options.links.get(connection.connectorId);
    if (!link || found.connector.status !== 'active') {
      return { ok: false, reason: 'connector_offline' };
    }
    const runtime = input.runtime ?? connection.runtime;
    const lease = input.lease ?? DEFAULT_LEASE;
    const target = connection.target;
    const hostKeys = connection.trustedHostKeys.map(({ host, port, sha256 }) => ({
      host,
      port,
      sha256,
    }));
    const sent = target.kind === 'ssh' && hostKeys.length > 0 ? { ...target, hostKeys } : target;
    const issues = validateTarget({ target: sent, runtime });
    if (issues.length > 0) {
      const rules = [...new Set(issues.map((i) => i.rule))].sort();
      return { ok: false, reason: 'target_not_allowed', code: 'invalid_target', rules };
    }
    const policy = checkTargetPolicy(target, link.hello.networkScope);
    if (!policy.ok) return { ok: false, reason: 'target_not_allowed', code: policy.code };

    const opened = await openSession(
      this.options.db,
      scope,
      {
        connection,
        revisionId: input.revisionId,
        runtime: {
          mode: runtime.mode,
          ...(runtime.kernelName && { kernelName: runtime.kernelName }),
        },
        lease,
      },
      this.now,
    );
    if (!opened.ok) return opened;
    const session = opened.session;
    const connectorId = connection.connectorId;
    this.starts.set(
      session.id,
      this.options.timers.after(START_TIMEOUT_MS, () => {
        this.starts.delete(session.id);
        this.serial(connectorId, async () => {
          await this.apply(connectorId, session.id, { t: 'start_timeout' });
        });
      }),
    );
    const message: LinkRequest = {
      v: 1,
      t: 'open_session',
      requestId: randomUUID(),
      sessionId: session.id,
      target: sent,
      runtime,
      lease,
    };
    this.request(link, session.id, message, START_TIMEOUT_MS, (answer) =>
      answer.t === 'error'
        ? { t: 'open_refused', code: answer.code }
        : answer.t === 'session_state'
          ? undefined
          : { t: 'open_refused', code: 'internal' },
    );
    return { ok: true, sessionId: session.id, state: 'starting' };
  }

  /**
   * Sends a request about one session and applies its answer in the connector's order: a
   * `session_state` as a report, an error as the event `onRefused` gives. A link that closes
   * first is handled by the link's close (sessions become `unconfirmed`).
   */
  private request(
    link: Link,
    sessionId: string,
    message: LinkRequest,
    timeoutMs: number,
    onAnswer: (answer: LinkAnswer) => SessionEvent | undefined,
    onTimeout?: () => SessionEvent | undefined,
  ): void {
    const connectorId = link.connectorId;
    link.request(message, { timeoutMs }).then(
      (answer) =>
        this.serial(connectorId, async () => {
          if (answer.t === 'session_state') {
            await this.report(link, answer);
            return;
          }
          const event = onAnswer(answer);
          if (event) await this.apply(connectorId, sessionId, event);
        }),
      (err: unknown) =>
        this.serial(connectorId, async () => {
          if (!(err instanceof LinkRequestError)) {
            this.options.log.error({ err, sessionId }, 'session request failed');
            return;
          }
          if (err.code === 'connector_offline') return;
          const event =
            err.code === 'test_timeout' ? onTimeout?.() : onAnswer(errorAnswer(err.code));
          if (event) await this.apply(connectorId, sessionId, event);
        }),
    );
  }

  /**
   * Disconnect (`stop: false`) or Stop (`stop: true`), §2 steps 8 and 10. An attached session
   * cannot be stopped (A32); a stop moves the session to `stopping` until the connector confirms
   * `stopped`, and returns to the state before it when the connector refuses or 30 s pass.
   */
  async close(scope: ClassScope, session: OwnedSession, stop: boolean): Promise<CloseResult> {
    if (!isOpen(session.state)) return { ok: false, reason: 'not_open' };
    const link = this.options.links.get(session.connectorId);
    if (!link) return { ok: false, reason: 'connector_offline' };
    if (stop && !session.owned) return { ok: false, reason: 'not_owned' };
    const message: LinkRequest = {
      v: 1,
      t: 'close_session',
      requestId: randomUUID(),
      sessionId: session.id,
      stop,
    };
    if (!stop) {
      this.request(link, session.id, message, STOP_TIMEOUT_MS, () => undefined);
      return { ok: true, session };
    }
    const previous = this.stops.get(session.id)?.previous ?? {
      state: session.state,
      cause: session.cause,
    };
    const applied = await applyOwnEvent(
      this.options.db,
      scope,
      session.id,
      { t: 'stop_sent' },
      this.now,
    );
    if (applied?.session.state !== 'stopping') return { ok: false, reason: 'not_open' };
    if (applied.changed) this.changed(session.id);
    const connectorId = session.connectorId;
    const failed: SessionEvent = { t: 'stop_failed', previous };
    this.stops.get(session.id)?.cancel();
    this.stops.set(session.id, {
      previous,
      cancel: this.options.timers.after(STOP_TIMEOUT_MS, () => {
        this.stops.delete(session.id);
        this.serial(connectorId, async () => {
          await this.apply(connectorId, session.id, failed);
        });
      }),
    });
    this.request(
      link,
      session.id,
      message,
      STOP_TIMEOUT_MS,
      (answer) => (answer.t === 'error' ? failed : undefined),
      () => failed,
    );
    return { ok: true, session: applied.session as OwnedSession };
  }

  /**
   * Forget (A36): gives up on a session that cannot be reached. Nothing is sent to the
   * connector; the session is `stopped` with cause `abandoned`.
   */
  async forget(scope: ClassScope, session: OwnedSession): Promise<OwnedSession | null> {
    const applied = await applyOwnEvent(
      this.options.db,
      scope,
      session.id,
      { t: 'forget' },
      this.now,
    );
    if (!applied?.changed) return null;
    this.settle(session.id, applied.session.state);
    this.changed(session.id);
    return applied.session as OwnedSession;
  }

  private async notice(link: Link, message: LinkNotice): Promise<void> {
    if (message.t === 'heartbeat') {
      const first = this.awaitingFirstHeartbeat.delete(link);
      await this.heartbeat(link, message, first);
      return;
    }
    if (message.t === 'session_state') {
      await this.report(link, message);
      return;
    }
    if (message.sessionId) {
      this.options.log.info(
        { connectorId: link.connectorId, sessionId: message.sessionId, code: message.code },
        'connector reported an error about a session',
      );
    }
  }

  /** One `session_state` from a connector, answer or notice. */
  private async report(
    link: Link,
    message: Extract<LinkNotice, { t: 'session_state' }>,
  ): Promise<void> {
    const applied = await this.apply(
      link.connectorId,
      message.sessionId,
      {
        t: 'reported',
        state: message.state,
        cause: message.cause,
        code: message.code,
      },
      {
        owned: message.owned,
        jupyterVersion: message.jupyterVersion,
        kernelspecs: message.kernelspecs,
        environment: message.environment,
        contentRoot: message.contentRoot,
        leaseExpiresAt: message.leaseExpiresAt,
      },
    );
    if (message.state === 'stopped') this.cleaning.delete(message.sessionId);
    // A late `ready` (or any live state) for a session the server closed: clean up the leak,
    // but only once the first heartbeat after `hello` has been processed.
    if (
      applied &&
      !isOpen(applied.session.state) &&
      message.owned &&
      message.state !== 'stopped' &&
      message.state !== 'failed' &&
      !this.awaitingFirstHeartbeat.has(link)
    ) {
      this.cleanUp(link, message.sessionId);
    }
  }

  /**
   * A heartbeat (§9 "Server view", §10.7). The first after `hello` reconciles: an unconfirmed
   * session it does not list was lost by a restarted connector; a listed session takes the
   * listed state and cause. Every heartbeat records the evidence and cleans up owned sessions
   * the server has as `stopped` or `failed` that the connector still holds.
   */
  private async heartbeat(link: Link, message: LinkHeartbeat, first: boolean): Promise<void> {
    const { db } = this.options;
    const connectorId = link.connectorId;
    const listed = new Map(message.sessions.map((s) => [s.sessionId, s]));
    const rows = await connectorSessions(db, connectorId, [...listed.keys()]);
    const known = new Set(rows.map((r) => r.id));
    for (const id of listed.keys()) {
      if (!known.has(id)) {
        this.unmatchedMessages++;
        this.options.log.warn(
          { connectorId, relay_unmatched_messages: this.unmatchedMessages },
          'heartbeat lists a session that is not this connector’s',
        );
      }
    }
    for (const row of rows) {
      const entry = listed.get(row.id);
      if (!entry) {
        if (first && row.state === 'unconfirmed') {
          await this.apply(connectorId, row.id, { t: 'missing_after_hello' });
        }
        continue;
      }
      if (isOpen(row.state)) {
        await this.apply(connectorId, row.id, {
          t: 'reported',
          state: entry.state,
          cause: entry.cause,
        });
      } else if (row.owned && entry.state !== 'stopped' && entry.state !== 'failed') {
        this.cleanUp(link, row.id);
      }
    }
    await recordHeartbeat(
      db,
      connectorId,
      message.sessions.map((s) => ({ sessionId: s.sessionId, leaseExpiresAt: s.leaseExpiresAt })),
      this.now,
    );
  }

  /** Sends `close_session { stop: true }` for a session the server already closed (§10.7). */
  private cleanUp(link: Link, sessionId: string): void {
    if (this.cleaning.has(sessionId)) return;
    this.cleaning.add(sessionId);
    this.options.log.info(
      { connectorId: link.connectorId, sessionId },
      'stopping a leaked session',
    );
    link
      .request(
        { v: 1, t: 'close_session', requestId: randomUUID(), sessionId, stop: true },
        { timeoutMs: STOP_TIMEOUT_MS },
      )
      .then(
        (answer) => {
          this.cleaning.delete(sessionId);
          if (answer.t === 'session_state') {
            this.serial(link.connectorId, () => this.report(link, answer));
          }
        },
        () => this.cleaning.delete(sessionId),
      );
  }
}

const errorAnswer = (code: string): LinkAnswer => ({ v: 1, t: 'error', code });
