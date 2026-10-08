import { z } from 'zod';

/**
 * Runner protocol v1: the zod mirror of `runner/protocol/v1/job.schema.json` and
 * `result.schema.json`, the outcome the runner reports, the limit bounds and the semantic rules
 * of a job (docs/design/runner.md §3, §5). Used by the server before it enqueues a job and by
 * `apps/runner` before it starts a container; `runner.test.ts` holds both to the fixtures under
 * `runner/protocol/v1/examples/`.
 */

const KiB = 1024;
const MiB = 1024 * KiB;

/** Server-enforced bounds (§5); `clampLimits` applies them on both sides. */
export const RUNNER_BOUNDS = {
  wallSeconds: { default: 10, min: 1, max: 60 },
  memoryMiB: { default: 512, min: 64, max: 2048 },
  outputBytes: { default: 1 * MiB, min: 4 * KiB, max: 4 * MiB },
} as const;

/**
 * On SIGTERM the runner waits this long for running containers: the longest wall limit + 10 s
 * (design §7.2). `infra/compose.prod.yml` gives the runner a stop grace period longer than this.
 */
export const RUNNER_STOP_DRAIN_SECONDS = RUNNER_BOUNDS.wallSeconds.max + 10;

/** Fixed sizes of §3.1 and §5, not overridable by a course or a question. */
export const RUNNER_MAX_FILES = 64;
export const RUNNER_MAX_FILE_BYTES = 2 * MiB;
export const RUNNER_MAX_JOB_BYTES = 4 * MiB;
export const RUNNER_MAX_CHECKS = 50;
const MAX_TEXT = 256 * KiB;

export type RunnerLimitName = keyof typeof RUNNER_BOUNDS;
export type RunnerLimits = Record<RunnerLimitName, number>;

/** Fills missing limits with their defaults and pulls every limit into its bounds (integers). */
export function clampLimits(limits: Partial<Record<RunnerLimitName, number>> = {}): RunnerLimits {
  const clamp = (name: RunnerLimitName): number => {
    const bound = RUNNER_BOUNDS[name];
    const value = limits[name];
    if (value === undefined || !Number.isFinite(value)) return bound.default;
    return Math.min(bound.max, Math.max(bound.min, Math.floor(value)));
  };
  return {
    wallSeconds: clamp('wallSeconds'),
    memoryMiB: clamp('memoryMiB'),
    outputBytes: clamp('outputBytes'),
  };
}

/** JSON Schema's `maxLength` counts code points; `z.string().max` counts UTF-16 units. */
const chars = (max: number) =>
  z.string().refine((s) => s.length <= max || [...s].length <= max, {
    message: `at most ${max} characters`,
  });

export const RunnerRuntimeId = z.string().regex(/^(python|r)-[0-9]+\.[0-9]+$/);
const Language = z.enum(['python', 'r']);
const ImageRef = z
  .string()
  .regex(
    /^(sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9._-]*(:[0-9]+)?(\/[a-z0-9][a-z0-9._-]*)*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64})$/,
  );
export const RunnerPath = chars(200).regex(
  /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/,
);
const CheckName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/);
const Int = (min: number, max: number) => z.number().int().min(min).max(max);
const Tolerance = z.number().min(0);
const ProgramArgs = z.array(chars(1024)).max(32);

const RunnerFile = z.strictObject({
  path: RunnerPath,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional(),
  hidden: z.boolean().optional(),
});

const checkBase = {
  name: CheckName,
  visibility: z.enum(['public', 'hidden']),
  timeoutSeconds: Int(1, 60).optional(),
  files: z.array(RunnerPath).max(16).optional(),
  file: RunnerPath,
  stdin: chars(MAX_TEXT).optional(),
};

const StdioCheck = z.strictObject({
  ...checkBase,
  kind: z.literal('stdio'),
  args: ProgramArgs.optional(),
  expected: z.strictObject({ stdout: chars(MAX_TEXT), exitCode: Int(0, 255).optional() }),
  compare: z.strictObject({
    mode: z.enum(['exact', 'trimmed', 'tokens', 'numeric']),
    abs: Tolerance.optional(),
    rel: Tolerance.optional(),
  }),
});

const CallCheck = z.strictObject({
  ...checkBase,
  kind: z.literal('call'),
  function: z.string().regex(/^[A-Za-z_.][A-Za-z0-9_.]{0,127}$/),
  args: z.array(z.unknown()).max(32).optional(),
  kwargs: z
    .record(z.string(), z.unknown())
    .refine((o) => Object.keys(o).length <= 32, { message: 'at most 32 keyword arguments' })
    .optional(),
  expected: z
    .strictObject({
      value: z.unknown().optional(),
      raises: z.strictObject({ type: chars(128), message: chars(512).optional() }).optional(),
    })
    .refine((e) => 'value' in e !== 'raises' in e, {
      message: 'expected holds exactly one of value and raises',
    }),
  compare: z.strictObject({
    mode: z.enum(['exact', 'numeric', 'repr']),
    abs: Tolerance.optional(),
    rel: Tolerance.optional(),
  }),
});

const ScriptCheck = z.strictObject({
  ...checkBase,
  kind: z.literal('script'),
  args: ProgramArgs.optional(),
});

export const RunnerCheck = z.discriminatedUnion('kind', [StdioCheck, CallCheck, ScriptCheck]);
export type RunnerCheck = z.infer<typeof RunnerCheck>;

const limit = (name: RunnerLimitName) => Int(RUNNER_BOUNDS[name].min, RUNNER_BOUNDS[name].max);

/** The `execution.run` payload (job.schema.json). Semantic rules are in `validateJob`. */
export const RunnerJob = z.strictObject({
  v: z.literal(1),
  // job.schema.json's `format: uuid` is only an annotation in draft 2020-12; the mirror asserts it.
  jobId: z.guid(),
  runtime: z.strictObject({ id: RunnerRuntimeId, language: Language, image: ImageRef.optional() }),
  set: z.enum(['public', 'full']),
  limits: z.strictObject({
    wallSeconds: limit('wallSeconds'),
    memoryMiB: limit('memoryMiB'),
    outputBytes: limit('outputBytes'),
  }),
  files: z.array(RunnerFile).min(1).max(RUNNER_MAX_FILES),
  checks: z.array(RunnerCheck).min(1).max(RUNNER_MAX_CHECKS),
});
export type RunnerJob = z.infer<typeof RunnerJob>;

export type JobRule = 1 | 2 | 3 | 4;
export type JobValidation = { ok: true } | { ok: false; rule: JobRule; message: string };

/** POSIX normalisation of a schema-valid path (no `.`, `..` or empty segments survive). */
function normalisePath(path: string): string {
  return path
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/');
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decoded size in bytes, or null for base64 the harness would refuse to decode. */
function decodedSize(file: z.infer<typeof RunnerFile>): number | null {
  if (file.encoding === 'base64') {
    if (!BASE64.test(file.content)) return null;
    const padding = file.content.endsWith('==') ? 2 : file.content.endsWith('=') ? 1 : 0;
    return (file.content.length / 4) * 3 - padding;
  }
  return utf8Length(file.content);
}

/** UTF-8 length without a TextEncoder allocation of the whole string. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The semantic rules of design §3.1 that the JSON Schema cannot express, enforced by the server
 * before sending, by the runner (terminal `job_invalid`) and by the harness (exit 64):
 * 1. check names are unique;
 * 2. a `public` job holds no hidden check and no hidden file;
 * 3. every path a check names is in `files`, and a public check names no hidden file;
 * 4. paths are unique after normalisation, none is a directory prefix of another, files are at
 *    most 2 MiB decoded (valid base64 where so encoded) and the serialised job at most 4 MiB.
 */
export function validateJob(job: RunnerJob): JobValidation {
  const fail = (rule: JobRule, message: string): JobValidation => ({ ok: false, rule, message });

  const names = new Set<string>();
  for (const check of job.checks) {
    if (names.has(check.name)) return fail(1, `duplicate check name ${check.name}`);
    names.add(check.name);
  }

  if (job.set === 'public') {
    if (job.checks.some((c) => c.visibility === 'hidden')) {
      return fail(2, 'a public job holds a hidden check');
    }
    if (job.files.some((f) => f.hidden === true))
      return fail(2, 'a public job holds a hidden file');
  }

  const byPath = new Map<string, z.infer<typeof RunnerFile>>();
  let total = 0;
  for (const file of job.files) {
    const normal = normalisePath(file.path);
    if (byPath.has(normal)) return fail(4, `duplicate file path ${file.path}`);
    byPath.set(normal, file);
    const size = decodedSize(file);
    if (size === null) return fail(4, `file ${file.path} is not valid base64`);
    total += size;
  }
  if (total > RUNNER_MAX_FILE_BYTES) return fail(4, 'files exceed 2 MiB decoded');
  for (const path of byPath.keys()) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      if (byPath.has(prefix))
        return fail(4, `file path ${prefix} is a directory prefix of ${path}`);
    }
  }
  if (utf8Length(JSON.stringify(job)) > RUNNER_MAX_JOB_BYTES) {
    return fail(4, 'serialised job exceeds 4 MiB');
  }

  for (const check of job.checks) {
    for (const path of [check.file, ...(check.files ?? [])]) {
      const file = byPath.get(normalisePath(path));
      if (!file) return fail(3, `check ${check.name} names ${path}, which is not in files`);
      if (check.visibility === 'public' && file.hidden === true) {
        return fail(3, `public check ${check.name} names hidden file ${path}`);
      }
    }
  }
  return { ok: true };
}

const CheckStatus = z.enum(['passed', 'failed', 'error', 'timeout', 'skipped']);
const ErrorKind = z.enum(['exception', 'exit', 'signal', 'memory', 'spawn', 'harness']);

export const RunnerCheckResult = z
  .strictObject({
    name: CheckName,
    status: CheckStatus,
    errorKind: ErrorKind.optional(),
    durationMs: z.number().int().min(0),
    expected: chars(2048).optional(),
    actual: chars(2048).optional(),
    message: chars(512).optional(),
    exitCode: Int(0, 255).optional(),
    signal: Int(1, 64).optional(),
    stdout: chars(RUNNER_BOUNDS.outputBytes.max),
    stderr: chars(RUNNER_BOUNDS.outputBytes.max),
    truncated: z.boolean(),
  })
  .refine((c) => (c.status === 'error') === (c.errorKind !== undefined), {
    message: 'errorKind is present exactly when status is error',
  });
export type RunnerCheckResult = z.infer<typeof RunnerCheckResult>;

/** The harness's result document (result.schema.json), read from the nonce frame. */
export const RunnerResult = z.strictObject({
  v: z.literal(1),
  harnessVersion: z.string().regex(/^[0-9]+$/),
  runtime: z.strictObject({ language: Language, version: chars(64) }),
  compileError: z
    .strictObject({
      file: chars(200),
      line: z.number().int().min(1).optional(),
      message: chars(2048),
    })
    .optional(),
  checks: z.array(RunnerCheckResult).min(1).max(RUNNER_MAX_CHECKS),
  truncated: z.boolean(),
  durationMs: z.number().int().min(0),
});
export type RunnerResult = z.infer<typeof RunnerResult>;

export const RUNNER_OUTCOME_STATUSES = [
  'passed',
  'failed',
  'time_limited',
  'resource_exhausted',
] as const;
export const RunnerOutcomeStatus = z.enum(RUNNER_OUTCOME_STATUSES);
export type RunnerOutcomeStatus = z.infer<typeof RunnerOutcomeStatus>;

/** Container stderr kept as `harnessLog` (§3.3). */
export const RUNNER_HARNESS_LOG_BYTES = 8 * KiB;

/** What the runner reports for a job that produced a student outcome (§3.3); zod only. */
export const RunnerOutcome = z
  .strictObject({
    v: z.literal(1),
    jobId: z.guid(),
    status: RunnerOutcomeStatus,
    image: z.strictObject({ ref: z.string(), id: z.string(), digest: z.string().nullable() }),
    container: z.strictObject({
      exitCode: z.number().int().nullable(),
      oomKilled: z.boolean(),
      killedByTimer: z.boolean(),
      durationMs: z.number().int().min(0),
    }),
    result: RunnerResult.nullable(),
    harnessLog: z.string().refine((s) => utf8Length(s) <= RUNNER_HARNESS_LOG_BYTES, {
      message: 'harnessLog is at most 8 KiB',
    }),
  })
  .refine((o) => o.result !== null || o.container.oomKilled || o.container.killedByTimer, {
    message: 'result is null only for a container killed by memory or by the timer',
  });
export type RunnerOutcome = z.infer<typeof RunnerOutcome>;

/** Infrastructure failure kinds (§3.3); the runner fails the pg-boss job with `{ kind, message }`. */
export const RUNNER_FAILURE_KINDS = [
  'daemon_unreachable',
  'image_unavailable',
  'image_not_allowed',
  'job_invalid',
  'harness_failed',
  'result_missing',
  'result_invalid',
] as const;
export type RunnerFailureKind = (typeof RUNNER_FAILURE_KINDS)[number];
/** Kinds that are dead-lettered at once rather than retried. */
export const TERMINAL_FAILURE_KINDS: ReadonlySet<RunnerFailureKind> = new Set([
  'image_not_allowed',
  'job_invalid',
]);
