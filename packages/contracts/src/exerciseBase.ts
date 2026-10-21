import { z } from 'zod';

/**
 * The fields every `exercise.v1` step shares (§9), apart from the step kinds that use them, so
 * `exercise.ts` and `exerciseInteractive.ts` build their steps from one definition.
 */

export const stepId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
export const label = z.string().trim().min(1).max(200);
export const prose = z.string().trim().min(1).max(4000);
export const option = z.object({ id: stepId, label });

export const common = {
  id: stepId,
  /** Short name on the step track, e.g. "Predict". */
  title: label,
  prompt: prose,
  /** Revealed one at a time; each reveal is recorded (§9). */
  hints: z.array(prose).max(10).default([]),
  /** Shown by Show solution, which completes the step with help. */
  solution: prose.optional(),
};

/** Shown after a correct check, and after a wrong one unless a more specific message applies. */
export const feedback = z.object({ correct: prose, incorrect: prose });
