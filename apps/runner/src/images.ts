import type { RunnerJob } from '@parallax/contracts';
import { RunnerFailure } from './failure';
import type { ResolvedImage } from './policy';

/** What the allowlist needs from the Docker daemon. */
export interface ImageDaemon {
  /** `null` when the daemon has no such image. Other errors propagate. */
  inspect(ref: string): Promise<{ Id: string; RepoDigests?: string[] } | null>;
  pull(ref: string): Promise<void>;
}

interface Entry {
  ref: string;
  id: string;
  digests: string[];
}

/**
 * `RUNNER_IMAGES` resolved to image ids and repository digests (design §6.4). A job without
 * `runtime.image` runs on its runtime's first reference; a replay runs only on an image whose
 * allowlisted reference, id or one of whose digests equals the pinned value, otherwise
 * `image_not_allowed`. `image_unavailable` is reserved for an allowlisted reference that cannot
 * be inspected or pulled.
 */
export class ImageAllowlist {
  private readonly resolved = new Map<string, Entry>();

  constructor(
    private readonly images: Record<string, string[]>,
    private readonly daemon: ImageDaemon,
    private readonly pull: 'never' | 'missing',
  ) {}

  /** Inspects every allowlisted reference; a missing one is skipped until a job needs it. */
  async resolveAll(): Promise<void> {
    for (const refs of Object.values(this.images)) {
      for (const ref of refs) await this.inspect(ref, false).catch(() => undefined);
    }
  }

  async resolve(runtime: RunnerJob['runtime']): Promise<ResolvedImage> {
    const refs = this.images[runtime.id];
    if (!refs || refs.length === 0) {
      throw new RunnerFailure('image_not_allowed', `no image is allowlisted for ${runtime.id}`);
    }
    const pinned = runtime.image;
    if (pinned === undefined) return toImage(await this.inspect(refs[0] as string, true));
    // Every reference is inspected afresh, so a tag rebuilt since the last job is matched by
    // its current id only: a replay of the previous build is `image_not_allowed` (§6.4, §9).
    // A daemon that cannot be reached is retried, never mistaken for a refusal.
    for (const ref of refs) {
      await this.inspect(ref, false).catch((error: unknown) => {
        if (!(error instanceof RunnerFailure) || error.kind !== 'image_unavailable') throw error;
      });
    }
    const match = this.match(refs, pinned);
    if (match) return match;
    throw new RunnerFailure('image_not_allowed', `image ${pinned} is not allowlisted`);
  }

  private match(refs: string[], pinned: string): ResolvedImage | null {
    for (const ref of refs) {
      const entry = this.resolved.get(ref);
      if (!entry) continue;
      if (entry.ref === pinned || entry.id === pinned) return toImage(entry);
      if (entry.digests.includes(pinned)) return { ref: entry.ref, id: entry.id, digest: pinned };
    }
    return null;
  }

  private async inspect(ref: string, mayPull: boolean): Promise<Entry> {
    let info = await daemonCall('daemon_unreachable', () => this.daemon.inspect(ref));
    if (!info && mayPull && this.pull === 'missing') {
      await daemonCall('image_unavailable', () => this.daemon.pull(ref));
      info = await daemonCall('daemon_unreachable', () => this.daemon.inspect(ref));
    }
    if (!info) {
      this.resolved.delete(ref);
      throw new RunnerFailure(
        'image_unavailable',
        `image ${ref} is not present on the runner host`,
      );
    }
    const entry = { ref, id: info.Id, digests: info.RepoDigests ?? [] };
    this.resolved.set(ref, entry);
    return entry;
  }
}

/** A daemon error becomes a retried infrastructure failure of the given kind. */
async function daemonCall<T>(
  kind: 'daemon_unreachable' | 'image_unavailable',
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new RunnerFailure(kind, `docker: ${errorMessage(error)}`);
  }
}

function toImage(entry: Entry): ResolvedImage {
  return { ref: entry.ref, id: entry.id, digest: entry.digests[0] ?? null };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
