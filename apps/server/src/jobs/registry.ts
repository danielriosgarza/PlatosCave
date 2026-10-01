import { Scope } from '@parallax/contracts';
import { loadModules } from '../modules';
import type { ScopedJob } from './scoped';

/** Why a default export is not a scoped job, or null when it is one. */
const scopedJobProblem = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) return 'no object';
  const job = value as Partial<Record<keyof ScopedJob, unknown>>;
  if (typeof job.name !== 'string' || job.name.length === 0) return 'no name';
  // The same rule as a route contract's scope (ADR-0002), and jobs act on a class or course only.
  const scope = Scope.safeParse(job.scope);
  if (!scope.success) return 'invalid scope';
  if (scope.data.kind !== 'class' && scope.data.kind !== 'course') {
    return 'scope is not class or course';
  }
  const input = job.input as { parse?: unknown; safeParse?: unknown } | undefined;
  if (typeof input?.parse !== 'function' || typeof input.safeParse !== 'function') {
    return 'input is not a schema';
  }
  if (typeof job.run !== 'function') return 'no run function';
  return null;
};

/**
 * Jobs are auto-discovered like route modules: each `jobs/*.job.ts` default-exports one
 * `defineScopedJob(...)`. A file that does not is named in the error, so the worker refuses to
 * start instead of failing on every run of the job.
 */
export async function loadJobs(dir = import.meta.dirname): Promise<ScopedJob[]> {
  return (await loadModules(dir, '.job.ts')).map(({ file, mod }) => {
    const problem = scopedJobProblem(mod.default);
    if (problem) {
      throw new Error(`${file} does not default-export defineScopedJob(...): ${problem}`);
    }
    return mod.default as ScopedJob;
  });
}
