import type { Terms } from './api';
import styles from './Test.module.css';

/** A time in the assignment's own zone, with the zone named (§11). */
export function formatInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(iso));
}

const REPORTED = {
  latest: 'Your latest attempt',
  highest: 'Your highest attempt',
  instructor_selected: 'The attempt your instructor selects',
} as const;

/** The terms shown before and during work: attempts, points, timing, late policy and release (§11). */
export function termsRows(
  terms: Terms,
  options: { attemptNumber?: number; deadlineAt?: string | null } = {},
): [string, string][] {
  const zone = terms.timeZone;
  // `terms` is already the student's effective terms: the server has added any override.
  const attempts = terms.attempts;
  const rows: [string, string][] = [];
  rows.push([
    'Attempts',
    options.attemptNumber ? `Attempt ${options.attemptNumber} of ${attempts}` : String(attempts),
  ]);
  rows.push([
    'Duration',
    terms.durationMinutes === null ? 'Untimed' : `${terms.durationMinutes} minutes from the start`,
  ]);
  rows.push(['Points', String(terms.totalPoints)]);
  if (terms.opensAt) rows.push(['Opens', formatInZone(terms.opensAt, zone)]);
  const closes = terms.override?.closesAt ?? terms.closesAt;
  rows.push([
    'Closes',
    closes
      ? `${formatInZone(closes, zone)}${terms.override?.closesAt ? ' · extended for you' : ''}`
      : 'No closing time',
  ]);
  if (options.deadlineAt) {
    rows.push(['Your deadline', formatInZone(options.deadlineAt, zone)]);
  }
  rows.push([
    'Late work',
    terms.late.policy === 'none'
      ? 'Not accepted'
      : `Accepted until ${formatInZone(terms.late.until, zone)} and marked late`,
  ]);
  rows.push(['Allowed materials', terms.allowedMaterials.trim() || 'None stated']);
  rows.push([
    'Results',
    terms.release.results === 'manual'
      ? 'Released by your instructor'
      : terms.release.at
        ? `Released ${formatInZone(terms.release.at, zone)}`
        : 'Released on a schedule',
  ]);
  rows.push([
    'Solutions',
    terms.release.solutions === 'never' ? 'Not released' : 'Released with results',
  ]);
  rows.push([
    'Hidden test details',
    terms.release.hiddenTestDetails ? 'Shown with results' : 'Not shown',
  ]);
  rows.push(['Reported grade', REPORTED[terms.reportedGrade]]);
  return rows;
}

/** Effective assignment terms, kept in view for the whole attempt (§11). */
export function TermsPanel({
  terms,
  attemptNumber,
  deadlineAt,
}: {
  terms: Terms;
  attemptNumber?: number;
  deadlineAt?: string | null;
}) {
  return (
    <section aria-label="Assignment terms">
      <h4 className={styles.termsHead}>Terms</h4>
      <dl className={styles.terms}>
        {termsRows(terms, { attemptNumber, deadlineAt }).map(([term, value]) => (
          <div key={term} style={{ display: 'contents' }}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
