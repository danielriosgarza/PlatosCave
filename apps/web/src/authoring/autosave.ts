import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

export type SaveState<S> =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; current: S };

interface Options<V, S extends { revision: number }> {
  /** The server copy the form started from. */
  server: S;
  toValues: (server: S) => V;
  /** Sends the values with the revision they are based on; a stale one rejects with 409. */
  save: (values: V, expectedRevision: number) => Promise<S>;
  delayMs?: number;
  /** Called with each acknowledged copy, so callers can refresh what depends on it. */
  onSaved?: (saved: S) => void;
}

/** Edits the form itself can see are not worth sending; its message is shown as is. */
export class LocalProblem extends Error {}

/** The 409 body of a revision conflict carries the server copy (ADR-0003). */
function conflictCopy<S>(err: unknown): S | undefined {
  if (!(err instanceof ApiError) || err.status !== 409) return undefined;
  const body = err.body as { error?: string; current?: S } | null;
  return body?.error === 'revision_conflict' ? body.current : undefined;
}

/**
 * Autosave with an optimistic revision (§12): edits are sent shortly after typing stops, always
 * with the revision last acknowledged. Saved is only reported after the server acknowledged a
 * save; a conflict stops saving and hands both copies to the caller, never overwriting silently.
 */
export function useAutosave<V extends object, S extends { revision: number }>({
  server,
  toValues,
  save,
  delayMs = 700,
  onSaved,
}: Options<V, S>) {
  const [values, setValues] = useState<V>(() => toValues(server));
  const [state, setState] = useState<SaveState<S>>({ kind: 'idle' });
  const latest = useRef(values);
  const revision = useRef(server.revision);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const pending = useRef(false);
  const stopped = useRef(false);
  const dirty = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const flush = useCallback(async () => {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    const sent = latest.current;
    setState({ kind: 'saving' });
    try {
      const saved = await saveRef.current(sent, revision.current);
      revision.current = saved.revision;
      onSavedRef.current?.(saved);
      if (latest.current === sent) dirty.current = false;
      if (pending.current || latest.current !== sent) {
        pending.current = false;
        inFlight.current = false;
        return void (await flush());
      }
      setState({ kind: 'saved', at: new Date() });
    } catch (err) {
      const current = conflictCopy<S>(err);
      if (current) {
        stopped.current = true;
        setState({ kind: 'conflict', current });
      } else {
        setState({
          kind: 'error',
          message:
            err instanceof LocalProblem
              ? err.message
              : err instanceof ApiError && err.status === 400
                ? 'The server rejected these changes.'
                : 'Your changes are not saved.',
        });
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  const schedule = useCallback(() => {
    if (stopped.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delayMs);
  }, [delayMs, flush]);

  // Leaving the page within the delay must not drop the edit: send what is pending.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (dirty.current && !stopped.current) void flush();
    },
    [flush],
  );

  const change = useCallback(
    (patch: Partial<V>) => {
      latest.current = { ...latest.current, ...patch };
      dirty.current = true;
      setValues(latest.current);
      if (!stopped.current) setState({ kind: 'dirty' });
      schedule();
    },
    [schedule],
  );

  /** Retries after a failed save without waiting for another edit. */
  const retry = useCallback(() => void flush(), [flush]);

  /** Takes the other editor's copy and drops the local edits. */
  const takeTheirs = useCallback(
    (current: S) => {
      stopped.current = false;
      revision.current = current.revision;
      latest.current = toValues(current);
      setValues(latest.current);
      setState({ kind: 'idle' });
    },
    [toValues],
  );

  /** Keeps the local edits and saves them on top of the other editor's revision. */
  const keepMine = useCallback(
    (current: S) => {
      stopped.current = false;
      revision.current = current.revision;
      void flush();
    },
    [flush],
  );

  return { values, change, state, retry, takeTheirs, keepMine };
}
