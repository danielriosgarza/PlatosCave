import { createHash } from 'node:crypto';
import {
  clampLimits,
  type codeQuestion,
  RunnerJob,
  type RunnerJob as RunnerJobType,
  validateJob,
} from '@parallax/contracts';
import type { z } from 'zod';
import type { RunnerRuntime } from '../config';
import { canonical } from '../db/content/drafts';

/**
 * The job the runner receives and the hashes that name a run (docs/design/runner.md §8.2). Pure,
 * so `job-builder.test.ts` covers it without a database: a `public` job carries no hidden check,
 * no hidden file and no points.
 */

export type CodeQuestion = z.output<typeof codeQuestion>;
export type CheckSet = 'public' | 'full';

/** The student's editable files as stored on the run (`execution_jobs.snapshot`). */
export interface Snapshot {
  files: { path: string; content: string }[];
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Names the student's work only; the editor compares it with its content for the stale label. */
export function codeHash(snapshot: Snapshot): string {
  const files = [...snapshot.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, content: f.content, encoding: 'utf8' }));
  return sha256(canonical(files));
}

/** The image a run of this runtime pins: its digest, or its reference where none exists. */
export const runtimeImage = (runtime: RunnerRuntime) => runtime.digest ?? runtime.image;

/** Everything that decides a run's verdict besides the student's code (§8.2). */
export function graderVersion(question: CodeQuestion, runtime: RunnerRuntime): string {
  return sha256(
    canonical({
      protocol: 1,
      runtimeId: runtime.id,
      image: runtimeImage(runtime),
      harnessVersion: runtime.harnessVersion,
      checks: question.checks,
      files: question.files.filter((f) => !f.editable),
      limits: clampLimits(question.limits),
    }),
  ).slice(0, 16);
}

/** Paths a student may send: the question's editable files (never hidden, by publication). */
export const editablePaths = (question: CodeQuestion) =>
  new Set(question.files.filter((f) => f.editable && !f.hidden).map((f) => f.path));

export type Built = { ok: true; job: RunnerJobType } | { ok: false; message: string };
/** `detail` names the broken rule for authors (publication, preview); students see `message`. */
export type BuiltDetailed =
  | { ok: true; job: RunnerJobType }
  | { ok: false; message: string; detail: string };

/**
 * Overlays the snapshot on the question's files, keeps the checks the set allows without their
 * points, drops hidden files from a `public` job, clamps the limits and validates the result with
 * `RunnerJob` and the semantic rules of §3.1. A snapshot path that is not editable is refused.
 */
export function buildRunnerJob(
  question: CodeQuestion,
  snapshot: Snapshot,
  set: CheckSet,
  jobId: string,
  runtime: RunnerRuntime,
  replayImage?: string,
): Built {
  const built = buildRunnerJobDetailed(question, snapshot, set, jobId, runtime, replayImage);
  return built.ok ? built : { ok: false, message: built.message };
}

/** `buildRunnerJob` that also says which rule a refused job broke. */
export function buildRunnerJobDetailed(
  question: CodeQuestion,
  snapshot: Snapshot,
  set: CheckSet,
  jobId: string,
  runtime: RunnerRuntime,
  replayImage?: string,
): BuiltDetailed {
  const editable = editablePaths(question);
  const sent = new Map<string, string>();
  for (const file of snapshot.files) {
    if (!editable.has(file.path) || sent.has(file.path)) {
      const message = 'Only this question’s editable files can be run';
      return { ok: false, message, detail: message };
    }
    sent.set(file.path, file.content);
  }
  const files = question.files
    .filter((f) => set === 'full' || !f.hidden)
    .map((f) => {
      const content = sent.get(f.path);
      if (content !== undefined) return { path: f.path, content };
      return {
        path: f.path,
        content: f.content,
        ...(f.encoding && { encoding: f.encoding }),
        ...(f.hidden && { hidden: true }),
      };
    });
  const checks = question.checks
    .filter((c) => set === 'full' || c.visibility === 'public')
    .map(({ points: _points, ...check }) => check);
  const candidate = {
    v: 1,
    jobId,
    runtime: {
      id: question.runtime,
      language: runtime.language,
      ...(replayImage !== undefined && { image: replayImage }),
    },
    set,
    limits: clampLimits(question.limits),
    files,
    checks,
  };
  const parsed = RunnerJob.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'This question cannot be run: its definition is not valid',
      detail: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  }
  const verdict = validateJob(parsed.data);
  if (!verdict.ok) {
    return {
      ok: false,
      message:
        verdict.rule === 4
          ? 'The code is too large to run'
          : 'This question cannot be run: its definition is not valid',
      detail: verdict.message,
    };
  }
  return { ok: true, job: parsed.data };
}
