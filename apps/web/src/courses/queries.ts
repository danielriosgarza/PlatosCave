import { listCourses } from '@parallax/contracts/routes/courses';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import type { z } from 'zod';
import { call } from '../api/client';
import { sessionQuery } from '../session/useSession';

export type Cards = z.output<typeof listCourses.response>;
export type ClassCard = Cards['classes'][number];
export type CourseCard = Cards['courses'][number];

export const coursesQuery = queryOptions({
  queryKey: ['courses'],
  queryFn: () => call(listCourses),
});

/** After joining a class or creating a course: the cards and the session's contexts both changed. */
export function refreshContexts(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: coursesQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey }),
  ]);
}
