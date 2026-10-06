import { CHANNEL_CLOSE, ChannelServerMessage } from '@parallax/contracts';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  initialLiveState,
  type LiveState,
  liveReducer,
  type PendingExecute,
} from './executionState';

/**
 * The browser end of the notebook channel (docs/design/connector.md §10.5): one WebSocket per
 * live notebook, a `hello` that resumes from the last event applied, reconnection with backoff,
 * and an `execute` that no `execution` message has answered is resent only with its original
 * `ref`, so the relay's idempotency key makes a resend harmless (§10.6). No message resends
 * anything else, and opening the channel never runs a cell.
 */

export type ChannelStatus = 'connecting' | 'open' | 'closed' | 'ended';

export interface Channel {
  state: LiveState;
  /** `open` once the socket is up; `closed` while it is down and a retry is scheduled; `ended` when the relay closed it for good. */
  status: ChannelStatus;
  /** True while the browser reports it is offline. */
  offline: boolean;
  /** Sends one cell to run and returns its `ref`; null, and nothing sent, when the socket is not open. */
  execute: (cellId: string, code: string) => string | null;
  inputReply: (executionId: string, value: string) => boolean;
  interrupt: () => boolean;
  dismissRefusal: (cellId: string) => void;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

export const channelUrl = (classId: string, sessionId: string): string => {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/classes/${classId}/notebook-sessions/${sessionId}/channels`;
};

/** Closes that retrying cannot fix: access gone, session ended, protocol error, relay unavailable (1011). */
const FINAL_CLOSES = new Set<number>([
  CHANNEL_CLOSE.scope_lost,
  CHANNEL_CLOSE.session_closed,
  CHANNEL_CLOSE.protocol_error,
  1011,
]);

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

export function useChannel(classId: string, sessionId: string, enabled: boolean): Channel {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const [status, setStatus] = useState<ChannelStatus>('connecting');
  const [offline, setOffline] = useState(!online());
  const socket = useRef<WebSocket | null>(null);
  // What `hello` resumes from and which executes to resend, read at the moment of connecting.
  const live = useRef<LiveState>(state);
  live.current = state;

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `offline` only wakes a reconnect
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let attempt = 0;
    let timer: number | undefined;
    let current: WebSocket | null = null;

    const connect = () => {
      if (stopped) return;
      if (!online()) {
        setStatus('closed');
        return;
      }
      setStatus('connecting');
      const ws = new WebSocket(channelUrl(classId, sessionId));
      current = ws;
      socket.current = ws;
      ws.onopen = () => {
        if (stopped) return;
        const { epoch, eventSeq } = live.current;
        ws.send(
          JSON.stringify({
            v: 1,
            t: 'hello',
            ...(epoch ? { resume: { epoch, afterEventSeq: eventSeq } } : {}),
          }),
        );
      };
      ws.onmessage = (event) => {
        if (stopped) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const message = ChannelServerMessage.safeParse(parsed);
        if (!message.success) return;
        if (message.data.t === 'ready') {
          attempt = 0;
          setStatus('open');
          dispatch({ type: 'message', message: message.data });
          // Resend what no `execution` answered, with the same ref: the relay answers with the
          // row it already has and never sends a second execute_request (§10.6).
          for (const p of live.current.pending) {
            ws.send(
              JSON.stringify({
                v: 1,
                t: 'execute',
                ref: p.ref,
                cellId: p.cellId,
                code: p.code,
              }),
            );
          }
          return;
        }
        dispatch({ type: 'message', message: message.data });
      };
      ws.onclose = (event) => {
        // A socket that was replaced closes late: it must not clear the one that replaced it.
        if (socket.current === ws) socket.current = null;
        if (stopped || current !== ws) return;
        if (FINAL_CLOSES.has(event.code)) {
          setStatus('ended');
          return;
        }
        setStatus('closed');
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] as number;
        attempt += 1;
        timer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        // `close` follows and schedules the retry.
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      current?.close();
      if (socket.current === current) socket.current = null;
    };
  }, [classId, sessionId, enabled, offline]);

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ v: 1, ...message }));
    return true;
  }, []);

  const execute = useCallback(
    (cellId: string, code: string) => {
      // A cell is never queued for later: with the socket down the run is refused, not remembered.
      const ws = socket.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return null;
      const ref = crypto.randomUUID();
      dispatch({ type: 'sent', execute: { ref, cellId, code } satisfies PendingExecute });
      send({ t: 'execute', ref, cellId, code });
      return ref;
    },
    [send],
  );

  const inputReply = useCallback(
    (executionId: string, value: string) => {
      const sent = send({ t: 'input_reply', executionId, value });
      if (sent) dispatch({ type: 'prompt_answered', executionId });
      return sent;
    },
    [send],
  );

  const interrupt = useCallback(() => send({ t: 'interrupt' }), [send]);
  const dismissRefusal = useCallback(
    (cellId: string) => dispatch({ type: 'dismiss_refusal', cellId }),
    [],
  );

  return { state, status, offline, execute, inputReply, interrupt, dismissRefusal };
}
