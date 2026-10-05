import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadJobs } from './registry';

// docs/design/runner.md §8.4: the runner's queues are plain pg-boss queues in pgboss_exec. A
// scoped job carries an actor and runs in schema pgboss, so none may be named `execution.*`.
test('no *.job.ts defines an execution.* job', async () => {
  const jobs = await loadJobs();
  expect(jobs.length).toBeGreaterThan(0);
  expect(jobs.filter((job) => job.name.startsWith('execution.')).map((j) => j.name)).toEqual([]);
  for (const file of readdirSync(import.meta.dirname).filter((f) => f.endsWith('.job.ts'))) {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8');
    expect(source, file).not.toMatch(/['"`]execution\./);
  }
});
