import type { TestAttemptState } from '@parallax/contracts';

/**
 * An instant as the one date-and-time reading used across screens, with the zone named so it is
 * never implicit (§11, §14). Without `timeZone` it is the viewer's own zone; the assignment's
 * zone and the tests' fixed zone pass it explicitly.
 */
const formatters = new Map<string | undefined, Intl.DateTimeFormat>();

export function formatInstant(iso: string, timeZone?: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(iso));
}

/** How a test attempt's state reads, for the student and the instructor alike (§11, §12). */
export const ATTEMPT_STATE_LABEL = {
  in_progress: 'In progress',
  submitted: 'Submitted',
  grading: 'Grading',
  needs_review: 'Needs review',
  graded: 'Graded',
  released: 'Released',
} satisfies Record<TestAttemptState, string>;

/** The same states for the student when no result is at hand: nothing is graded or released until it says so. */
export const STUDENT_ATTEMPT_STATE_LABEL = {
  in_progress: 'In progress',
  submitted: 'Submitted',
  grading: 'Submitted · being graded',
  needs_review: 'Submitted · awaiting instructor review',
  graded: 'Submitted · graded, not yet released',
  released: 'Results released',
} satisfies Record<TestAttemptState, string>;

/** Which attempt an assignment reports as the grade (§11). */
export const REPORTED_RULE_LABEL = {
  latest: 'latest attempt',
  highest: 'highest-scoring attempt',
  instructor_selected: 'instructor-selected attempt',
} as const;

/** A number of points without float noise: at most two decimals. */
export const points = (n: number) => String(Math.round(n * 100) / 100);

/** "6.67 of 10 points": the student's reading of a score, rounded like the instructor's. */
export const pointsOf = (earned: number, possible: number) =>
  `${points(earned)} of ${points(possible)} points`;

/** Offers `text` to the browser as a downloaded file. */
export function downloadText(filename: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked after the click is handled: some browsers abort a download whose URL is gone at once.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
