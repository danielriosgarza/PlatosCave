import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ScopedJob } from './scoped';

/**
 * Jobs are auto-discovered like route modules: each `jobs/*.job.ts` default-exports one
 * `defineScopedJob(...)`, so features add files instead of lines in a shared list.
 */
export async function loadJobs(dir = import.meta.dirname): Promise<ScopedJob[]> {
  const files = readdirSync(dir)
    .filter((f) => /\.job\.ts$/.test(f))
    .sort();
  const jobs: ScopedJob[] = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(resolve(dir, file)).href);
    jobs.push(mod.default as ScopedJob);
  }
  return jobs;
}
