import type { EditorView } from '@codemirror/view';

/** Lets the next Tab leave the editor instead of indenting. */
export function releaseTab(v: EditorView) {
  const dom = v.contentDOM;
  const hold = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    dom.removeEventListener('keydown', hold, true);
    event.stopImmediatePropagation();
  };
  dom.addEventListener('keydown', hold, true);
  window.setTimeout(() => dom.removeEventListener('keydown', hold, true), 3000);
}
