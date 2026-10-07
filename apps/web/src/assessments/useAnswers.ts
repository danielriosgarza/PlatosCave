import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiError } from '../api/client';
import { UNSENT_ANSWERS_PREFIX } from '../reading/margin/drafts';
import { type AttemptView, closedReceipt, type Receipt, saveAnswer } from './api';

/**
 * One answer as the browser holds it. `ackedSeq` is the last counter the server acknowledged;
 * only an acknowledgement makes the status `saved` (§11: no "Saved" without one).
 */
export interface Entry {
  value: unknown;
  flagged: boolean;
  seq: number;
  ackedSeq: number;
  status: 'saved' | 'dirty' | 'saving' | 'failed';
  savedAt: string | null;
  error: string | null;
}

const AUTOSAVE_MS = 800;
const localKey = (attemptId: string) => `${UNSENT_ANSWERS_PREFIX}${attemptId}`;

type Unsent = Record<string, { value: unknown; flagged: boolean; seq: number }>;

function readUnsent(attemptId: string): Unsent {
  try {
    const raw = window.localStorage.getItem(localKey(attemptId));
    return raw ? (JSON.parse(raw) as Unsent) : {};
  } catch {
    return {};
  }
}

function writeUnsent(attemptId: string, entries: Record<string, Entry>) {
  const unsent: Unsent = {};
  for (const [id, e] of Object.entries(entries)) {
    if (e.status !== 'saved') unsent[id] = { value: e.value, flagged: e.flagged, seq: e.seq };
  }
  try {
    if (Object.keys(unsent).length === 0) window.localStorage.removeItem(localKey(attemptId));
    else window.localStorage.setItem(localKey(attemptId), JSON.stringify(unsent));
  } catch {
    // Private windows and blocked storage: the in-memory copy still holds the work.
  }
}

export const clearUnsent = (attemptId: string) => {
  try {
    window.localStorage.removeItem(localKey(attemptId));
  } catch {
    // nothing kept, nothing to clear
  }
};

function initial(attempt: AttemptView): Record<string, Entry> {
  const entries: Record<string, Entry> = {};
  for (const q of attempt.questions) {
    entries[q.id] = {
      value: null,
      flagged: false,
      seq: 0,
      ackedSeq: 0,
      status: 'saved',
      savedAt: null,
      error: null,
    };
  }
  for (const a of attempt.answers) {
    entries[a.questionId] = {
      value: a.value,
      flagged: a.flagged,
      seq: a.seq,
      ackedSeq: a.seq,
      status: 'saved',
      savedAt: a.savedAt,
      error: null,
    };
  }
  // Work this browser held when the page was last closed or lost: resent unless the server has more.
  const unsent = readUnsent(attempt.id);
  for (const [id, u] of Object.entries(unsent)) {
    const entry = entries[id];
    if (entry && u.seq > entry.ackedSeq) {
      entries[id] = { ...entry, value: u.value, flagged: u.flagged, seq: u.seq, status: 'dirty' };
    }
  }
  return entries;
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    const body = error.body as { message?: unknown } | null;
    if (typeof body?.message === 'string') return body.message;
  }
  return 'Not saved. Check your connection and retry.';
}

/**
 * The answers of one attempt with their save state. Edits are sent a moment after the last
 * keystroke, one request per question at a time and in order; a counter per question keeps an
 * older save from replacing a newer one on the server. Unsent work is also kept in this browser
 * so a reload or a lost connection does not lose it (§14).
 */
export function useAnswers(
  classId: string,
  attempt: AttemptView,
  onClosed: (receipt: Receipt | null) => void,
) {
  const store = useRef<Record<string, Entry> | null>(null);
  if (store.current === null) store.current = initial(attempt);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const running = useRef(new Map<string, Promise<void>>());
  const closed = useRef(false);
  const attemptId = attempt.id;

  const patch = useCallback(
    (id: string, change: Partial<Entry>) => {
      const entries = store.current as Record<string, Entry>;
      const current = entries[id];
      if (!current) return;
      entries[id] = { ...current, ...change };
      writeUnsent(attemptId, entries);
      bump();
    },
    [attemptId],
  );

  /** Sends the latest value of one question, again while edits keep arriving. */
  const send = useCallback(
    (id: string): Promise<void> => {
      const existing = running.current.get(id);
      if (existing) return existing;
      const loop = (async () => {
        for (;;) {
          const entries = store.current as Record<string, Entry>;
          const entry = entries[id];
          if (!entry || closed.current || (entry.status !== 'dirty' && entry.status !== 'failed')) {
            return;
          }
          const { seq, value, flagged } = entry;
          patch(id, { status: 'saving', error: null });
          try {
            const ack = await saveAnswer(classId, attemptId, id, { value, flagged, seq });
            const now = (store.current as Record<string, Entry>)[id] as Entry;
            // The server keeps the value with the highest counter and says whether this request's
            // value is the one it stored. When it is not (another tab or device saved at this
            // counter or above), this value is not saved: move past that counter and send it again.
            const ignored = !ack.applied || ack.seq > seq;
            patch(id, {
              ackedSeq: Math.max(now.ackedSeq, ack.seq),
              savedAt: ack.savedAt,
              seq: ignored ? Math.max(now.seq, ack.seq + 1) : now.seq,
              status: !ignored && now.seq === seq ? 'saved' : 'dirty',
            });
          } catch (error) {
            const shut = closedReceipt(error);
            if (shut) {
              closed.current = true;
              onClosed(shut.receipt);
              return;
            }
            patch(id, { status: 'failed', error: describeFailure(error) });
            return;
          }
        }
      })().finally(() => running.current.delete(id));
      running.current.set(id, loop);
      return loop;
    },
    [classId, attemptId, onClosed, patch],
  );

  const edit = useCallback(
    (id: string, change: { value?: unknown; flagged?: boolean }) => {
      const entry = (store.current as Record<string, Entry>)[id];
      if (!entry || closed.current) return;
      patch(id, {
        ...('value' in change ? { value: change.value } : {}),
        ...('flagged' in change ? { flagged: change.flagged } : {}),
        seq: entry.seq + 1,
        status: entry.status === 'saving' ? 'saving' : 'dirty',
        error: null,
      });
      // A request in flight finishes first; its loop then sees the newer counter and sends again.
      const waiting = timers.current.get(id);
      if (waiting) clearTimeout(waiting);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void send(id);
        }, AUTOSAVE_MS),
      );
    },
    [patch, send],
  );

  /** Sends everything unsent now; resolves with the questions that are still not saved. */
  const flush = useCallback(async (): Promise<string[]> => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    const entries = store.current as Record<string, Entry>;
    await Promise.all(Object.keys(entries).map((id) => send(id)));
    return Object.entries(store.current as Record<string, Entry>)
      .filter(([, e]) => e.status !== 'saved')
      .map(([id]) => id);
  }, [send]);

  /** Adopts what the server holds after a reconnect, unless this browser has newer unsent work. */
  const adopt = useCallback(
    (view: AttemptView) => {
      for (const a of view.answers) {
        const entry = (store.current as Record<string, Entry>)[a.questionId];
        if (entry && entry.status === 'saved' && a.seq > entry.ackedSeq) {
          patch(a.questionId, {
            value: a.value,
            flagged: a.flagged,
            seq: a.seq,
            ackedSeq: a.seq,
            savedAt: a.savedAt,
          });
        }
      }
    },
    [patch],
  );

  // Work restored from this browser is sent as soon as the attempt opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened attempt
  useEffect(() => {
    const entries = store.current as Record<string, Entry>;
    if (attempt.state !== 'in_progress') return;
    for (const [id, e] of Object.entries(entries)) if (e.status === 'dirty') void send(id);
    return () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    };
  }, []);

  const stop = useCallback(() => {
    closed.current = true;
  }, []);
  const entries = store.current as Record<string, Entry>;
  return { entries, edit, flush, adopt, send, stop };
}
