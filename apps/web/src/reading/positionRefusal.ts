import type { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';

/** Classes whose position saves the server refused as archived, for the life of this client. */
const refused = new WeakMap<QueryClient, Set<string>>();

/** True when the server answered 409 `class_archived`: the class takes no more position saves. */
export function isArchivedRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.body as { error?: unknown } | null)?.error === 'class_archived'
  );
}

export function markPositionsRefused(client: QueryClient, classId: string) {
  let classes = refused.get(client);
  if (!classes) {
    classes = new Set();
    refused.set(client, classes);
  }
  classes.add(classId);
}

/** Once refused, the reading and slide pages send no further position saves for the class. */
export function positionsRefused(client: QueryClient, classId: string): boolean {
  return refused.get(client)?.has(classId) ?? false;
}
