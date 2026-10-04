import type { Anchor } from '@parallax/contracts';
import {
  createAnnotation,
  createThread,
  deleteAnnotation,
  deletePost,
  editPost,
  listAnnotations,
  moderatePost,
  replyToThread,
  saveAnnotation,
  setThreadStatus,
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
function classify(error: unknown, allowGone = false): SendResult {
  if (error instanceof ApiError) {
    const body = error.body as { error?: string; current?: Annotation } | null;
    if (error.status === 409 && body?.error === 'revision_conflict' && body.current) {
      return { kind: 'conflict', current: body.current };
    }
    if (error.status === 409 && body?.error === 'class_archived') {
      return { kind: 'failed', reason: 'This class is archived, so notes can no longer change.' };
    }
    // Only a save can find its note gone; a create that gets 404 means the reading is unreachable.
    if (error.status === 404 && allowGone) return { kind: 'gone' };
    return { kind: 'failed', reason: null };
  }
  // fetch rejects when the request never got an answer. Only the browser saying it is offline is
  // taken as offline (and an `online` event will follow); anything else offers Retry.
  return offline() ? { kind: 'offline' } : { kind: 'failed', reason: null };
}

/** Browsers cap the bodies of keepalive requests at 64 KiB in all; longer text goes without. */
const KEEPALIVE_MAX_CHARS = 16_000;

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

function dropAnnotation(client: QueryClient, classId: string, resourceId: string, id: string) {
  client.setQueryData<MarginList>(
    listKey(classId, resourceId),
    (list) => list && { ...list, annotations: list.annotations.filter((x) => x.id !== id) },
  );
}

/** What a thread action answered, in the terms the discussion shows. */
export type ThreadResult = { ok: true } | { ok: false; message: string };

export type ThreadAction =
  | { kind: 'reply'; threadId: string; body: string; parentId?: string }
  | { kind: 'edit'; postId: string; body: string }
  | { kind: 'delete'; postId: string }
  | { kind: 'status'; threadId: string; status: 'open' | 'resolved' }
  | { kind: 'moderate'; postId: string; reason: string };

function refusal(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: string; message?: string } | null;
    if (error.status === 409 && body?.error === 'class_archived') {
      return 'This class is archived, so discussions can no longer change.';
    }
    if (error.status === 400 && body?.message) return body.message;
    if (error.status === 404) return 'This discussion is no longer available.';
  }
  return offline()
    ? 'You are offline. Try again when you are back online.'
    : 'Could not save. Try again.';
}

export interface MarginActions {
  /** Runs one discussion action; the cached thread is replaced by what the server answered. */
  thread(action: ThreadAction): Promise<ThreadResult>;
  createNote(anchor: Anchor, body: string): Promise<SendResult>;
  saveNote(id: string, expectedRevision: number, body: string, final: boolean): Promise<SendResult>;
  highlight(anchor: Anchor): Promise<SendResult>;
  remove(id: string): Promise<boolean>;
  ask(audience: 'instructor' | 'class', anchor: Anchor, body: string): Promise<Thread | SendResult>;
  acknowledged(a: Annotation): void;
  /** Stops listing an annotation without asking the server (it is already gone there). */
  forget(id: string): void;
}

/** Calls the annotation routes and keeps the cached list in step with what the server answered. */
export function useMarginActions(classId: string, resourceId: string): MarginActions {
  const client = useQueryClient();
  return useMemo(() => {
    const params = { classId, resourceId };
    return {
      acknowledged: (a) => putAnnotation(client, classId, resourceId, a),
      forget: (id) => dropAnnotation(client, classId, resourceId, id),
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
      async saveNote(id, expectedRevision, body, final) {
        if (offline()) return { kind: 'offline' };
        try {
          const annotation = await call(saveAnnotation, {
            params: { classId, annotationId: id },
            body: { expectedRevision, body },
            keepalive: final && body.length <= KEEPALIVE_MAX_CHARS,
          });
          putAnnotation(client, classId, resourceId, annotation);
          return { kind: 'ok', annotation };
        } catch (error) {
          return classify(error, true);
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
        dropAnnotation(client, classId, resourceId, id);
        return true;
      },
      async thread(action) {
        if (offline()) return { ok: false, message: refusal(null) };
        try {
          const classParams = { classId };
          const updated = await (action.kind === 'reply'
            ? call(replyToThread, {
                params: { ...classParams, threadId: action.threadId },
                body: { body: action.body, parentId: action.parentId },
              })
            : action.kind === 'edit'
              ? call(editPost, {
                  params: { ...classParams, postId: action.postId },
                  body: { body: action.body },
                })
              : action.kind === 'delete'
                ? call(deletePost, { params: { ...classParams, postId: action.postId } })
                : action.kind === 'status'
                  ? call(setThreadStatus, {
                      params: { ...classParams, threadId: action.threadId },
                      body: { status: action.status },
                    })
                  : call(moderatePost, {
                      params: { ...classParams, postId: action.postId },
                      body: { reason: action.reason },
                    }));
          client.setQueryData<MarginList>(
            listKey(classId, resourceId),
            (list) =>
              list && {
                ...list,
                threads: list.threads.map((t) => (t.id === updated.id ? updated : t)),
              },
          );
          return { ok: true };
        } catch (error) {
          return { ok: false, message: refusal(error) };
        }
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
