import { describe, expect, test } from 'vitest';
import {
  ChannelClientMessage,
  ChannelServerMessage,
  MAX_EXECUTE_CODE_BYTES,
} from './notebookChannel';

/** The browser channel's messages (docs/design/connector.md §10.5), both directions. */

const ref = '5b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const id = '6b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

describe('browser to server', () => {
  test('accepts the four messages', () => {
    for (const message of [
      { v: 1, t: 'hello' },
      { v: 1, t: 'hello', resume: { epoch: id, afterEventSeq: 4 } },
      { v: 1, t: 'execute', ref, cellId: 'cell-1', code: 'print(1)' },
      { v: 1, t: 'execute', ref, cellId: 'cell-1', workingCopyRevision: 3, code: '' },
      { v: 1, t: 'input_reply', executionId: id, value: 'yes' },
      { v: 1, t: 'interrupt' },
    ]) {
      expect(ChannelClientMessage.safeParse(message).success, JSON.stringify(message)).toBe(true);
    }
  });

  test('refuses other versions, unknown fields, a missing ref and code over 1 MiB', () => {
    for (const message of [
      { v: 2, t: 'hello' },
      { v: 1, t: 'hello', token: 'x' },
      { v: 1, t: 'execute', cellId: 'cell-1', code: '' },
      { v: 1, t: 'execute', ref: 'not-a-uuid', cellId: 'cell-1', code: '' },
      { v: 1, t: 'execute', ref, cellId: '../x', code: '' },
      { v: 1, t: 'execute', ref, cellId: 'cell-1', code: 'x'.repeat(MAX_EXECUTE_CODE_BYTES + 1) },
      { v: 1, t: 'execute', ref, cellId: 'c', code: '', kernelId: id },
      { v: 1, t: 'interrupt', kernelId: id },
      { v: 1, t: 'shutdown' },
    ]) {
      expect(
        ChannelClientMessage.safeParse(message).success,
        JSON.stringify(message).slice(0, 80),
      ).toBe(false);
    }
  });

  test('counts the code limit in UTF-8 bytes', () => {
    const code = 'é'.repeat(MAX_EXECUTE_CODE_BYTES / 2 + 1);
    expect(
      ChannelClientMessage.safeParse({ v: 1, t: 'execute', ref, cellId: 'c', code }).success,
    ).toBe(false);
  });
});

describe('server to browser', () => {
  test('accepts every message of §10.5', () => {
    for (const message of [
      {
        v: 1,
        t: 'ready',
        epoch: id,
        eventSeq: 0,
        session: {
          state: 'ready',
          cause: null,
          owned: true,
          lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
        },
        kernel: { id, name: 'python3', state: 'idle', generation: 1 },
      },
      {
        v: 1,
        t: 'execution',
        executionId: id,
        ref,
        cellId: 'cell-1',
        seq: 1,
        state: 'unconfirmed',
        outputsIncomplete: false,
        generation: 1,
      },
      {
        v: 1,
        t: 'output',
        executionId: id,
        eventSeq: 1,
        generation: 1,
        kind: 'output',
        output: { output_type: 'stream', name: 'stdout', text: '4\n' },
      },
      {
        v: 1,
        t: 'output',
        executionId: id,
        eventSeq: 2,
        generation: 1,
        kind: 'input_request',
        input: { prompt: 'Name? ', password: false },
        truncated: true,
      },
      { v: 1, t: 'kernel_state', state: 'waiting_for_input', generation: 1 },
      { v: 1, t: 'session_state', state: 'unconfirmed', cause: 'link_lost' },
      { v: 1, t: 'error', code: 'rate_limited', ref },
    ]) {
      expect(ChannelServerMessage.safeParse(message).success, JSON.stringify(message)).toBe(true);
    }
  });

  test('refuses an unknown state or error code', () => {
    expect(
      ChannelServerMessage.safeParse({ v: 1, t: 'kernel_state', state: 'running', generation: 0 })
        .success,
    ).toBe(false);
    expect(ChannelServerMessage.safeParse({ v: 1, t: 'error', code: 'nope' }).success).toBe(false);
  });
});
