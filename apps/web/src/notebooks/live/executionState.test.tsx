import type { ChannelServerMessage } from '@parallax/contracts';
import { describe, expect, it } from 'vitest';
import { initialLiveState, type LiveState, liveReducer } from './executionState';
import { groupOutputs, shownOutput, stripAnsi } from './liveOutput';

const EPOCH = '00000000-0000-4000-8000-0000000f0001';
const K = '00000000-0000-4000-8000-0000000f0002';
const E1 = '00000000-0000-4000-8000-0000000e0001';
const REF = '00000000-0000-4000-8000-0000000d0001';

const msg = (m: Record<string, unknown>) => ({ v: 1, ...m }) as unknown as ChannelServerMessage;
const apply = (state: LiveState, ...messages: ChannelServerMessage[]) =>
  messages.reduce((s, message) => liveReducer(s, { type: 'message', message }), state);

const ready = (epoch = EPOCH, eventSeq = 0) =>
  msg({
    t: 'ready',
    epoch,
    eventSeq,
    session: {
      state: 'ready',
      cause: null,
      owned: true,
      lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
    },
    kernel: { id: K, name: 'python3', state: 'idle', generation: 0 },
  });
const execution = (state: string, extra: Record<string, unknown> = {}) =>
  msg({
    t: 'execution',
    executionId: E1,
    ref: REF,
    cellId: 'c1',
    seq: 1,
    state,
    outputsIncomplete: false,
    generation: 0,
    ...extra,
  });
const output = (eventSeq: number, text: string, extra: Record<string, unknown> = {}) =>
  msg({
    t: 'output',
    executionId: E1,
    eventSeq,
    generation: 0,
    kind: 'output',
    output: { output_type: 'stream', name: 'stdout', text },
    ...extra,
  });

describe('execution state', () => {
  it('A31 an execute stays pending until the relay answers it, and keeps its ref', () => {
    let s = liveReducer(initialLiveState, {
      type: 'sent',
      execute: { ref: REF, cellId: 'c1', code: 'x' },
    });
    expect(s.pending).toEqual([{ ref: REF, cellId: 'c1', code: 'x' }]);
    s = apply(s, execution('running'));
    expect(s.pending).toEqual([]);
    expect(s.executions[E1]?.ref).toBe(REF);
  });

  it('A31 an error naming a ref drops that execute and says why on its cell', () => {
    let s = liveReducer(initialLiveState, {
      type: 'sent',
      execute: { ref: REF, cellId: 'c1', code: 'x' },
    });
    s = apply(s, msg({ t: 'error', code: 'not_ready', ref: REF }));
    expect(s.pending).toEqual([]);
    expect(s.refusals.c1).toEqual({ code: 'not_ready' });
  });

  it('A31 a replayed output event is applied once', () => {
    let s = apply(initialLiveState, ready(), execution('running'), output(1, 'a'), output(2, 'b'));
    s = apply(s, output(2, 'b'), output(1, 'a'), output(3, 'c'));
    expect(s.executions[E1]?.outputs.map((o) => o.eventSeq)).toEqual([1, 2, 3]);
    expect(s.eventSeq).toBe(3);
  });

  it('A31 another epoch drops the position and marks running executions incomplete', () => {
    let s = apply(initialLiveState, ready(), execution('running'), output(1, 'a'));
    s = apply(s, ready('00000000-0000-4000-8000-0000000f0009', 0));
    expect(s.eventSeq).toBe(0);
    expect(s.executions[E1]?.outputsIncomplete).toBe(true);
    expect(s.executions[E1]?.state).toBe('running');
  });

  it('A31 an execution carried over a relay restart stays incomplete when the relay reports it again', () => {
    let s = apply(initialLiveState, ready(), execution('running'));
    s = apply(s, ready('00000000-0000-4000-8000-0000000f0009', 0), execution('running'));
    expect(s.executions[E1]?.outputsIncomplete).toBe(true);
  });

  it('the same epoch keeps the position', () => {
    let s = apply(initialLiveState, ready(), execution('running'), output(1, 'a'));
    s = apply(s, ready(EPOCH, 1));
    expect(s.eventSeq).toBe(1);
    expect(s.executions[E1]?.outputsIncomplete).toBe(false);
  });

  it('clear_output empties the outputs and an input request sets the prompt until the execution ends', () => {
    let s = apply(initialLiveState, ready(), execution('running'), output(1, 'a'));
    s = apply(
      s,
      msg({ t: 'output', executionId: E1, eventSeq: 2, generation: 0, kind: 'clear_output' }),
    );
    expect(s.executions[E1]?.outputs).toEqual([]);
    s = apply(
      s,
      msg({
        t: 'output',
        executionId: E1,
        eventSeq: 3,
        generation: 0,
        kind: 'input_request',
        input: { prompt: 'n? ', password: false },
      }),
    );
    expect(s.executions[E1]?.prompt).toEqual({ prompt: 'n? ', password: false });
    s = apply(s, execution('ok'));
    expect(s.executions[E1]?.prompt).toBeNull();
  });

  it('a kernel state other than waiting_for_input closes any prompt', () => {
    let s = apply(initialLiveState, ready(), execution('running'));
    s = apply(
      s,
      msg({
        t: 'output',
        executionId: E1,
        eventSeq: 1,
        generation: 0,
        kind: 'input_request',
        input: { prompt: 'n? ', password: true },
      }),
      msg({ t: 'kernel_state', state: 'idle', generation: 0 }),
    );
    expect(s.executions[E1]?.prompt).toBeNull();
  });

  it('a session state message replaces the session and keeps who owns it', () => {
    const s = apply(
      initialLiveState,
      ready(),
      msg({ t: 'session_state', state: 'disconnected', cause: 'sleep' }),
    );
    expect(s.session).toEqual({ state: 'disconnected', cause: 'sleep', owned: true });
  });
});

describe('live output', () => {
  it('A09 text is text: ANSI is removed and nothing is parsed as markup', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
    const shown = shownOutput({
      output_type: 'stream',
      name: 'stdout',
      text: '<script>alert(1)</script>',
    });
    expect(shown).toEqual({ kind: 'text', stream: 'stdout', text: '<script>alert(1)</script>' });
  });

  it('A09 an HTML output is withheld: its plain alternative is kept and no markup is produced', () => {
    const shown = shownOutput({
      output_type: 'display_data',
      metadata: {},
      data: { 'text/html': '<p onclick="x()">hi</p><script>1</script>', 'text/plain': 'hi' },
    });
    expect(shown).toEqual({ kind: 'withheld', mimeTypes: ['text/html'], text: 'hi' });
  });

  it('streams of one kind join and the text is capped', () => {
    const items = [
      {
        eventSeq: 1,
        generation: 0,
        output: { output_type: 'stream' as const, name: 'stdout' as const, text: 'a' },
      },
      {
        eventSeq: 2,
        generation: 0,
        output: { output_type: 'stream' as const, name: 'stdout' as const, text: 'b' },
      },
      {
        eventSeq: 3,
        generation: 0,
        output: { output_type: 'stream' as const, name: 'stderr' as const, text: 'c' },
      },
    ];
    const { shown, truncated } = groupOutputs(items);
    expect(shown.map((o) => (o.kind === 'text' ? o.text : ''))).toEqual(['ab', 'c']);
    expect(truncated).toBe(false);
    const big = groupOutputs([
      {
        eventSeq: 1,
        generation: 0,
        output: { output_type: 'stream', name: 'stdout', text: 'x'.repeat(60_000) },
      },
    ]);
    expect(big.truncated).toBe(true);
    expect(big.shown[0]?.kind === 'text' && big.shown[0].text.length).toBe(50_000);
  });
});
