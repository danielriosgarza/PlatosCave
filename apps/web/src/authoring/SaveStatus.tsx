import { SaveLine } from '../components/SaveLine';
import type { SaveState } from './autosave';

/** Draft state as the server last acknowledged it; "Saved" only follows a real acknowledgement. */
export function SaveStatus({ state, onRetry }: { state: SaveState<unknown>; onRetry: () => void }) {
  const note =
    state.kind === 'dirty'
      ? 'Unsaved changes'
      : state.kind === 'partial'
        ? state.message
        : state.kind === 'conflict'
          ? 'Not saved: someone else changed this'
          : null;
  return (
    <SaveLine
      status={
        state.kind === 'saving'
          ? 'saving'
          : state.kind === 'saved'
            ? 'saved'
            : state.kind === 'error'
              ? 'failed'
              : 'idle'
      }
      reason={state.kind === 'error' ? state.message : null}
      onRetry={onRetry}
      note={note}
      assertive
    />
  );
}
