import { randomUUID } from 'node:crypto';
import { type LinkConfirmation, type LinkStage, validateTarget } from '@parallax/contracts';
import type { ConnectionTestView } from '@parallax/contracts/routes/connections';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { UserScope } from '../auth/scope';
import type { Db } from '../db/client';
import {
  type AcceptedReplacement,
  type OwnedConnection,
  recordHostKeys,
} from '../db/connectors/connections';
import type { LinkAnswer, LinkProgress, LinkRegistry, LinkRequest } from './links';
import { LinkRequestError } from './links';
import { checkTargetPolicy } from './netpolicy';

/**
 * Test connection runs (docs/design/connector.md §2 step 3, §5.1, §5.2, §10.3): held in memory by
 * this relay process (§10.1), owned by the person who started them, and kept 10 minutes after
 * they end. A run lasts at most 300 s (`test_timeout`), which a terminal prompt does not extend:
 * a `running` `ssh_auth` report changes what the poll shows, not the deadline.
 *
 * Host keys are stored only from `data.hops` of a `host_identity` stage, by the rules of §5.2
 * (`recordHostKeys`). The latest `host_key_changed` result per connection and `host:port` is
 * kept, because a replacement must name the key it reported as `expected`.
 */

type Stage = z.infer<typeof LinkStage>;
type Confirmation = z.infer<typeof LinkConfirmation>;
type TestResult = Extract<LinkAnswer, { t: 'test_result' }>;

/** The server's deadline for a whole test (§5.1): above the 285 s the stages can take. */
export const TEST_TIMEOUT_MS = 300_000;
/** How long a run is kept after it ends (§10.3). */
export const TEST_RETENTION_MS = 10 * 60_000;

interface Run {
  testId: string;
  ownerId: string;
  connectionId: string;
  /** The target as sent, which host keys are read against. */
  sent: OwnedConnection['target'];
  replacements: AcceptedReplacement[];
  stages: Stage[];
  /** The `ssh_auth` stage waiting on the connector's terminal, while it waits. */
  waiting: Stage | undefined;
  result: TestResult | undefined;
  code: string | undefined;
  /** When the run ended; it is forgotten `TEST_RETENTION_MS` later. */
  endedAt: Date | undefined;
  /** Host-key writes, in the order the reports arrived. */
  writes: Promise<unknown>;
}

export type StartRefusal =
  | { ok: false; reason: 'connector_offline' }
  | { ok: false; reason: 'replacing_mismatch' }
  | {
      ok: false;
      reason: 'target_not_allowed';
      code: 'invalid_target' | 'network_scope_denied';
      rules?: number[];
    };

const endpointKey = (connectionId: string, host: string, port: number) =>
  `${connectionId} ${host.toLowerCase()}:${port}`;

export class ConnectionTests {
  private readonly runs = new Map<string, Run>();
  /** `data.expected` of the latest `host_key_changed` per connection and `host:port`. */
  private readonly changed = new Map<string, string>();

  constructor(
    private readonly options: {
      db: Db;
      links: LinkRegistry;
      now: () => Date;
      log: FastifyBaseLogger;
    },
  ) {}

  /** Forgets runs that ended more than 10 minutes ago. */
  private sweep(): void {
    const cutoff = this.options.now().getTime() - TEST_RETENTION_MS;
    for (const [id, run] of this.runs) {
      if (run.endedAt && run.endedAt.getTime() <= cutoff) this.runs.delete(id);
    }
  }

  /**
   * Whether every replacing confirmation names the key this connection's latest
   * `host_key_changed` result reported as `expected` for that host and port (§5.2). The route
   * has already required a recent sign-in for them.
   */
  replacementsMatch(connection: OwnedConnection, confirmations: Confirmation[]): boolean {
    return confirmations.every(
      (c) =>
        c.replacing === undefined ||
        this.changed.get(endpointKey(connection.id, c.host, c.port)) === c.replacing,
    );
  }

  /**
   * Sends `test_connection` for one of the caller's connections. The target carries the host
   * keys the connection trusts; the connector's live scope is checked first (§8).
   */
  start(
    scope: UserScope,
    connection: OwnedConnection,
    confirmations: Confirmation[],
  ): { ok: true; testId: string } | StartRefusal {
    this.sweep();
    if (!this.replacementsMatch(connection, confirmations)) {
      return { ok: false, reason: 'replacing_mismatch' };
    }
    const link = this.options.links.get(connection.connectorId);
    if (!link) return { ok: false, reason: 'connector_offline' };
    const target = connection.target;
    const hostKeys = connection.trustedHostKeys.map(({ host, port, sha256 }) => ({
      host,
      port,
      sha256,
    }));
    const message: LinkRequest = {
      v: 1,
      t: 'test_connection',
      requestId: randomUUID(),
      target: target.kind === 'ssh' && hostKeys.length > 0 ? { ...target, hostKeys } : target,
      runtime: connection.runtime,
      ...(confirmations.length > 0 && { confirmations }),
    };
    const issues = validateTarget(message);
    if (issues.length > 0) {
      const rules = [...new Set(issues.map((i) => i.rule))].sort();
      return { ok: false, reason: 'target_not_allowed', code: 'invalid_target', rules };
    }
    const policy = checkTargetPolicy(target, link.hello.networkScope);
    if (!policy.ok) return { ok: false, reason: 'target_not_allowed', code: policy.code };

    const run: Run = {
      testId: randomUUID(),
      ownerId: scope.user.id,
      connectionId: connection.id,
      sent: target,
      replacements: confirmations.flatMap((c) =>
        c.replacing === undefined ? [] : [{ host: c.host, port: c.port, sha256: c.sha256 }],
      ),
      stages: [],
      waiting: undefined,
      result: undefined,
      code: undefined,
      endedAt: undefined,
      writes: Promise.resolve(),
    };
    this.runs.set(run.testId, run);
    link
      .request(message, {
        timeoutMs: TEST_TIMEOUT_MS,
        onProgress: (progress) => this.progress(scope, run, progress),
      })
      .then(
        (answer) => this.answered(scope, run, answer),
        (err: unknown) => {
          const code = err instanceof LinkRequestError ? err.code : 'internal';
          if (!(err instanceof LinkRequestError)) {
            this.options.log.error({ err, testId: run.testId }, 'connection test failed');
          }
          this.end(run, code);
        },
      );
    return { ok: true, testId: run.testId };
  }

  private progress(scope: UserScope, run: Run, { stage }: LinkProgress): void {
    if (run.endedAt) return;
    if (stage.status === 'running') {
      run.waiting = stage;
      return;
    }
    if (stage.name === 'ssh_auth') run.waiting = undefined;
    run.stages.push(stage);
    this.hostIdentity(scope, run, stage);
  }

  private answered(scope: UserScope, run: Run, answer: LinkAnswer): void {
    if (answer.t !== 'test_result') {
      this.end(run, answer.t === 'error' ? answer.code : 'internal');
      return;
    }
    run.result = answer;
    run.stages = answer.stages;
    for (const stage of answer.stages) this.hostIdentity(scope, run, stage);
    this.end(run, undefined);
  }

  private end(run: Run, code: string | undefined): void {
    run.code = code;
    run.waiting = undefined;
    run.endedAt = this.options.now();
  }

  /**
   * Reads one `host_identity` report (§5.2 "Server side"): the hops in `data.hops` go to
   * `recordHostKeys`; a `host_key_changed` is remembered for a later replacement and changes no
   * record.
   */
  private hostIdentity(scope: UserScope, run: Run, stage: Stage): void {
    if (stage.name !== 'host_identity' || run.sent.kind !== 'ssh') return;
    const sent = run.sent;
    const endpoint = (hop: 'jump' | 'target') => (hop === 'target' ? sent : sent.jump);
    const hops = stage.data?.hops ?? [];
    if (stage.code === 'host_key_changed' && stage.data?.hop && stage.data.expected) {
      const e = endpoint(stage.data.hop);
      if (e) this.changed.set(endpointKey(run.connectionId, e.host, e.port), stage.data.expected);
    }
    if (hops.length === 0) return;
    const { db, now, log } = this.options;
    run.writes = run.writes
      .then(() =>
        recordHostKeys(
          db,
          scope,
          run.connectionId,
          { sent, hops, replacements: run.replacements },
          now(),
        ),
      )
      .catch((err) => log.error({ err, testId: run.testId }, 'storing host keys failed'));
  }

  /** Waits for the host-key writes of a run (tests and the poll's consistency). */
  async settled(testId: string): Promise<void> {
    await this.runs.get(testId)?.writes;
  }

  /** The caller's run of this connection, or null (another person's run reads as missing). */
  async view(
    scope: UserScope,
    connectionId: string,
    testId: string,
  ): Promise<ConnectionTestView | null> {
    this.sweep();
    const run = this.runs.get(testId);
    if (!run || run.ownerId !== scope.user.id || run.connectionId !== connectionId) return null;
    // A finished stage's host keys are stored before the poll reports it.
    await run.writes;
    const result = run.result;
    if (!run.endedAt) {
      return {
        testId: run.testId,
        state: 'running',
        stages: run.waiting ? [...run.stages, run.waiting] : [...run.stages],
      };
    }
    if (!result) {
      return {
        testId: run.testId,
        state: 'done',
        stages: run.stages,
        outcome: 'failed',
        code: run.code,
      };
    }
    return {
      testId: run.testId,
      state: 'done',
      stages: result.stages,
      outcome: result.outcome,
      ...(result.kernelspecs && { kernelspecs: result.kernelspecs }),
      ...(result.attachable && { attachable: result.attachable }),
      ...(result.jupyterVersion && { jupyterVersion: result.jupyterVersion }),
      ...(result.environment && { environment: result.environment }),
    };
  }
}
