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
  // Rules a runner job cannot express: what students may edit and see, and a sample to run.
  for (const f of q.files) {
    if (f.editable && f.hidden) {
      problems.push(`${at}: ${f.path} is both editable and hidden, so students could not see it`);
    }
  }
  const hasPublic = q.checks.some((c) => c.visibility === 'public');
  if (!hasPublic) problems.push(`${at}: needs at least one public (sample) check`);

  // Everything else (unique check names, files a check names, directory prefixes, sizes) is
  // `validateJob`'s, which the job students and graders would be sent must pass in both sets;
  // the full set holds every check and file, so it is built first.
  if (runtime) {
    for (const set of hasPublic ? (['full', 'public'] as const) : (['full'] as const)) {
      const built = buildRunnerJobDetailed(q, { files: [] }, set, randomUUID(), runtime);
      if (!built.ok) {
        problems.push(`${at}: the checks do not form a valid job: ${built.detail}`);
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
      message: `Question “${q.id}”: every hidden check is a script check. Add a call or stdio hidden check.`,
    },
  ];
}

const rubricIssue = (q: TestQuestion): TestIssue[] => {
  // Points are decimals, so the sum is compared in hundredths, not as floats.
  const hundredths = (n: number) => Math.round(n * 100);
  const total = q.rubric.reduce((sum, c) => sum + hundredths(c.points), 0) / 100;
  return total > hundredths(q.points) / 100
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
