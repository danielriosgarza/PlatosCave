import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadModules } from '../modules';
import { loadJobs } from './registry';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory of module files; job files define their input schema without zod. */
function moduleDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-jobs-'));
  dirs.push(dir);
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  return dir;
}

const job = (name: string, scope = "{ kind: 'class', role: 'instructor' }") => `export default {
  name: '${name}',
  scope: ${scope},
  input: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
  run: async () => ({}),
};`;

describe('loadJobs', () => {
  test('loads every *.job.ts default export in name order, ignoring other files', async () => {
    const dir = moduleDir({
      'b.job.ts': job('b.second'),
      'a.job.ts': job('a.first', "{ kind: 'course', role: 'owner' }"),
      'c.job.ts': job('c.third', "{ kind: 'class', role: 'any', grant: 'manage_members' }"),
      'helper.ts': 'export default 1;',
    });
    expect((await loadJobs(dir)).map((j) => j.name)).toEqual(['a.first', 'b.second', 'c.third']);
  });

  test('names the file whose default export is not a scoped job, and why', async () => {
    const cases: Record<string, [source: string, problem: string]> = {
      'missing.job.ts': ['export const job = 1;', 'no object'],
      'no-name.job.ts': [job(''), 'no name'],
      'no-run.job.ts': [job('x').replace('run: async () => ({}),', ''), 'no run function'],
      'user-scope.job.ts': [job('x', "{ kind: 'user' }"), 'scope is not class or course'],
      'bad-role.job.ts': [job('x', "{ kind: 'class', role: 'teacher' }"), 'invalid scope'],
      'no-role.job.ts': [job('x', "{ kind: 'course' }"), 'invalid scope'],
      'bad-grant.job.ts': [
        job('x', "{ kind: 'class', role: 'any', grant: 'manage' }"),
        'invalid scope',
      ],
      'course-grant.job.ts': [
        job('x', "{ kind: 'course', role: 'owner', grant: 'manage_members' }"),
        'invalid scope',
      ],
      'no-schema.job.ts': [
        job('x').replace(/input: .*\n/, 'input: {},\n'),
        'input is not a schema',
      ],
      'no-parse.job.ts': [job('x').replace('parse: (v) => v, ', ''), 'input is not a schema'],
    };
    for (const [file, [source, problem]] of Object.entries(cases)) {
      const dir = moduleDir({ 'a.job.ts': job('fine'), [file]: source });
      await expect(loadJobs(dir)).rejects.toThrow(
        `${file} does not default-export defineScopedJob(...): ${problem}`,
      );
    }
  });
});

describe('loadModules', () => {
  test('is shared by route and job discovery: suffix match, sorted, with file names', async () => {
    const dir = moduleDir({
      'z.routes.ts': 'export default 2;',
      'a.routes.ts': 'export default 1;',
      'a.routes.test.ts': 'export default 3;',
    });
    const loaded = await loadModules(dir, '.routes.ts');
    expect(loaded.map(({ file, mod }) => [file, mod.default])).toEqual([
      ['a.routes.ts', 1],
      ['z.routes.ts', 2],
    ]);
  });
});
