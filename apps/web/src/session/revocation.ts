import { me as meRoute } from '@parallax/contracts/routes/me';
import { exitPreview } from '@parallax/contracts/routes/preview';
import { QueryCache, QueryClient, type QueryKey, useQuery } from '@tanstack/react-query';
import { ApiError, onRefusal } from '../api/client';
import { onSessionChange } from './broadcast';
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

/**
 * A 404 on class data that loaded before may mean access ended, and a 401 or 404 anywhere may
 * mean another tab changed the session: ask the session. If it lost the class, the session
 * subscription in `createQueryClient` revokes it; if it is someone else now, it resets.
 */
async function recheckSession(client: QueryClient) {
  try {
    await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
  } catch {
    // Could not tell: keep the page rather than claim a loss.
  }
}

const classIds = (me: Me | null | undefined) => new Set((me?.classes ?? []).map((c) => c.classId));

export function createQueryClient(defaultQueries: { retry?: boolean } = {}): QueryClient {
  const queryCache = new QueryCache({
    onError(error, query) {
      if (error instanceof ApiError && error.status === 404 && query.state.data !== undefined) {
        void recheckSession(client);
      }
    },
  });
  const client = new QueryClient({ queryCache, defaultOptions: { queries: defaultQueries } });
  // Any refusal, including an autosave outside the query cache, and any other tab's session
  // change re-read the session. The session's own reads are left out: they decide it.
  onRefusal((_status, path) => {
    if (path !== meRoute.path && path !== exitPreview.path) void recheckSession(client);
  });
  onSessionChange(() => void recheckSession(client));
  // Whichever request first sees the loss, a class that leaves the session is revoked, and one
  // that returns is let back in (§14).
  let known = new Set<string>();
  let knownUser: string | undefined;
  queryCache.subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (JSON.stringify(event.query.queryKey) !== JSON.stringify(sessionQuery.queryKey)) return;
    const data = event.query.state.data as Me | null | undefined;
    const now = classIds(data);
    if (data == null) {
      known = new Set(); // Signed out: the next person's classes are not compared with this one's.
      knownUser = undefined;
      return;
    }
    if (knownUser !== undefined && knownUser !== data.user.id) {
      // Another identity now (a preview started or ended in another tab): nothing cached for the
      // previous one is kept, and nothing of it counts as a lost class.
      knownUser = data.user.id;
      known = now;
      client.removeQueries({ queryKey: ['access-revoked'] });
      void client.resetQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      return;
    }
    knownUser = data.user.id;
    for (const id of known) if (!now.has(id)) revokeClass(client, id);
    for (const id of now) client.removeQueries({ queryKey: revokedKey(id), exact: true });
    known = now;
  });
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
