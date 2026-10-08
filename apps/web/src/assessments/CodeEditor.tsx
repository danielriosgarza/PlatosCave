import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { EditorState, Transaction } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { releaseTab } from '../components/releaseTab';
import styles from './Test.module.css';

interface Props {
  /** Accessible name: the file and what it is, e.g. "solution.py, your implementation". */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Plain text area instead of the editor, for screen readers (§11). */
  plain: boolean;
  language: 'python' | 'r';
}

/**
 * The code editor (§11): line numbers, indentation, keyboard navigation. Tab indents; Escape then
 * Tab moves on, so the editor never traps the keyboard. With `plain` the same text is a native
 * text area, which screen readers handle best.
 */
export function CodeEditor({ label, value, onChange, plain, language }: Props) {
  if (plain) {
    return (
      <textarea
        className={styles.plainEditor}
        aria-label={label}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return <Editor label={label} value={value} onChange={onChange} language={language} />;
}

function Editor({ label, value, onChange, language }: Omit<Props, 'plain'>) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once; `value` is synced below
  useEffect(() => {
    if (!host.current) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          indentUnit.of('    '),
          EditorState.tabSize.of(4),
          ...(language === 'python' ? [python()] : []),
          keymap.of([
            // Escape releases Tab for the next key press, so keyboard users can leave the editor.
            {
              key: 'Escape',
              run: (v) => {
                releaseTab(v);
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.contentAttributes.of({
            'aria-label': label,
            'aria-multiline': 'true',
            spellcheck: 'false',
          }),
          EditorView.updateListener.of((update) => {
            // A value adopted from outside is not something the student typed.
            if (
              update.docChanged &&
              !update.transactions.some((t) => t.annotation(Transaction.remote))
            ) {
              change.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    // The scroller is a scrollable region: reach it by keyboard (axe scrollable-region-focusable).
    created.scrollDOM.tabIndex = 0;
    created.scrollDOM.setAttribute('role', 'group');
    created.scrollDOM.setAttribute('aria-label', `${label} (scrollable)`);
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);

  // A value that changes from outside (a restored draft) replaces the document.
  useEffect(() => {
    const current = view.current;
    if (current && current.state.doc.toString() !== value) {
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: value },
        // Not undoable: an undo would bring back older local text and save it over the newer one.
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
      });
    }
  }, [value]);

  return <div ref={host} className={styles.cm} />;
}
