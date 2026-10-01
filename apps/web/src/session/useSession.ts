import { me } from '@parallax/contracts/routes/me';
import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, call } from '../api/client';

export type Me = z.output<typeof me.response>;
export type SessionClass = Me['classes'][number];

/** `null` means nobody is signed in (the API answered 401); any other failure is an error. */
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async (): Promise<Me | null> => {
    try {
      return await call(me);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  staleTime: 30_000,
  retry: false,
});

export const loadSession = (queryClient: QueryClient) => queryClient.ensureQueryData(sessionQuery);

export type SessionState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; me: Me };

export function useSession(): SessionState {
  const { data, isPending, isError } = useQuery(sessionQuery);
  if (isPending) return { status: 'loading' };
  if (isError) return { status: 'error' };
  return data ? { status: 'signed-in', me: data } : { status: 'signed-out' };
}

/** Teaching means an instructor class membership or any course permission (§3). */
export function teachingContexts(m: Me) {
  return {
    classes: m.classes.filter((c) => c.role === 'instructor' && !c.isPreview),
    courses: m.courses,
  };
}

export function studyingClasses(m: Me): SessionClass[] {
  return m.classes.filter((c) => c.role === 'student' && !c.isPreview);
}
