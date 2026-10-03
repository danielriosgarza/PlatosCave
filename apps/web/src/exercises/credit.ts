import type { ExerciseCredit } from '@parallax/contracts';

const POLICY_TEXT: Record<ExerciseCredit['hintPolicy'], string> = {
  free: 'hints do not change the credit',
  reduces_credit: 'a step solved with hints earns reduced credit',
  forfeits_credit: 'a step solved with hints earns no credit',
};

/** "10 points", or "1 point"; whole numbers print without decimals. */
export const pointsText = (points: number) => `${points} ${points === 1 ? 'point' : 'points'}`;

/** The credit sentence of the completion summary. */
export const creditSummary = (credit: ExerciseCredit) =>
  `for credit: ${pointsText(credit.points)}; ${POLICY_TEXT[credit.hintPolicy]}`;

/** What an exercise says about its grading before and after the student starts (§9). */
export const creditText = (credit: ExerciseCredit | null) =>
  credit
    ? `For credit · ${pointsText(credit.points)} · ${POLICY_TEXT[credit.hintPolicy]}`
    : 'Practice · ungraded';
