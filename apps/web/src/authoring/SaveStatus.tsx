import buttons from '../components/Buttons.module.css';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import type { SaveState } from './autosave';

const clock = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Draft state as the server last acknowledged it; "Saved" only follows a real acknowledgement. */
export function SaveStatus({ state, onRetry }: { state: SaveState<unknown>; onRetry: () => void }) {
  let text = '';
  switch (state.kind) {
    case 'dirty':
      text = 'Unsaved changes';
      break;
    case 'saving':
      text = 'Saving…';
      break;
    case 'saved':
      text = `Draft saved at ${clock(state.at)}`;
      break;
    case 'partial':
      text = state.message;
      break;
    case 'conflict':
      text = 'Not saved: someone else changed this';
      break;
    default:
      break;
  }
  if (state.kind === 'error') {
    return (
      <div className={`${local.status} ${local.failure}`} role="alert">
        {state.message}{' '}
        <button type="button" className={buttons.textButton} onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className={`${local.status} ${state.kind === 'saved' ? local.success : ''}`} role="status">
      {text}
    </div>
  );
}
