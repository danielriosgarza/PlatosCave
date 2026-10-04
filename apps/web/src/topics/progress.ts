import { getClassTopics } from '@parallax/contracts/routes/topics';
import type { QueryClient } from '@tanstack/react-query';
import { coursesQuery } from '../courses/queries';

/** Query key of one topic's reviewed marks and what they still lack. */
export const reviewSheetKey = (classId: string, topicId: string) =>
  ['review-sheet', classId, topicId] as const;

/**
 * Re-reads what completion depends on after something the student did changed it: a reviewed
 * mark, a completed credited exercise, a submitted notebook. The review sheet, the syllabus
 * (states, locks and footer count) and the course cards all follow (§4).
 */
export function refreshProgress(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['review-sheet'] });
  void queryClient.invalidateQueries({ queryKey: ['GET', getClassTopics.path] });
  void queryClient.invalidateQueries({ queryKey: coursesQuery.queryKey });
}
