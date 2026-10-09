/**
 * An instant as the one date-and-time reading used across screens, with the zone named so it is
 * never implicit (§11, §14). Without `timeZone` it is the viewer's own zone; the assignment's
 * zone and the tests' fixed zone pass it explicitly.
 */
export function formatInstant(iso: string, timeZone?: string): string {
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

/** How a test attempt's state reads, for the student and the instructor alike (§11, §12). */
export const ATTEMPT_STATE_LABEL: Record<string, string> = {
  in_progress: 'In progress',
  submitted: 'Submitted',
  grading: 'Grading',
  needs_review: 'Needs review',
  graded: 'Graded',
  released: 'Released',
};

/** Which attempt an assignment reports as the grade (§11). */
export const REPORTED_RULE_LABEL = {
  latest: 'latest attempt',
  highest: 'highest-scoring attempt',
  instructor_selected: 'attempt your instructor chose',
} as const;

/** A number of points without float noise: at most two decimals. */
export const points = (n: number) => String(Math.round(n * 100) / 100);

/** Offers `text` to the browser as a downloaded file. */
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
