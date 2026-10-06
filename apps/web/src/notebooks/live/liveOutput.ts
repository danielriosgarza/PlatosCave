import type { LiveOutput } from '@parallax/contracts';

/**
 * What a live output becomes before anything is shown (docs/design/connector.md §10.4, §14; the
 * A09 suite). A kernel's output is untrusted. ADR-0002 keeps notebook HTML, SVG and images on the
 * content origin, and live output has no route there yet (P3-08a), so nothing of the kind is
 * rendered on the app origin: text and errors are shown as text, and a rich output shows its
 * `text/plain` alternative when it has one and is otherwise named, never run.
 */

/** The most text one execution shows; the rest is dropped and the cell says so. */
export const MAX_LIVE_TEXT_CHARS = 50_000;

export type ShownOutput =
  | { kind: 'text'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'error'; name: string; value: string; traceback: string }
  /** A rich output Parallax does not render here; its plain-text alternative, if any, is kept. */
  | { kind: 'withheld'; mimeTypes: string[]; text: string | null };

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text: string) => text.replace(ANSI, '');

const asText = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? value.join('')
      : null;

/** What to show for one kernel output. */
export function shownOutput(output: LiveOutput): ShownOutput {
  switch (output.output_type) {
    case 'stream':
      return { kind: 'text', stream: output.name, text: stripAnsi(output.text) };
    case 'error':
      return {
        kind: 'error',
        name: stripAnsi(output.ename),
        value: stripAnsi(output.evalue),
        traceback: stripAnsi(output.traceback.join('\n')),
      };
    case 'display_data':
    case 'execute_result': {
      const plain = asText(output.data['text/plain']);
      const types = Object.keys(output.data).sort();
      // A result that is only its text (`2 + 2`) is just text.
      if (plain !== null && types.every((t) => t === 'text/plain')) {
        return { kind: 'text', stream: 'stdout', text: stripAnsi(plain) };
      }
      return {
        kind: 'withheld',
        mimeTypes: types.filter((t) => t !== 'text/plain'),
        text: plain === null ? null : stripAnsi(plain),
      };
    }
  }
}

export type GroupedOutput = ShownOutput & { key: number; generation: number };

/** Consecutive text of one stream joins into one block, as a terminal would show it. */
export function groupOutputs(
  items: { eventSeq: number; generation: number; output: LiveOutput }[],
): { shown: GroupedOutput[]; truncated: boolean } {
  const shown: GroupedOutput[] = [];
  // One budget for every text the execution shows: streams, tracebacks and plain alternatives.
  let chars = 0;
  let truncated = false;
  const take = (text: string) => {
    const room = Math.max(MAX_LIVE_TEXT_CHARS - chars, 0);
    if (text.length > room) truncated = true;
    const kept = text.slice(0, room);
    chars += kept.length;
    return kept;
  };
  for (const [index, item] of items.entries()) {
    const next = shownOutput(item.output);
    const base = { key: index, generation: item.generation };
    if (next.kind === 'text') {
      const text = take(next.text);
      const last = shown[shown.length - 1];
      if (
        last?.kind === 'text' &&
        last.stream === next.stream &&
        last.generation === item.generation
      ) {
        last.text += text;
      } else if (text.length > 0) {
        shown.push({ ...next, text, ...base });
      }
    } else if (next.kind === 'error') {
      shown.push({ ...next, traceback: take(next.traceback), ...base });
    } else {
      shown.push({ ...next, text: next.text === null ? null : take(next.text), ...base });
    }
  }
  return { shown, truncated };
}
