import { getCourseOverview, getProcessing } from '@parallax/contracts/routes/authoring';
import { listDrafts } from '@parallax/contracts/routes/drafts';
import { validateDrafts } from '@parallax/contracts/routes/releases';
import { queryOptions } from '@tanstack/react-query';
import { call } from '../api/client';

/** Every authoring query of a course starts with this key, so one invalidation refreshes them. */
export const authoringKey = (courseId: string) => ['authoring', courseId] as const;

export const draftsQuery = (courseId: string) =>
  queryOptions({
    queryKey: [...authoringKey(courseId), 'drafts'],
    queryFn: () => call(listDrafts, { params: { courseId } }),
  });

export const overviewQuery = (courseId: string) =>
  queryOptions({
    queryKey: [...authoringKey(courseId), 'overview'],
    queryFn: () => call(getCourseOverview, { params: { courseId } }),
  });

export const validationQuery = (courseId: string) =>
  queryOptions({
    queryKey: [...authoringKey(courseId), 'validation'],
    queryFn: () => call(validateDrafts, { params: { courseId } }),
  });

const settled = new Set(['ready', 'failed']);

/** Readings are processed in the background; poll while any of them is still unfinished. */
export const processingQuery = (courseId: string) =>
  queryOptions({
    queryKey: [...authoringKey(courseId), 'processing'],
    queryFn: () => call(getProcessing, { params: { courseId } }),
    refetchInterval: (query) =>
      query.state.data?.resources.some((r) => r.state !== null && !settled.has(r.state))
        ? 2000
        : false,
  });
