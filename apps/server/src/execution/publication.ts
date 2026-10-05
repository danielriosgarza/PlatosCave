import { randomUUID } from 'node:crypto';
import { mergeSettings, settingsProblems, type TestQuestion, testV1 } from '@parallax/contracts';
import type { RunnerRuntime } from '../config';
import { buildRunnerJobDetailed, type CodeQuestion } from './job-builder';

/**
 * Publication validation of a test (docs/design/runner.md §8.1, spec §12). Pure: the caller
 * passes the head revision's content and the approved runtimes. An error blocks the release; a
 * warning is stored with it.
 */

export interface TestIssue {
  code: 'invalid_test' | 'script_only_hidden_checks';
  message: string;
}
export interface TestIssues {
  errors: TestIssue[];
  warnings: TestIssue[];
}

type Runtimes = readonly RunnerRuntime[];

const normalise = (path: string) =>
  path
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/');

function codeIssues(q: CodeQuestion, runtimes: Runtimes): TestIssue[] {
  const at = `Question “${q.id}”`;
  const problems: string[] = [];
  const runtime = runtimes.find((r) => r.id === q.runtime);
  if (!runtime) problems.push(`${at}: the runtime ${q.runtime} is not offered`);
  else {
    for (const name of q.allowedPackages) {
      if (!runtime.packages.includes(name)) {
        problems.push(`${at}: the package ${name} is not available in ${runtime.id}`);
      }
    }
  }

  const byPath = new Map(q.files.map((f) => [normalise(f.path), f]));
  for (const f of q.files) {
    if (f.editable && f.hidden) {
      problems.push(`${at}: ${f.path} is both editable and hidden, so students could not see it`);
    }
  }
  for (const path of byPath.keys()) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      if (byPath.has(prefix)) {
        problems.push(`${at}: the file path ${prefix} is a directory prefix of ${path}`);
      }
    }
  }

  const names = new Set<string>();
  for (const check of q.checks) {
    if (names.has(check.name)) problems.push(`${at}: the check name ${check.name} is used twice`);
    names.add(check.name);
    for (const path of [check.file, ...(check.files ?? [])]) {
      const file = byPath.get(normalise(path));
      if (!file) {
        problems.push(
          `${at}: the check ${check.name} names ${path}, which is not one of the files`,
        );
      } else if (check.visibility === 'public' && file.hidden) {
        problems.push(`${at}: the public check ${check.name} names the hidden file ${path}`);
      }
    }
  }
  if (!q.checks.some((c) => c.visibility === 'public')) {
    problems.push(`${at}: needs at least one public (sample) check`);
  }

  // Whatever the rules above did not name: the job students and graders would be sent must be
  // valid in both sets, so a broken hidden check is found here and not at the first submission.
  if (problems.length === 0 && runtime) {
    for (const set of ['public', 'full'] as const) {
      const built = buildRunnerJobDetailed(q, { files: [] }, set, randomUUID(), runtime);
      if (!built.ok) {
        problems.push(
          `${at}: the ${set === 'full' ? 'hidden and sample checks' : 'sample checks'} do not form a valid job (${built.detail})`,
        );
        break;
      }
    }
  }
  return problems.map((message) => ({ code: 'invalid_test', message }));
}

function scriptOnlyHidden(q: CodeQuestion): TestIssue[] {
  const hidden = q.checks.filter((c) => c.visibility === 'hidden');
  if (hidden.length === 0 || !hidden.every((c) => c.kind === 'script')) return [];
  return [
    {
      code: 'script_only_hidden_checks',
      message: `Question “${q.id}”: every hidden check is a script check. A script check’s verdict is decided inside the student’s own process, so the question has no hidden check a student cannot influence. Add a call or stdio hidden check.`,
    },
  ];
}

const rubricIssue = (q: TestQuestion): TestIssue[] => {
  const total = q.rubric.reduce((sum, c) => sum + c.points, 0);
  return total > q.points
    ? [
        {
          code: 'invalid_test',
          message: `Question “${q.id}”: the rubric criteria add up to ${total}, more than the question’s ${q.points} points`,
        },
      ]
    : [];
};

/** Everything that blocks or qualifies publishing this test content. */
export function testPublicationIssues(content: unknown, runtimes: Runtimes): TestIssues {
  const parsed = testV1.safeParse(content);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.slice(0, 10).map((i) => ({
        code: 'invalid_test',
        message: `${i.path.join('.') || 'test'}: ${i.message}`,
      })),
      warnings: [],
    };
  }
  const test = parsed.data;
  const errors: TestIssue[] = settingsProblems(mergeSettings(test.settings)).map((message) => ({
    code: 'invalid_test',
    message: `Settings: ${message}`,
  }));
  const warnings: TestIssue[] = [];
  for (const q of test.questions) {
    errors.push(...rubricIssue(q));
    if (q.kind === 'code') {
      errors.push(...codeIssues(q, runtimes));
      warnings.push(...scriptOnlyHidden(q));
    }
  }
  return { errors, warnings };
}
