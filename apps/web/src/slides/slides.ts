import { putPosition, type ReadingPosition } from '@parallax/contracts/routes/readings';
import { getSlides, listSlides } from '@parallax/contracts/routes/slides';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { z } from 'zod';
import { ApiError, call, useApi } from '../api/client';

export type DeckList = z.output<typeof listSlides.response>;
export type DeckSummary = DeckList['decks'][number];
export type DeckContent = z.output<typeof getSlides.response>;

export const useDecks = (classId: string, topicId: string) =>
  useApi(listSlides, { params: { classId, topicId } });

/** Content links last five minutes (§13); a deck is fetched afresh, never from a stale link. */
const CONTENT_TTL_MS = 4 * 60_000;
const PENDING_POLL_MS = 3000;

/** One deck's file link and state; while its conversion runs the query asks again every few seconds. */
export const useDeckContent = (classId: string, revisionId: string) => {
  const args = { params: { classId, revisionId } };
  return useQuery({
    queryKey: [getSlides.method, getSlides.path, args],
    queryFn: () => call(getSlides, args),
    gcTime: CONTENT_TTL_MS,
    staleTime: CONTENT_TTL_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      query.state.data?.status === 'pending' &&
      !(query.state.error instanceof ApiError && query.state.error.status === 404)
        ? PENDING_POLL_MS
        : false,
  });
};

/** A fresh content link for a deck whose earlier one expired. */
export async function renewDeckUrl(classId: string, revisionId: string): Promise<string | null> {
  const fresh = await call(getSlides, { params: { classId, revisionId } });
  return fresh.pdf?.url ?? null;
}

/** The place of a deck: its slide, with no offset within it. */
export const slidePosition = (page: number): ReadingPosition => ({ page, offset: 0 });

/**
 * Saves the caller's slide and, once the server acknowledges it, patches the cached list so a
 * return to the tab (or to another deck) opens at that slide, not the one fetched earlier.
 */
export function useSaveSlide(classId: string, topicId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    async (revisionId: string, page: number) => {
      const position = slidePosition(page);
      await call(putPosition, {
        params: { classId },
        body: { revisionId, tab: 'slides', position },
        keepalive: true,
      });
      const key = ['GET', listSlides.path, { params: { classId, topicId } }];
      queryClient.setQueryData<DeckList>(
        key,
        (list) =>
          list && {
            decks: list.decks.map((d) => (d.revisionId === revisionId ? { ...d, position } : d)),
            lastRevisionId: revisionId,
          },
      );
    },
    [classId, topicId, queryClient],
  );
}
