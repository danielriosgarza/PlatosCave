import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { releaseTab } from '../../components/releaseTab';
import styles from './Live.module.css';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Shift+Enter and Ctrl/Cmd+Enter. */
  onRun: () => void;
}

/**
 * One code cell's editor (CodeMirror 6, Python). Tab indents; Escape then Tab leaves the editor,
 * so it never traps the keyboard. Editing is always allowed, connected or not.
 */
export function CellEditor({ label, value, onChange, onRun }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  const run = useRef(onRun);
  const name = useRef(new Compartment());
  change.current = onChange;
  run.current = onRun;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once; `value` is synced below
  useEffect(() => {
    if (!host.current) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          indentUnit.of('    '),
          EditorState.tabSize.of(4),
          python(),
          keymap.of([
            {
              key: 'Shift-Enter',
              run: () => {
                run.current();
                return true;
              },
            },
            {
              key: 'Mod-Enter',
              run: () => {
                run.current();
                return true;
              },
            },
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
          name.current.of(
            EditorView.contentAttributes.of({
              'aria-label': label,
              'aria-multiline': 'true',
              spellcheck: 'false',
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);

  // The name follows the cell: its execution count changes when it runs.
  useEffect(() => {
    view.current?.dispatch({
      effects: name.current.reconfigure(
        EditorView.contentAttributes.of({
          'aria-label': label,
          'aria-multiline': 'true',
          spellcheck: 'false',
        }),
      ),
    });
  }, [label]);

  useEffect(() => {
    const current = view.current;
    if (current && current.state.doc.toString() !== value) {
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className={styles.editor} />;
}
