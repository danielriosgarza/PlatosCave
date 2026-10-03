import { me } from '@parallax/contracts/routes/me';
import { exitPreview } from '@parallax/contracts/routes/preview';
import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, call } from '../api/client';

export type Me = z.output<typeof me.response>;
export type SessionClass = Me['classes'][number];

/**
 * Reads the session. A 401 can be a draft preview whose session ended (8 h, or a later start)
 * while the browser still keeps the instructor's own session: leave the preview once, and read
 * the session again if that handed the instructor's back. Anything else means signed out.
 */
async function readMe(leaveEndedPreview = true): Promise<Me | null> {
  try {
    return await call(me);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error;
  }
  if (!leaveEndedPreview) return null;
  try {
    const { restored } = await call(exitPreview);
    if (!restored) return null;
  } catch {
    return null; // 409: there was no preview to leave.
  }
  return readMe(false);
}

/** `null` means nobody is signed in (the API answered 401); any other failure is an error. */
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: () => readMe(),
  staleTime: 30_000,
  retry: false,
});

/** Serves a fresh cached session and waits for a refetch when it is stale, so guards re-check it. */
export const loadSession = (queryClient: QueryClient) => queryClient.fetchQuery(sessionQuery);

/** Marks a failed session check, so its copy is shown for that and nothing else. */
export class SessionCheckError extends Error {
  constructor(readonly reason: unknown) {
    super('session check failed');
  }
}

/**
 * For route guards: re-checks a stale session, and when that fails keeps the last good answer
 * (a cached `null` still means signed out). With nothing cached the page cannot be shown.
 */
export async function loadSessionOrCached(queryClient: QueryClient): Promise<Me | null> {
  try {
    return await loadSession(queryClient);
  } catch (error) {
    const cached = queryClient.getQueryData<Me | null>(sessionQuery.queryKey);
    if (cached === undefined) throw new SessionCheckError(error);
    return cached;
  }
}

/** Records the signed-out state where observers can see it, then drops other cached data. */
export function endSession(queryClient: QueryClient) {
  queryClient.setQueryData(sessionQuery.queryKey, null);
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; me: Me };

export function useSession(): SessionState {
  const { data, isPending, isError } = useQuery(sessionQuery);
  // A failed background re-check keeps the last good answer; only report an error without one.
  if (data !== undefined)
    return data ? { status: 'signed-in', me: data } : { status: 'signed-out' };
  if (isPending) return { status: 'loading' };
  return isError ? { status: 'error' } : { status: 'loading' };
}

/**
 * The memberships this session acts through, as the server decides (ADR-0002): a person's real
 * memberships, or only the preview memberships of a draft-preview session.
 */
export function usableClasses(m: Me): SessionClass[] {
  const preview = m.user.kind === 'preview';
  return m.classes.filter((c) => c.isPreview === preview);
}

/** Teaching means an instructor class membership or any course permission (§3). */
export function teachingContexts(m: Me) {
  return {
    classes: usableClasses(m).filter((c) => c.role === 'instructor'),
    courses: m.courses,
  };
}

export function studyingClasses(m: Me): SessionClass[] {
  return usableClasses(m).filter((c) => c.role === 'student');
}
