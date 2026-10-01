import {
  getReading,
  listReadings,
  putPosition,
  type ReadingPosition,
} from '@parallax/contracts/routes/readings';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { z } from 'zod';
import { call, useApi } from '../api/client';

export type ReadingList = z.output<typeof listReadings.response>;
export type ReadingSummary = ReadingList['readings'][number];
export type ReadingContent = z.output<typeof getReading.response>;
export type { ReadingPosition };

export const useReadings = (classId: string, topicId: string) =>
  useApi(listReadings, { params: { classId, topicId } });

/**
 * Content links last five minutes (§13). A reading stays fresh and cached for four, then is
 * dropped, so a shown reading never holds expired links; within that time nothing refetches it,
 * because new HTML (new image links) would replace the page under a reader mid-scroll.
 */
const CONTENT_TTL_MS = 4 * 60_000;
const PENDING_POLL_MS = 3000;

/** One reading's content; while its ingestion job runs the query asks again every few seconds. */
export const useReadingContent = (classId: string, revisionId: string) => {
  const args = { params: { classId, revisionId } };
  return useQuery({
    queryKey: [getReading.method, getReading.path, args],
    queryFn: () => call(getReading, args),
    gcTime: CONTENT_TTL_MS,
    staleTime: CONTENT_TTL_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? PENDING_POLL_MS : false),
  });
};

/** A fresh content link for a PDF whose earlier one expired. */
export async function renewPdfUrl(classId: string, revisionId: string): Promise<string | null> {
  const fresh = await call(getReading, { params: { classId, revisionId } });
  return fresh.pdf?.url ?? null;
}

/**
 * Saves the caller's place and, once the server acknowledges it, patches the cached list so a
 * return to the tab (or to another reading) restores that place, not the one fetched earlier.
 */
export function useSavePosition(classId: string, topicId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    async (revisionId: string, position: ReadingPosition) => {
      await call(putPosition, {
        params: { classId },
        body: { revisionId, tab: 'reading', position },
      });
      const key = ['GET', listReadings.path, { params: { classId, topicId } }];
      queryClient.setQueryData<ReadingList>(
        key,
        (list) =>
          list && {
            readings: list.readings.map((r) =>
              r.revisionId === revisionId ? { ...r, position } : r,
            ),
            lastRevisionId: revisionId,
          },
      );
    },
    [classId, topicId, queryClient],
  );
}
