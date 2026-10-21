import {
  type ChannelServerMessage,
  ExecutionMap,
  executeRequest,
  inputReply,
  type KernelState,
  kernelEvent,
  nextExecutionState,
  nextKernelState,
  parentOf,
  parseKernelMessage,
} from '@parallax/contracts';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialLiveState, type LiveState, liveReducer } from '../../notebooks/live/executionState';
import type { Channel, ChannelStatus } from '../../notebooks/live/useChannel';
import type { ConnectorClient } from './connector';

/**
 * A level 0 page's live kernel (docs/design/open-site.md §13): the kernel channel the connector's
 * open mode bridges to Jupyter on this computer, read into the same `LiveState` as level 1's
 * channel, so the same reducer and views show it. The page binds its own executions by the
 * relay's rules (`@parallax/contracts` kernelMessages): each `execute_request` it sends is one
 * execution, a kernel message counts only when its parent is one of them on the current kernel
 * and generation, and nothing is ever sent again. A channel that drops leaves what was running
 * `unconfirmed`; the person decides whether to run it again.
 */

export interface LocalTarget {
  client: ConnectorClient;
  session: string;
  kernel: { id: string; name: string; state: string | undefined };
}

export interface LocalChannel extends Channel {
  /** Restarts the kernel: its variables are lost, and running cells end as aborted. */
  restart: () => Promise<void>;
  /** Opens the channel again after it dropped, to the same kernel. */
  reconnect: () => void;
}

const REPORTED = new Set(['starting', 'idle', 'busy', 'restarting', 'dead']);

export function useLocalKernel(target: LocalTarget): LocalChannel {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const [status, setStatus] = useState<ChannelStatus>('connecting');
  const [attempt, setAttempt] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  // What the page bound, and the kernel as the page last heard it.
  const bound = useRef(new ExecutionMap());
  const prompts = useRef(new Map<string, Record<string, unknown>>());
  const kernel = useRef<{ state: KernelState; generation: number }>({
    state: REPORTED.has(target.kernel.state ?? '')
      ? (target.kernel.state as KernelState)
      : 'starting',
    generation: 0,
  });
  const counters = useRef({ seq: 0, eventSeq: 0 });
  // One Jupyter session id for the page's whole life: Jupyter's `session_id` and each header's.
  const jupyterSession = useRef(crypto.randomUUID());
  const live = useRef<LiveState>(state);
  live.current = state;

  const message = useCallback(
    (m: ChannelServerMessage) => dispatch({ type: 'message', message: m }),
    [],
  );
  const kernelTo = useCallback(
    (next: KernelState, generation = kernel.current.generation) => {
      kernel.current = { state: next, generation };
      message({ v: 1, t: 'kernel_state', state: next, generation });
    },
    [message],
  );
  const executionTo = useCallback(
    (msgId: string, event: Parameters<typeof nextExecutionState>[1], executionCount?: number) => {
      const execution = bound.current.get(msgId);
      if (!execution) return;
      const next = nextExecutionState(execution.state, event);
      if (next === null) return;
      execution.state = next;
      if (executionCount !== undefined) execution.executionCount = executionCount;
      message({
        v: 1,
        t: 'execution',
        executionId: execution.id,
        ref: execution.ref,
        cellId: execution.cellId,
        seq: execution.seq,
        state: next,
        ...(execution.executionCount === undefined
          ? {}
          : { executionCount: execution.executionCount }),
        outputsIncomplete: next === 'incomplete' || execution.outputsIncomplete,
        generation: execution.generation,
      });
    },
    [message],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` reopens the channel
  useEffect(() => {
    const { client, session } = target;
    const kernelId = target.kernel.id;
    let stopped = false;
    setStatus('connecting');
    const ws = new WebSocket(client.channelUrl(session, kernelId, jupyterSession.current));
    socket.current = ws;
    const infoRequest = crypto.randomUUID();
    ws.onopen = () => {
      if (stopped) return;
      setStatus('open');
      message({
        v: 1,
        t: 'ready',
        epoch: live.current.epoch ?? crypto.randomUUID(),
        eventSeq: counters.current.eventSeq,
        session: {
          state: 'ready',
          cause: null,
          owned: true,
          lease: { idleTimeoutMin: 30, gracePeriodMin: 0 },
        },
        kernel: {
          id: kernelId,
          name: target.kernel.name,
          state: kernel.current.state,
          generation: kernel.current.generation,
        },
      });
      // The answer says the kernel listens; until then it is as Jupyter last reported it.
      ws.send(
        JSON.stringify({
          header: {
            msg_id: infoRequest,
            msg_type: 'kernel_info_request',
            session: jupyterSession.current,
            username: '',
            date: new Date().toISOString(),
            version: '5.3',
          },
          parent_header: {},
          metadata: {},
          content: {},
          buffers: [],
          channel: 'shell',
        }),
      );
    };
    ws.onmessage = (event) => {
      if (stopped || typeof event.data !== 'string') return;
      const parsed = parseKernelMessage(event.data);
      if (!parsed) return;
      const parent = parentOf(parsed);
      if (parsed.header.msg_type === 'kernel_info_reply' && parent === infoRequest) {
        if (kernel.current.state === 'starting' || kernel.current.state === 'unknown')
          kernelTo('idle');
        return;
      }
      const ev = kernelEvent(parsed);
      if (ev.t === 'status') {
        kernelTo(nextKernelState(kernel.current.state, { t: 'reported', state: ev.state }));
      }
      const match = bound.current.match(parent, kernelId, {
        kernelId,
        generation: kernel.current.generation,
      });
      if (!match.ok) return;
      const execution = match.execution;
      switch (ev.t) {
        case 'status':
          if (ev.state === 'busy') executionTo(execution.msgId, { t: 'busy' });
          return;
        case 'output':
        case 'clear_output': {
          counters.current.eventSeq += 1;
          message({
            v: 1,
            t: 'output',
            executionId: execution.id,
            eventSeq: counters.current.eventSeq,
            generation: execution.generation,
            kind: ev.t,
            ...(ev.t === 'output' ? { output: ev.output } : {}),
          });
          return;
        }
        case 'input_request': {
          prompts.current.set(execution.id, parsed.header);
          kernelTo(nextKernelState(kernel.current.state, { t: 'input_request' }));
          counters.current.eventSeq += 1;
          message({
            v: 1,
            t: 'output',
            executionId: execution.id,
            eventSeq: counters.current.eventSeq,
            generation: execution.generation,
            kind: 'input_request',
            input: { prompt: ev.prompt, password: ev.password },
          });
          return;
        }
        case 'reply':
          executionTo(execution.msgId, { t: 'reply', status: ev.status }, ev.executionCount);
          prompts.current.delete(execution.id);
          return;
        case 'ignored':
          return;
      }
    };
    ws.onclose = () => {
      if (socket.current === ws) socket.current = null;
      if (stopped) return;
      setStatus('closed');
      // The page can no longer hear the kernel: what was in flight may or may not have finished.
      for (const execution of bound.current.all()) executionTo(execution.msgId, { t: 'link_lost' });
      prompts.current.clear();
      kernelTo(nextKernelState(kernel.current.state, { t: 'lost' }));
      message({ v: 1, t: 'session_state', state: 'disconnected', cause: 'connector_offline' });
    };
    ws.onerror = () => {
      // `close` follows.
    };
    return () => {
      stopped = true;
      ws.close();
      if (socket.current === ws) socket.current = null;
    };
  }, [target, attempt]);

  const send = useCallback((text: string) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(text);
    return true;
  }, []);

  const execute = useCallback(
    (cellId: string, code: string) => {
      const ws = socket.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return null;
      const ref = crypto.randomUUID();
      const msgId = crypto.randomUUID();
      counters.current.seq += 1;
      bound.current.add({
        id: msgId,
        msgId,
        ref,
        cellId,
        seq: counters.current.seq,
        kernelId: target.kernel.id,
        generation: kernel.current.generation,
        state: 'sent',
        outputsIncomplete: false,
      });
      dispatch({ type: 'sent', execute: { ref, cellId, code } });
      ws.send(executeRequest(msgId, jupyterSession.current, code, new Date()));
      message({
        v: 1,
        t: 'execution',
        executionId: msgId,
        ref,
        cellId,
        seq: counters.current.seq,
        state: 'sent',
        outputsIncomplete: false,
        generation: kernel.current.generation,
      });
      return ref;
    },
    [target, message],
  );

  const reply = useCallback(
    (executionId: string, value: string) => {
      const prompt = prompts.current.get(executionId);
      if (!prompt) return false;
      if (
        !send(inputReply(crypto.randomUUID(), jupyterSession.current, prompt, value, new Date()))
      ) {
        return false;
      }
      prompts.current.delete(executionId);
      dispatch({ type: 'prompt_answered', executionId });
      kernelTo(nextKernelState(kernel.current.state, { t: 'input_replied' }));
      return true;
    },
    [send, kernelTo],
  );

  const interrupt = useCallback(() => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) return false;
    target.client.interrupt(target.session, target.kernel.id).catch(() => {
      message({
        v: 1,
        t: 'error',
        code: 'internal',
        detail: 'The kernel could not be interrupted.',
      });
    });
    return true;
  }, [target, message]);

  const restart = useCallback(async () => {
    await target.client.restart(target.session, target.kernel.id);
    // A new generation: whatever was running ends, and its output is the previous kernel's.
    const generation = kernel.current.generation + 1;
    for (const execution of bound.current.all()) executionTo(execution.msgId, { t: 'restart' });
    bound.current.clear();
    prompts.current.clear();
    kernelTo(nextKernelState(kernel.current.state, { t: 'restart' }), generation);
  }, [target, executionTo, kernelTo]);

  const dismissRefusal = useCallback(
    (cellId: string) => dispatch({ type: 'dismiss_refusal', cellId }),
    [],
  );
  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    state,
    status,
    offline: false,
    execute,
    inputReply: reply,
    interrupt,
    dismissRefusal,
    restart,
    reconnect,
  };
}
