import { getNotebook, getShiny, listNotebooks } from '@parallax/contracts/routes/notebooks';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, call, useApi } from '../api/client';

export type NotebookList = z.output<typeof listNotebooks.response>;
export type NotebookSummary = NotebookList['notebooks'][number];
export type NotebookContent = z.output<typeof getNotebook.response>;
export type Notebook = NonNullable<NotebookContent['notebook']>;
export type NotebookCell = Notebook['cells'][number];
export type CellOutput = Extract<NotebookCell, { type: 'code' }>['outputs'][number];

export const useNotebooks = (classId: string, topicId: string) =>
  useApi(listNotebooks, { params: { classId, topicId } });

/**
 * Output links last five minutes (§13). The notebook is fetched again before they lapse, while the
 * page is open and when the window is focused or the network returns, so a cell revealed later
 * shows its output from a live link.
 */
const CONTENT_TTL_MS = 4 * 60_000;
const PENDING_POLL_MS = 3000;

/** One notebook and its import state; while the import runs the query asks again every few seconds. */
export const useNotebookContent = (classId: string, revisionId: string) => {
  const args = { params: { classId, revisionId } };
  return useQuery({
    queryKey: [getNotebook.method, getNotebook.path, args],
    queryFn: () => call(getNotebook, args),
    gcTime: CONTENT_TTL_MS,
    staleTime: CONTENT_TTL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: (query) => {
      if (query.state.error instanceof ApiError && query.state.error.status === 404) return false;
      return query.state.data?.status === 'pending' ? PENDING_POLL_MS : CONTENT_TTL_MS;
    },
  });
};

export type ShinyContent = z.output<typeof getShiny.response>;

export const useShiny = (classId: string, revisionId: string) =>
  useApi(getShiny, { params: { classId, revisionId } });
