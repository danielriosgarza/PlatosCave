import { z } from 'zod';

const RuntimeImages = z.record(
  z.string().regex(/^(python|r)-[0-9]+\.[0-9]+$/, 'a runtime id such as python-3.12'),
  z.array(z.string().min(1)).min(1),
);

/** `RUNNER_IMAGES` is JSON: a runtime id mapped to the image references it may run, newest first. */
const ImagesJson = z.string().transform((raw, ctx) => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'RUNNER_IMAGES is not JSON' });
    return z.NEVER;
  }
  const parsed = RuntimeImages.safeParse(value);
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: `RUNNER_IMAGES: ${parsed.error.message}` });
    return z.NEVER;
  }
  return parsed.data;
});

/**
 * Everything the runner reads from its environment (docs/design/runner.md §7.1) and nothing
 * else: no session, storage, mail or content secret and no application `DATABASE_URL`.
 */
export const RunnerEnv = z.object({
  /** Connection as role `parallax_runner`, privileged in schema `pgboss_exec` only (§10.3). */
  RUNNER_DATABASE_URL: z.string().min(1),
  /** Concurrent containers; one pg-boss `work()` registration each. */
  RUNNER_SLOTS: z.coerce.number().int().min(1).max(32).default(4),
  RUNNER_IMAGES: ImagesJson,
  /** `never` (production): a missing image is `image_unavailable`; `missing` pulls or uses a local tag. */
  RUNNER_PULL: z.enum(['never', 'missing']).default('never'),
  /** OCI runtime for sandbox containers, `runsc` in production. */
  RUNNER_DOCKER_RUNTIME: z.string().min(1).optional(),
  /** dockerode's default socket when unset. */
  DOCKER_HOST: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type RunnerConfig = z.infer<typeof RunnerEnv>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = RunnerEnv.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid runner configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
