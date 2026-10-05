import type { StudentRunView } from './api';
import styles from './Test.module.css';

type Check = NonNullable<StudentRunView['result']>['checks'][number];

const ERROR_TEXT: Record<NonNullable<Check['errorKind']>, string> = {
  exception: 'Runtime error',
  exit: 'The program exited with an error',
  signal: 'The program was stopped',
  memory: 'Memory limit reached',
  spawn: 'The program could not be started',
  harness: 'The test runner failed on this test',
};

function CheckResult({ check }: { check: Check }) {
  const verdict =
    check.status === 'passed'
      ? 'Passed'
      : check.status === 'failed'
        ? 'Failed'
        : check.status === 'timeout'
          ? 'Timed out'
          : check.status === 'skipped'
            ? 'Skipped'
            : (ERROR_TEXT[check.errorKind ?? 'exception'] ?? 'Runtime error');
  const detail = [
    check.errorKind === 'exit' && check.exitCode !== undefined ? `exit code ${check.exitCode}` : '',
    check.errorKind === 'signal' && check.signal !== undefined ? `signal ${check.signal}` : '',
  ].filter(Boolean);
  return (
    <li className={styles.check}>
      <h4>
        {verdict} · {check.name}
        {detail.length > 0 ? ` (${detail.join(', ')})` : ''}
      </h4>
      {check.status === 'failed' && (check.expected !== undefined || check.actual !== undefined) ? (
        <pre>
          {`Expected: ${check.expected ?? '(not shown)'}\nActual: ${check.actual ?? '(not shown)'}`}
        </pre>
      ) : null}
      {check.message ? <pre>{check.message}</pre> : null}
      {check.stdout ? (
        <>
          <span className={styles.small}>Program output</span>
          <pre>{check.stdout}</pre>
        </>
      ) : null}
      {check.stderr ? (
        <>
          <span className={styles.small}>Error output</span>
          <pre>{check.stderr}</pre>
        </>
      ) : null}
      {check.truncated ? <p className={styles.small}>This output was cut at its limit.</p> : null}
    </li>
  );
}

/** What the run says, in the states §11 names: compile and runtime errors, limits, pass or fail. */
export function RunResult({ run }: { run: StudentRunView }) {
  const result = run.result;
  if (!result) return null;
  const failed = result.checks.filter((c) => c.status !== 'passed' && c.status !== 'skipped');
  const headline =
    result.status === 'passed'
      ? `All ${result.checks.length} sample tests passed`
      : result.status === 'time_limited'
        ? 'Time limit reached · the run was stopped'
        : result.status === 'resource_exhausted'
          ? 'Resource limit reached · memory or output'
          : result.compileError
            ? 'Compile error · no sample test ran'
            : `${failed.length} of ${result.checks.length} sample tests did not pass`;
  return (
    <>
      <p>
        <strong>{headline}</strong>
        {result.runtime ? (
          <span className={styles.small}>
            {' '}
            · {result.runtime.language === 'python' ? 'Python' : 'R'} {result.runtime.version} ·{' '}
            {(result.durationMs / 1000).toFixed(1)} s
          </span>
        ) : null}
      </p>
      {result.compileError ? (
        <pre>
          {`${result.compileError.file}${
            result.compileError.line !== undefined ? `:${result.compileError.line}` : ''
          }\n${result.compileError.message}`}
        </pre>
      ) : null}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {result.checks.map((check) => (
          <CheckResult key={check.name} check={check} />
        ))}
      </ul>
      {result.truncated ? <p className={styles.small}>The output was cut at its limit.</p> : null}
    </>
  );
}
