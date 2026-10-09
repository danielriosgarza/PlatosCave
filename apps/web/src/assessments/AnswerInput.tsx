import { useEffect, useState } from 'react';
import buttons from '../components/Buttons.module.css';
import { downloadText } from '../format/format';
import { type CodeFile, codeFilesOf } from './answers';
import type { CodeQuestionView, Question } from './api';
import { CodeEditor } from './CodeEditor';
import { RunPanel } from './RunPanel';
import styles from './Test.module.css';

const SR_KEY = 'pc-test-screen-reader';
function readSr(): boolean {
  try {
    return window.localStorage.getItem(SR_KEY) === '1';
  } catch {
    return false;
  }
}

interface Common {
  classId: string;
  attemptId: string;
  value: unknown;
  onChange: (value: unknown) => void;
  flush: () => Promise<string[]>;
  onClosed: () => void;
}

/** The working area of one question, by answer type (§11). */
export function AnswerInput({ question, ...rest }: Common & { question: Question }) {
  switch (question.kind) {
    case 'choice':
      return <ChoiceInput question={question} {...rest} />;
    case 'numeric':
      return <NumericInput question={question} {...rest} />;
    case 'explanation':
      return <ExplanationInput question={question} {...rest} />;
    case 'code':
      return <CodeInput question={question} {...rest} />;
  }
}

function ChoiceInput({
  question,
  value,
  onChange,
}: Common & { question: Extract<Question, { kind: 'choice' }> }) {
  const chosen = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (id: string) => {
    if (!question.multiple) return onChange([id]);
    onChange(chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id]);
  };
  return (
    <fieldset className={styles.options}>
      <legend>{question.multiple ? 'Choose all that apply' : 'Choose one'}</legend>
      {question.options.map((o) => (
        <label key={o.id} className={styles.option}>
          <input
            type={question.multiple ? 'checkbox' : 'radio'}
            name={`q-${question.id}`}
            checked={chosen.includes(o.id)}
            onChange={() => toggle(o.id)}
          />
          <span>{o.label}</span>
        </label>
      ))}
      {!question.multiple && chosen.length > 0 ? (
        <button type="button" className={buttons.textButton} onClick={() => onChange(null)}>
          Clear choice
        </button>
      ) : null}
    </fieldset>
  );
}

/**
 * What a person typed for a number. `value` is null for an empty field, NaN when it is not a
 * number. `ambiguous` is set only for text that would be a number under either reading of its
 * comma ("1,000", "1,000.5", "1,2,3"): the saved number would depend on a guess, so none is read.
 */
function readNumeric(text: string): { value: number | null; ambiguous: boolean } {
  const t = text.trim();
  if (t === '') return { value: null, ambiguous: false };
  const comma = t.includes(',');
  const ambiguous =
    comma &&
    /^[+-]?[\d.,]+([eE][+-]?\d+)?$/.test(t) &&
    !/(^|[^\d]),|,([^\d]|$)/.test(t) &&
    (t.includes('.') || t.indexOf(',') !== t.lastIndexOf(',') || /,\d{3}(?!\d)/.test(t));
  if (ambiguous) return { value: Number.NaN, ambiguous };
  const n = t.replace(',', '.');
  return {
    value: /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(n) ? Number(n) : Number.NaN,
    ambiguous,
  };
}

/** Accepts what a person types for a number; null when the field is empty, NaN when it is not one. */
const parseNumeric = (text: string): number | null => readNumeric(text).value;

function NumericInput({
  question,
  value,
  onChange,
}: Common & { question: Extract<Question, { kind: 'numeric' }> }) {
  // The text is kept as typed: "1." and "-" are steps towards a number, not mistakes.
  const [text, setText] = useState(typeof value === 'number' ? String(value) : '');
  const { value: parsed, ambiguous } = readNumeric(text);
  const invalid = Number.isNaN(parsed);
  const id = `num-${question.id}`;
  // A value adopted from the server after a reconnect replaces the text; typing never gets here,
  // because the value then equals what the text parses to. Text that is not a number yet ("-",
  // "1.5e", an ambiguous "1,000") is the student's work in progress and stays.
  useEffect(() => {
    const incoming = typeof value === 'number' ? value : null;
    setText((current) => {
      const read = parseNumeric(current);
      return Number.isNaN(read) || read === incoming
        ? current
        : incoming === null
          ? ''
          : String(incoming);
    });
  }, [value]);
  return (
    <div className={styles.field}>
      <label htmlFor={id}>Your answer{question.unit ? ` (${question.unit})` : ''}</label>
      <div>
        <input
          id={id}
          className={styles.numeric}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            const next = readNumeric(e.target.value);
            // An ambiguous text clears the saved answer, so no guessed prefix such as "1" for
            // "1,000" stays saved (or is submitted) while the error is showing.
            if (next.ambiguous) onChange(null);
            else if (!Number.isNaN(next.value)) onChange(next.value);
          }}
        />
      </div>
      {invalid ? (
        <p className={styles.error} id={`${id}-error`}>
          {ambiguous
            ? 'A comma can mean thousands or a decimal point. Write 1000 or 1.5 without separators. Your saved answer is cleared until you do.'
            : 'Enter a number. This text is not saved yet.'}
        </p>
      ) : null}
    </div>
  );
}

function ExplanationInput({
  question,
  value,
  onChange,
}: Common & { question: Extract<Question, { kind: 'explanation' }> }) {
  const text = typeof value === 'string' ? value : '';
  const id = `exp-${question.id}`;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>Your explanation</label>
      <textarea
        id={id}
        className={styles.explain}
        value={text}
        maxLength={question.maxLength}
        aria-describedby={`${id}-count`}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      />
      <span id={`${id}-count`} className={`${styles.small} ${styles.muted}`}>
        {text.length} of {question.maxLength} characters
      </span>
    </div>
  );
}

function CodeInput({
  question,
  value,
  onChange,
  classId,
  attemptId,
  flush,
  onClosed,
}: Common & { question: CodeQuestionView }) {
  const files = codeFilesOf(question, value);
  const [active, setActive] = useState(files[0]?.path ?? '');
  const [plain, setPlain] = useState(readSr);
  // A question change selects its first file; the keyed parent normally remounts, this is the guard.
  useEffect(() => {
    if (!files.some((f) => f.path === active)) setActive(files[0]?.path ?? '');
  }, [files, active]);
  const file = files.find((f) => f.path === active) ?? files[0];
  const readOnly = question.files.filter((f) => !f.editable);
  if (!file) return null;
  const setContent = (content: string) =>
    onChange({
      files: files.map((f): CodeFile => (f.path === file.path ? { ...f, content } : f)),
    });
  const language = question.runtime.startsWith('r-') ? 'r' : 'python';
  const toggleSr = () => {
    const next = !plain;
    setPlain(next);
    try {
      window.localStorage.setItem(SR_KEY, next ? '1' : '0');
    } catch {
      // The choice lasts for this visit only.
    }
  };
  return (
    <div>
      {files.length > 1 ? (
        <fieldset className={`${styles.row} ${styles.files}`}>
          <legend className={styles.small}>Files</legend>
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              className={buttons.outline}
              aria-pressed={f.path === file.path}
              onClick={() => setActive(f.path)}
            >
              {f.path}
            </button>
          ))}
        </fieldset>
      ) : null}
      <div className={styles.editorHead}>
        <span>{file.path}</span>
        <span className={styles.row}>
          <button
            type="button"
            className={buttons.textButton}
            aria-pressed={plain}
            onClick={toggleSr}
          >
            Screen-reader mode: {plain ? 'on' : 'off'}
          </button>
          <button
            type="button"
            className={buttons.textButton}
            onClick={() => downloadText(file.path, file.content)}
          >
            Download draft
          </button>
        </span>
      </div>
      <CodeEditor
        key={`${file.path}-${plain ? 'plain' : 'cm'}`}
        label={`${file.path}, your implementation`}
        value={file.content}
        onChange={setContent}
        plain={plain}
        language={language}
      />
      <p className={`${styles.small} ${styles.muted}`}>
        {plain
          ? 'Plain text area: Tab moves to the next control.'
          : 'Tab indents. Press Escape, then Tab, to leave the editor.'}
      </p>
      {readOnly.length > 0 ? (
        <p className={`${styles.small} ${styles.muted}`}>
          Provided files, not editable: {readOnly.map((f) => f.path).join(', ')}
        </p>
      ) : null}
      <RunPanel
        classId={classId}
        attemptId={attemptId}
        question={question}
        files={files}
        flush={flush}
        onClosed={onClosed}
      />
    </div>
  );
}
