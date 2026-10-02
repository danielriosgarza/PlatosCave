import type { Duplex } from 'node:stream';
import { RUNNER_HARNESS_LOG_BYTES, type RunnerJob, utf8Length } from '@parallax/contracts';
import type Docker from 'dockerode';
import { RunnerFailure } from './failure';
import { stdoutCap } from './frame';
import { errorMessage, type ImageDaemon } from './images';
import { buildStdin, newNonce } from './payload';
import { buildContainerConfig, type ResolvedImage, SANDBOX_LABEL } from './policy';

/** The kill timer fires this long after the job's wall budget (design §5). */
export const KILL_GRACE_SECONDS = 5;
/** After the container has exited, its attach stream gets this long to drain. */
const DRAIN_MS = 5000;

/** What one container run produced, before classification. */
export interface ContainerRun {
  nonce: string;
  exitCode: number | null;
  oomKilled: boolean;
  killedByTimer: boolean;
  durationMs: number;
  /** Container stdout, at most `cap + 1` bytes; longer streams set `stdoutOverflow`. */
  stdout: Buffer;
  stdoutOverflow: boolean;
  /** Tail of the container's stderr, at most 8 KiB of UTF-8. */
  stderrTail: string;
}

export interface Executor {
  run(job: RunnerJob, image: ResolvedImage): Promise<ContainerRun>;
}

/**
 * Splits Docker's multiplexed attach stream (8-byte header: stream type, 3 zero bytes, length
 * big-endian) into a bounded stdout and the tail of stderr. Bytes past the stdout cap are
 * counted and discarded, so a misbehaving harness cannot make the runner buffer without bound.
 */
export class Demux {
  private pending: Buffer = Buffer.alloc(0);
  private stdoutChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private stderr: Buffer = Buffer.alloc(0);
  overflow = false;

  constructor(
    private readonly stdoutLimit: number,
    private readonly stderrLimit = RUNNER_HARNESS_LOG_BYTES,
  ) {}

  push(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      const type = this.pending[0];
      const size = this.pending.readUInt32BE(4);
      if (this.pending.length < 8 + size) return;
      const payload = this.pending.subarray(8, 8 + size);
      this.pending = this.pending.subarray(8 + size);
      if (type === 1) this.keepStdout(payload);
      else if (type === 2) this.keepStderr(payload);
    }
  }

  private keepStdout(payload: Buffer): void {
    const room = this.stdoutLimit + 1 - this.stdoutBytes;
    if (payload.length > room) this.overflow = true;
    if (room <= 0) return;
    const kept = payload.length > room ? payload.subarray(0, room) : payload;
    this.stdoutChunks.push(Buffer.from(kept));
    this.stdoutBytes += kept.length;
  }

  private keepStderr(payload: Buffer): void {
    const joined = Buffer.concat([this.stderr, payload]);
    this.stderr = Buffer.from(joined.subarray(Math.max(0, joined.length - this.stderrLimit)));
  }

  get stdout(): Buffer {
    return Buffer.concat(this.stdoutChunks);
  }

  get stderrTail(): string {
    let text = this.stderr.toString('utf8');
    // A cut through a multi-byte character decodes to U+FFFD, which may be longer than the cut.
    while (utf8Length(text) > this.stderrLimit) text = text.slice(1);
    return text;
  }
}

function dockerStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** dockerode adapter for the image allowlist. */
export function imageDaemon(docker: Docker): ImageDaemon {
  return {
    async inspect(ref) {
      try {
        return await docker.getImage(ref).inspect();
      } catch (error) {
        if (dockerStatus(error) === 404) return null;
        throw error;
      }
    },
    async pull(ref) {
      const stream = await docker.pull(ref);
      await new Promise<void>((resolve, reject) =>
        docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/**
 * Runs one job in one sandbox container (design §2 steps 5 and 7, §7.3): create, attach, start,
 * write the nonce line and the job to stdin and close it, arm the kill timer at
 * `wallSeconds + 5 s`, wait, inspect, remove. Nothing is copied into or mounted from the host.
 */
export class DockerExecutor implements Executor {
  constructor(
    private readonly docker: Docker,
    private readonly dockerRuntime?: string,
  ) {}

  async ping(): Promise<void> {
    await this.daemon(() => this.docker.ping());
  }

  /** Removes sandbox containers a crashed runner left behind (label `parallax.runner=1`). */
  async sweep(): Promise<number> {
    const leftovers = await this.daemon(() =>
      this.docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=1`] } }),
    );
    for (const info of leftovers) {
      await this.docker
        .getContainer(info.Id)
        .remove({ force: true })
        .catch(() => undefined);
    }
    return leftovers.length;
  }

  async run(job: RunnerJob, image: ResolvedImage): Promise<ContainerRun> {
    const nonce = newNonce();
    const stdin = buildStdin(nonce, job);
    const demux = new Demux(stdoutCap(job.limits.outputBytes));

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(
        buildContainerConfig(job, image, this.dockerRuntime),
      );
    } catch (error) {
      if (dockerStatus(error) === 404) {
        throw new RunnerFailure('image_unavailable', `image ${image.ref} is not present`);
      }
      throw new RunnerFailure('daemon_unreachable', `docker create: ${errorMessage(error)}`);
    }

    let timer: NodeJS.Timeout | undefined;
    let killedByTimer = false;
    try {
      const stream = (await this.daemon(() =>
        container.attach({ stream: true, hijack: true, stdin: true, stdout: true, stderr: true }),
      )) as Duplex;
      // A harness that exits early closes the stream under our write; that is not our failure.
      stream.on('error', () => undefined);
      const drained = new Promise<void>((resolve) => {
        stream.once('end', resolve);
        stream.once('close', resolve);
      });
      stream.on('data', (chunk: Buffer) => demux.push(chunk));

      await this.daemon(() => container.start());
      const started = Date.now();
      timer = setTimeout(
        () => {
          killedByTimer = true;
          container.kill({ signal: 'SIGKILL' }).catch(() => undefined);
        },
        (job.limits.wallSeconds + KILL_GRACE_SECONDS) * 1000,
      );
      stream.end(stdin);

      const waited = (await this.daemon(() => container.wait())) as { StatusCode?: number };
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, DRAIN_MS))]);
      stream.destroy();

      const state = (await this.daemon(() => container.inspect())).State;
      return {
        nonce,
        exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : (waited.StatusCode ?? null),
        oomKilled: state.OOMKilled === true,
        killedByTimer,
        durationMs,
        stdout: demux.stdout,
        stdoutOverflow: demux.overflow,
        stderrTail: demux.stderrTail,
      };
    } finally {
      clearTimeout(timer);
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  private async daemon<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new RunnerFailure('daemon_unreachable', `docker: ${errorMessage(error)}`);
    }
  }
}
