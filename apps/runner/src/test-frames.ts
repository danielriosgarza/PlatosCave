import type { RunnerJob, RunnerResult } from '@parallax/contracts';

/** Test support: framing exactly as the harness writes it (runner/harness/run.py `frame`). */
export function frameBytes(nonce: string, result: unknown): Buffer {
  return Buffer.from(
    `\n--parallax-result ${nonce}\n${JSON.stringify(result)}\n--parallax-end ${nonce}\n`,
    'utf8',
  );
}

const name = (i: number) => `${String(i).padStart(2, '0')}${'n'.repeat(62)}`;

/** The job whose checks a maximal result answers: 50 checks with 64-character names. */
export function maximalJob(): Pick<RunnerJob, 'checks'> {
  return {
    checks: Array.from({ length: 50 }, (_, i) => ({
      name: name(i),
      kind: 'script' as const,
      visibility: 'public' as const,
      file: 'solution.py',
    })),
  };
}

/**
 * The largest result the harness can produce at `outputBytes`: 50 checks with 64-character names,
 * 2048-character `expected` and `actual`, 512-character `message`, every optional field, the
 * captured streams filling the whole `outputBytes`, and a 2048-character compile error.
 */
export function maximalResult(outputBytes: number): RunnerResult {
  const fill = 'x'.repeat(outputBytes - 2);
  return {
    v: 1,
    harnessVersion: '999999999',
    runtime: { language: 'python', version: 'v'.repeat(64) },
    compileError: { file: 'f'.repeat(200), line: 2147483647, message: 'm'.repeat(2048) },
    checks: Array.from({ length: 50 }, (_, i) => ({
      name: name(i),
      status: 'error' as const,
      errorKind: 'exception' as const,
      durationMs: 2147483647,
      expected: 'e'.repeat(2048),
      actual: 'a'.repeat(2048),
      message: 'm'.repeat(512),
      exitCode: 255,
      signal: 64,
      stdout: i === 0 ? fill : '',
      stderr: '',
      truncated: true,
    })),
    truncated: true,
    durationMs: 2147483647,
  };
}
