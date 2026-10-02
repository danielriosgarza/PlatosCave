import type { Anchor } from '@parallax/contracts';
import {
  createAnnotation,
  createThread,
  deleteAnnotation,
  listAnnotations,
  saveAnnotation,
  type threadView,
} from '@parallax/contracts/routes/annotations';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { z } from 'zod';
import { ApiError, call, useApi } from '../../api/client';
import type { Annotation, SendResult } from './notes';

export type Thread = z.output<typeof threadView>;
export type MarginList = { annotations: Annotation[]; threads: Thread[] };
export type { Annotation };

export const useMarginList = (classId: string, resourceId: string) =>
  useApi(listAnnotations, { params: { classId, resourceId } });

const listKey = (classId: string, resourceId: string) => [
  listAnnotations.method,
  listAnnotations.path,
  { params: { classId, resourceId } },
];

/** A refused or unreachable request, in the terms the editor shows (§8, §14). */
function classify(error: unknown): SendResult {
  if (error instanceof ApiError) {
    const body = error.body as { error?: string; current?: Annotation } | null;
    if (error.status === 409 && body?.error === 'revision_conflict' && body.current) {
      return { kind: 'conflict', current: body.current };
    }
    if (error.status === 409 && body?.error === 'class_archived') {
      return { kind: 'failed', reason: 'This class is archived, so notes can no longer change.' };
    }
    return { kind: 'failed', reason: null };
  }
  // fetch rejects with a TypeError when the network is unreachable.
  return { kind: 'offline' };
}

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Updates one annotation (or adds it) in the cached list a successful call just changed. */
function putAnnotation(client: QueryClient, classId: string, resourceId: string, a: Annotation) {
  client.setQueryData<MarginList>(listKey(classId, resourceId), (list) => {
    if (!list) return { annotations: [a], threads: [] };
    const has = list.annotations.some((x) => x.id === a.id);
    return {
      ...list,
      annotations: has
        ? list.annotations.map((x) => (x.id === a.id ? a : x))
        : [...list.annotations, a],
    };
  });
}

export interface MarginActions {
  createNote(anchor: Anchor, body: string): Promise<SendResult>;
  saveNote(id: string, expectedRevision: number, body: string): Promise<SendResult>;
  highlight(anchor: Anchor): Promise<SendResult>;
  remove(id: string): Promise<boolean>;
  ask(audience: 'instructor' | 'class', anchor: Anchor, body: string): Promise<Thread | SendResult>;
  acknowledged(a: Annotation): void;
}

/** Calls the annotation routes and keeps the cached list in step with what the server answered. */
export function useMarginActions(classId: string, resourceId: string): MarginActions {
  const client = useQueryClient();
  return useMemo(() => {
    const params = { classId, resourceId };
    return {
      acknowledged: (a) => putAnnotation(client, classId, resourceId, a),
      async createNote(anchor, body) {
        if (offline()) return { kind: 'offline' };
        try {
          const annotation = await call(createAnnotation, {
            params,
            body: { kind: 'note', anchor, body },
          });
          putAnnotation(client, classId, resourceId, annotation);
          return { kind: 'ok', annotation };
        } catch (error) {
          return classify(error);
        }
      },
      async saveNote(id, expectedRevision, body) {
        if (offline()) return { kind: 'offline' };
        try {
          const annotation = await call(saveAnnotation, {
            params: { classId, annotationId: id },
            body: { expectedRevision, body },
            keepalive: true,
          });
          putAnnotation(client, classId, resourceId, annotation);
          return { kind: 'ok', annotation };
        } catch (error) {
          return classify(error);
        }
      },
      async highlight(anchor) {
        if (offline()) return { kind: 'offline' };
        try {
          const annotation = await call(createAnnotation, {
            params,
            body: { kind: 'highlight', anchor },
          });
          putAnnotation(client, classId, resourceId, annotation);
          return { kind: 'ok', annotation };
        } catch (error) {
          return classify(error);
        }
      },
      async remove(id) {
        try {
          await call(deleteAnnotation, { params: { classId, annotationId: id } });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) return false;
        }
        client.setQueryData<MarginList>(
          listKey(classId, resourceId),
          (list) => list && { ...list, annotations: list.annotations.filter((x) => x.id !== id) },
        );
        return true;
      },
      async ask(audience, anchor, body) {
        if (offline()) return { kind: 'offline' };
        try {
          const thread = await call(createThread, { params, body: { audience, anchor, body } });
          client.setQueryData<MarginList>(listKey(classId, resourceId), (list) =>
            list
              ? { ...list, threads: [...list.threads, thread] }
              : { annotations: [], threads: [thread] },
          );
          return thread;
        } catch (error) {
          return classify(error);
        }
      },
    };
  }, [client, classId, resourceId]);
}
