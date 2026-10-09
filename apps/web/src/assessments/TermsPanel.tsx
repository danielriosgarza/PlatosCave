import { formatInstant, REPORTED_RULE_LABEL } from '../format/format';
import type { Terms } from './api';
import styles from './Test.module.css';

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The terms shown before and during work: attempts, points, timing, late policy and release (§11). */
function termsRows(
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
  if (terms.opensAt) rows.push(['Opens', formatInstant(terms.opensAt, zone)]);
  const closes = terms.override?.closesAt ?? terms.closesAt;
  rows.push([
    'Closes',
    closes
      ? `${formatInstant(closes, zone)}${terms.override?.closesAt ? ' · extended for you' : ''}`
      : 'No closing time',
  ]);
  if (options.deadlineAt) {
    rows.push(['Your deadline', formatInstant(options.deadlineAt, zone)]);
  }
  rows.push([
    'Late work',
    terms.late.policy === 'none'
      ? 'Not accepted'
      : `Accepted until ${formatInstant(terms.late.until, zone)} and marked late`,
  ]);
  rows.push(['Allowed materials', terms.allowedMaterials.trim() || 'None stated']);
  rows.push([
    'Results',
    terms.release.results === 'manual'
      ? 'Released by your instructor'
      : terms.release.at
        ? `Released ${formatInstant(terms.release.at, zone)}`
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
  rows.push(['Reported grade', upperFirst(REPORTED_RULE_LABEL[terms.reportedGrade])]);
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
