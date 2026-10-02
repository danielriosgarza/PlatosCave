import { clampLimits, type RunnerJob, type RunnerLimits } from '@parallax/contracts';
import type { ContainerCreateOptions, HostConfig } from 'dockerode';

/** The image a job runs on, as the allowlist resolved it (design §6.4). */
export interface ResolvedImage {
  /** The allowlisted reference (tag or `repo@sha256:…`). */
  ref: string;
  /** Docker image id, `sha256:…`. */
  id: string;
  /** First repository digest, or null where no registry exists (development, CI). */
  digest: string | null;
}

const MiB = 1024 * 1024;
/**
 * Docker mounts a tmpfs root owned by root and not writable by the sandbox user, so the harness
 * (uid 10001) could not create its per-check directories; both roots belong to that user and to
 * no one else.
 */
const TMPFS = 'rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700';

export const SANDBOX_LABEL = 'parallax.runner';
export const JOB_LABEL = 'parallax.job';
export const SANDBOX_PIDS = 64;
export const SANDBOX_FSIZE_BYTES = 32 * MiB;

/**
 * Host policy of a sandbox container (design §7.3). Pure; limits are clamped again here so no
 * caller can ask for more than `RUNNER_BOUNDS`. Byte sizes are multiplied, never shifted:
 * `2048 << 20` overflows a 32-bit integer.
 */
export function buildHostConfig(limits: Partial<RunnerLimits>, dockerRuntime?: string): HostConfig {
  const { memoryMiB } = clampLimits(limits);
  const memoryBytes = memoryMiB * MiB;
  return {
    NetworkMode: 'none',
    ReadonlyRootfs: true,
    Tmpfs: { '/work': TMPFS, '/tmp': TMPFS },
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    PidsLimit: SANDBOX_PIDS,
    NanoCpus: 1e9,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    // The harness is pid 1: it reaps orphans itself, is unreachable by signal from inside the
    // namespace, and is the only (non-dumpable) holder of the container's stdout and stderr.
    // docker-init would expose those through /proc/1/fd as a dumpable same-uid pid 1 (§4.4).
    Init: false,
    IpcMode: 'private',
    Ulimits: [
      { Name: 'core', Soft: 0, Hard: 0 },
      { Name: 'nofile', Soft: 256, Hard: 256 },
      { Name: 'fsize', Soft: SANDBOX_FSIZE_BYTES, Hard: SANDBOX_FSIZE_BYTES },
    ],
    LogConfig: { Type: 'none', Config: {} },
    AutoRemove: false,
    Binds: undefined,
    Mounts: undefined,
    Runtime: dockerRuntime,
  };
}

/**
 * The whole create request for a job's sandbox (design §7.3). The job reaches the container
 * only through the attached stdin; nothing is copied in and nothing is mounted. The image is
 * named by the id the allowlist inspected, so a tag moved after resolution cannot substitute
 * another image for the one the outcome records.
 */
export function buildContainerConfig(
  job: Pick<RunnerJob, 'jobId' | 'limits'>,
  image: ResolvedImage,
  dockerRuntime?: string,
): ContainerCreateOptions {
  return {
    Image: image.id,
    Hostname: 'sandbox',
    User: '10001:10001',
    WorkingDir: '/work',
    Cmd: ['python3', '/opt/parallax/harness/run.py'],
    Env: ['PARALLAX_JOB=1'],
    Labels: { [SANDBOX_LABEL]: '1', [JOB_LABEL]: job.jobId },
    AttachStdin: true,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: buildHostConfig(job.limits, dockerRuntime),
  };
}
