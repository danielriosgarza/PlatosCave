import type { ExecutionState, KernelState } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import {
  type ExecutionEvent,
  ExecutionMap,
  executeRequest,
  inputReply,
  type KernelStateEvent,
  kernelEvent,
  nextExecutionState,
  nextKernelState,
  parseKernelMessage,
} from './binding';

/**
 * The pure parts of execution binding (docs/design/connector.md §10.6): the execution and kernel
 * state machines, the matching rule, and the Jupyter messages the relay writes and reads.
 */

const EXECUTION_STATES: ExecutionState[] = [
  'sent',
  'running',
  'ok',
  'error',
  'aborted',
  'incomplete',
  'unconfirmed',
];

const executionRows: {
  event: ExecutionEvent;
  moves: Partial<Record<ExecutionState, ExecutionState>>;
}[] = [
  { event: { t: 'busy' }, moves: { sent: 'running', unconfirmed: 'running' } },
  {
    event: { t: 'reply', status: 'ok' },
    moves: { sent: 'ok', running: 'ok', unconfirmed: 'ok' },
  },
  {
    event: { t: 'reply', status: 'error' },
    moves: { sent: 'error', running: 'error', unconfirmed: 'error' },
  },
  { event: { t: 'write_failed' }, moves: { sent: 'unconfirmed' } },
  { event: { t: 'link_lost' }, moves: { sent: 'unconfirmed', running: 'unconfirmed' } },
  { event: { t: 'reconnected_busy' }, moves: { unconfirmed: 'running' } },
  {
    event: { t: 'drained' },
    moves: { unconfirmed: 'incomplete' },
  },
  {
    event: { t: 'restart' },
    moves: { sent: 'aborted', running: 'aborted', unconfirmed: 'aborted' },
  },
  {
    event: { t: 'kernel_lost' },
    moves: { sent: 'incomplete', running: 'incomplete', unconfirmed: 'incomplete' },
  },
];

describe('execution states', () => {
  for (const row of executionRows) {
    test(`${row.event.t}${'status' in row.event ? ` ${row.event.status}` : ''}`, () => {
      for (const state of EXECUTION_STATES) {
        expect(nextExecutionState(state, row.event), state).toBe(row.moves[state] ?? null);
      }
    });
  }

  test('A31 no event moves an execution back to sent, so nothing is ever sent twice', () => {
    for (const row of executionRows) {
      for (const state of EXECUTION_STATES) {
        expect(nextExecutionState(state, row.event)).not.toBe('sent');
      }
    }
  });
});

const KERNEL_STATES: KernelState[] = [
  'starting',
  'idle',
  'busy',
  'waiting_for_input',
  'restarting',
  'dead',
  'unknown',
];

describe('kernel states', () => {
  const cases: { event: KernelStateEvent; expect: (from: KernelState) => KernelState }[] = [
    { event: { t: 'reported', state: 'idle' }, expect: () => 'idle' },
    {
      event: { t: 'reported', state: 'busy' },
      expect: (from) => (from === 'waiting_for_input' ? 'waiting_for_input' : 'busy'),
    },
    { event: { t: 'reported', state: 'dead' }, expect: () => 'dead' },
    { event: { t: 'reported', state: 'restarting' }, expect: () => 'restarting' },
    {
      event: { t: 'input_request' },
      expect: (from) => (from === 'dead' || from === 'unknown' ? from : 'waiting_for_input'),
    },
    {
      event: { t: 'input_replied' },
      expect: (from) => (from === 'waiting_for_input' ? 'busy' : from),
    },
    { event: { t: 'restart' }, expect: () => 'restarting' },
    { event: { t: 'lost' }, expect: () => 'unknown' },
  ];
  for (const c of cases) {
    test(`${c.event.t}${'state' in c.event ? ` ${c.event.state}` : ''}`, () => {
      for (const from of KERNEL_STATES) {
        expect(nextKernelState(from, c.event), from).toBe(c.expect(from));
      }
    });
  }
});

describe('matching', () => {
  const kernel = '9d3c0a52-6f1e-4c0b-8d57-1a2b3c4d5e6f';
  const other = '0e3c0a52-6f1e-4c0b-8d57-1a2b3c4d5e6f';
  const execution = {
    id: '11111111-1111-4111-8111-111111111111',
    msgId: 'aaaaaaaa-1111-4111-8111-111111111111',
    ref: 'bbbbbbbb-1111-4111-8111-111111111111',
    cellId: 'cell-1',
    seq: 1,
    kernelId: kernel,
    generation: 2,
    state: 'running' as const,
    outputsIncomplete: false,
  };
  const map = new ExecutionMap([execution]);

  test('A31 a known parent on the current kernel and generation matches', () => {
    expect(map.match(execution.msgId, kernel, { kernelId: kernel, generation: 2 })).toEqual({
      ok: true,
      execution,
    });
  });

  test('A31 an unknown parent, another kernel or an old generation is dropped', () => {
    const current = { kernelId: kernel, generation: 2 };
    expect(map.match('nope', kernel, current)).toEqual({ ok: false, reason: 'unknown_parent' });
    expect(map.match(undefined, kernel, current)).toEqual({ ok: false, reason: 'unknown_parent' });
    expect(map.match(execution.msgId, other, current)).toEqual({
      ok: false,
      reason: 'other_kernel',
    });
    expect(map.match(execution.msgId, kernel, { kernelId: kernel, generation: 3 })).toEqual({
      ok: false,
      reason: 'old_generation',
    });
  });
});

describe('Jupyter messages', () => {
  const now = new Date('2026-10-01T09:00:00Z');
  const session = '7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

  test('execute_request carries the msg_id, the session id, stdin and stop on error', () => {
    const request = JSON.parse(executeRequest('m-1', session, 'print(1)', now));
    expect(request).toMatchObject({
      header: { msg_id: 'm-1', msg_type: 'execute_request', session, version: '5.3' },
      parent_header: {},
      channel: 'shell',
      content: { code: 'print(1)', allow_stdin: true, stop_on_error: true, silent: false },
    });
  });

  test('input_reply answers the prompt on stdin', () => {
    const prompt = { msg_id: 'p-1', msg_type: 'input_request' };
    expect(JSON.parse(inputReply('r-1', session, prompt, 'yes', now))).toMatchObject({
      header: { msg_id: 'r-1', msg_type: 'input_reply', session },
      parent_header: prompt,
      channel: 'stdin',
      content: { value: 'yes' },
    });
  });

  const message = (msgType: string, content: object) =>
    parseKernelMessage(
      JSON.stringify({ header: { msg_id: 'k', msg_type: msgType }, parent_header: {}, content }),
    );

  test('kernel messages become nbformat outputs, prompts, replies and states', () => {
    const read = (msgType: string, content: object) => {
      const parsed = message(msgType, content);
      if (!parsed) throw new Error('unparsed');
      return kernelEvent(parsed);
    };
    expect(read('stream', { name: 'stdout', text: '4\n' })).toEqual({
      t: 'output',
      output: { output_type: 'stream', name: 'stdout', text: '4\n' },
    });
    expect(read('execute_result', { execution_count: 3, data: { 'text/plain': '4' } })).toEqual({
      t: 'output',
      output: {
        output_type: 'execute_result',
        execution_count: 3,
        data: { 'text/plain': '4' },
        metadata: {},
      },
    });
    expect(read('error', { ename: 'E', evalue: 'v', traceback: ['a', 1] })).toEqual({
      t: 'output',
      output: { output_type: 'error', ename: 'E', evalue: 'v', traceback: ['a'] },
    });
    expect(read('input_request', { prompt: 'Name? ', password: false })).toEqual({
      t: 'input_request',
      prompt: 'Name? ',
      password: false,
    });
    expect(read('execute_reply', { status: 'ok', execution_count: 3 })).toEqual({
      t: 'reply',
      status: 'ok',
      executionCount: 3,
    });
    expect(read('status', { execution_state: 'busy' })).toEqual({ t: 'status', state: 'busy' });
    expect(read('comm_open', {})).toEqual({ t: 'ignored' });
  });

  test('text that is not a kernel message is not parsed', () => {
    expect(parseKernelMessage('not json')).toBeNull();
    expect(parseKernelMessage(JSON.stringify({ header: {} }))).toBeNull();
  });
});
