import { loadModules } from '../modules';
import type { ScopedJob } from './scoped';

const isScopedJob = (value: unknown): value is ScopedJob => {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<Record<keyof ScopedJob, unknown>>;
  const scope = job.scope as { kind?: unknown } | undefined;
  const input = job.input as { safeParse?: unknown } | undefined;
  return (
    typeof job.name === 'string' &&
    job.name.length > 0 &&
    (scope?.kind === 'class' || scope?.kind === 'course') &&
    typeof input?.safeParse === 'function' &&
    typeof job.run === 'function'
  );
};

/**
 * Jobs are auto-discovered like route modules: each `jobs/*.job.ts` default-exports one
 * `defineScopedJob(...)`. A file that does not is named in the error, so the worker refuses to
 * start instead of failing on the first job.
 */
export async function loadJobs(dir = import.meta.dirname): Promise<ScopedJob[]> {
  return (await loadModules(dir, '.job.ts')).map(({ file, mod }) => {
    if (!isScopedJob(mod.default)) {
      throw new Error(`${file} does not default-export defineScopedJob(...)`);
    }
    return mod.default;
  });
}
