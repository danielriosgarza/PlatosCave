import { QueryCache, QueryClient, type QueryKey, useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { type Me, sessionQuery } from './useSession';

const revokedKey = (classId: string) => ['access-revoked', classId] as const;

/** True once this session learned that the person lost access to the class (§14). */
export function useRevoked(classId: string): boolean {
  const { data } = useQuery({
    queryKey: revokedKey(classId),
    queryFn: () => true,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data === true;
}

const mentions = (key: QueryKey, classId: string) => JSON.stringify(key).includes(classId);

/**
 * Stops everything for the class and drops what it cached, so classmates' records outlive the
 * access that allowed them in neither memory nor the next render (§14).
 */
export function revokeClass(client: QueryClient, classId: string) {
  void client.cancelQueries({ predicate: (q) => mentions(q.queryKey, classId) });
  client.removeQueries({
    predicate: (q) => q.queryKey[0] !== 'access-revoked' && mentions(q.queryKey, classId),
  });
  client.setQueryData(revokedKey(classId), true);
}

/** A 404 on class data that loaded before means access ended only if the session says so too. */
async function checkMembership(client: QueryClient, key: QueryKey) {
  const before = client.getQueryData<Me | null>(sessionQuery.queryKey);
  const classes = (before?.classes ?? []).filter((c) => mentions(key, c.classId));
  if (classes.length === 0) return;
  let now: Me | null | undefined;
  try {
    now = await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
  } catch {
    return; // Could not tell: keep the page rather than claim a loss.
  }
  if (!now) return; // Signed out: the session guard handles it.
  for (const c of classes) {
    if (!now.classes.some((k) => k.classId === c.classId)) revokeClass(client, c.classId);
  }
}

export function createQueryClient(defaultQueries: { retry?: boolean } = {}): QueryClient {
  const queryCache = new QueryCache({
    onError(error, query) {
      if (error instanceof ApiError && error.status === 404 && query.state.data !== undefined) {
        void checkMembership(client, query.queryKey);
      }
    },
  });
  const client = new QueryClient({ queryCache, defaultOptions: { queries: defaultQueries } });
  // A page still mounted for a moment after the loss may ask again; its answer is never kept.
  queryCache.subscribe((event) => {
    const { queryKey } = event.query;
    if (event.type !== 'added' || queryKey[0] === 'access-revoked') return;
    const gone = (client.getQueriesData({ queryKey: ['access-revoked'] }) as [QueryKey, unknown][])
      .filter(([, value]) => value === true)
      .some(([key]) => mentions(queryKey, String(key[1])));
    if (gone) queueMicrotask(() => client.removeQueries({ queryKey, exact: true }));
  });
  return client;
}
