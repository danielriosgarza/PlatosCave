import { type ReactNode, useId } from 'react';
import buttons from '../components/Buttons.module.css';
import type { AttemptStep } from './attempt';
import styles from './Exercise.module.css';

type Option = { id: string; label: string };

/** The learner's unsent work on one step; its shape follows the step kind. */
export type Draft =
  | { kind: 'numeric'; text: string }
  | { kind: 'single_choice'; picked: string | null }
  | { kind: 'multiple_choice'; picked: string[] }
  | { kind: 'ordering'; order: string[] }
  | { kind: 'matching'; pairs: Record<string, string> }
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'simulation'; value: number };

/** Starts from what the server recorded last, so a wrong answer keeps the learner's work (§9). */
export function initialDraft(step: AttemptStep): Draft {
  const r = step.response;
  switch (step.kind) {
    case 'numeric':
      return { kind: 'numeric', text: typeof r === 'number' ? String(r) : '' };
    case 'single_choice':
      return { kind: 'single_choice', picked: typeof r === 'string' ? r : null };
    case 'multiple_choice':
      return { kind: 'multiple_choice', picked: Array.isArray(r) ? (r as string[]) : [] };
    case 'ordering':
      return {
        kind: 'ordering',
        order: Array.isArray(r) ? (r as string[]) : (step.options ?? []).map((o) => o.id),
      };
    case 'matching':
      return {
        kind: 'matching',
        pairs: r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, string>) : {},
      };
    case 'text':
      return { kind: 'text', text: typeof r === 'string' ? r : '' };
    case 'code':
      return { kind: 'code', text: typeof r === 'string' ? r : (step.starter ?? '') };
    case 'simulation': {
      const value =
        r && typeof r === 'object' && 'value' in r && typeof r.value === 'number'
          ? r.value
          : (step.control?.initial ?? 0);
      return { kind: 'simulation', value };
    }
  }
}

/**
 * Reads a typed number in the common forms: `1000.5`, `1,000.5`, `1.000,5`, `1000,5`, `1 000`.
 * The last of `.` and `,` is the decimal mark when both appear; a lone separator followed by
 * exactly three digits in every group is grouping (`1,000`, `1.000.000`), otherwise a lone
 * comma is a decimal comma. Returns null for anything else.
 */
export function parseNumber(text: string): number | null {
  let s = text.trim().replace(/(?<=\d)[\s\u00a0\u202f](?=\d{3}(?!\d))/g, '');
  // Grouped integers: one to three digits not starting with 0, then groups of exactly three.
  const grouped = (int: string, mark: string) =>
    new RegExp(`^[+-]?[1-9]\\d{0,2}(\\${mark}\\d{3})+$`).test(int);
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  if (dot !== -1 && comma !== -1) {
    const [decimal, group] = dot > comma ? ['.', ','] : [',', '.'];
    const at = s.lastIndexOf(decimal);
    const int = s.slice(0, at);
    if (!grouped(int, group)) return null;
    s = int.split(group).join('') + '.' + s.slice(at + 1);
  } else if (comma !== -1) {
    s = grouped(s, ',') ? s.replaceAll(',', '') : s.replace(',', '.');
  } else if (grouped(s, '.') && s.split('.').length > 2) {
    s = s.replaceAll('.', '');
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The response to send, or what is still missing. */
export function toResponse(
  step: AttemptStep,
  draft: Draft,
): { ok: true; response: unknown } | { ok: false; message: string } {
  switch (draft.kind) {
    case 'numeric': {
      const n = parseNumber(draft.text);
      return n !== null
        ? { ok: true, response: n }
        : { ok: false, message: 'Enter a number before checking it.' };
    }
    case 'single_choice':
      return draft.picked
        ? { ok: true, response: draft.picked }
        : { ok: false, message: 'Choose an answer before checking it.' };
    case 'multiple_choice':
      return draft.picked.length > 0
        ? { ok: true, response: draft.picked }
        : { ok: false, message: 'Choose at least one answer before checking it.' };
    case 'ordering':
      return { ok: true, response: draft.order };
    case 'matching':
      return (step.prompts ?? []).every((p) => draft.pairs[p.id])
        ? { ok: true, response: draft.pairs }
        : { ok: false, message: 'Match every item before checking it.' };
    case 'text':
      return draft.text.trim() !== ''
        ? { ok: true, response: draft.text }
        : { ok: false, message: 'Write your explanation first.' };
    case 'code':
      return { ok: true, response: draft.text };
    case 'simulation':
      return { ok: true, response: { value: draft.value, observations: {} } };
  }
}

interface FormProps {
  step: AttemptStep;
  draft: Draft;
  disabled: boolean;
  onChange: (draft: Draft) => void;
}

const num = (n: number) => String(Number(n.toFixed(6)));

export function StepForm({ step, draft, disabled, onChange }: FormProps) {
  const group = useId();
  const field = useId();
  switch (draft.kind) {
    case 'numeric':
      return (
        <div className={styles.field}>
          <label htmlFor={field}>Your answer{step.unit ? ` (${step.unit})` : ''}</label>
          <input
            id={field}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={draft.text}
            disabled={disabled}
            onChange={(e) => onChange({ kind: 'numeric', text: e.target.value })}
          />
        </div>
      );
    case 'single_choice':
    case 'multiple_choice': {
      const multiple = draft.kind === 'multiple_choice';
      const picked = multiple ? draft.picked : draft.picked ? [draft.picked] : [];
      const toggle = (id: string, on: boolean) =>
        onChange(
          multiple
            ? {
                kind: 'multiple_choice',
                picked: on ? [...picked, id] : picked.filter((p) => p !== id),
              }
            : { kind: 'single_choice', picked: id },
        );
      return (
        <fieldset className={styles.fieldset}>
          <legend className={styles.visuallyHidden}>{step.prompt}</legend>
          <div className={styles.options}>
            {(step.options ?? []).map((o: Option) => (
              <label key={o.id} className={styles.option}>
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  name={group}
                  value={o.id}
                  checked={picked.includes(o.id)}
                  disabled={disabled}
                  onChange={(e) => toggle(o.id, e.target.checked)}
                />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case 'ordering': {
      const labels = new Map((step.options ?? []).map((o) => [o.id, o.label]));
      const move = (i: number, by: -1 | 1) => {
        const order = [...draft.order];
        const [item] = order.splice(i, 1);
        if (item === undefined) return;
        order.splice(i + by, 0, item);
        onChange({ kind: 'ordering', order });
      };
      return (
        <div>
          <p className={`${styles.small} ${styles.centered}`}>
            Put the items in order with the move buttons.
          </p>
          <ol className={styles.sortable}>
            {draft.order.map((id, i) => (
              <li key={id}>
                <span>{labels.get(id) ?? id}</span>
                <span className={styles.nudge}>
                  <button
                    type="button"
                    className={buttons.outline}
                    disabled={disabled || i === 0}
                    aria-label={`Move ${labels.get(id) ?? id} up`}
                    onClick={() => move(i, -1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className={buttons.outline}
                    disabled={disabled || i === draft.order.length - 1}
                    aria-label={`Move ${labels.get(id) ?? id} down`}
                    onClick={() => move(i, 1)}
                  >
                    Down
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </div>
      );
    }
    case 'matching':
      return (
        <div className={styles.pairs}>
          {(step.prompts ?? []).map((p) => (
            <label key={p.id}>
              <span>{p.label}</span>
              <select
                value={draft.pairs[p.id] ?? ''}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ kind: 'matching', pairs: { ...draft.pairs, [p.id]: e.target.value } })
                }
              >
                <option value="" disabled>
                  Choose…
                </option>
                {(step.choices ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      );
    case 'text':
    case 'code':
      return (
        <div
          className={draft.kind === 'code' ? `${styles.explain} ${styles.code}` : styles.explain}
        >
          <label htmlFor={field} className={styles.small}>
            {draft.kind === 'code'
              ? `Your ${step.language === 'r' ? 'R' : 'Python'} code`
              : 'Your explanation'}
          </label>
          <textarea
            id={field}
            rows={draft.kind === 'code' ? 10 : 5}
            maxLength={step.maxLength}
            spellCheck={draft.kind === 'text'}
            placeholder={draft.kind === 'text' ? 'The distribution of sample means…' : undefined}
            value={draft.text}
            disabled={disabled}
            onChange={(e) => onChange({ kind: draft.kind, text: e.target.value })}
          />
        </div>
      );
    case 'simulation':
      return (
        <SimulationControl
          step={step}
          value={draft.value}
          disabled={disabled}
          onChange={(value) => onChange({ kind: 'simulation', value })}
        />
      );
  }
}

function SimulationControl({
  step,
  value,
  disabled,
  onChange,
}: {
  step: AttemptStep;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}): ReactNode {
  const id = useId();
  const control = step.control;
  if (!control) return null;
  // The last grid point min + k·step ≤ max: the server refuses values off the grid.
  const lastIndex = Math.floor((control.max - control.min) / control.step + 1e-9);
  const last = Number((control.min + lastIndex * control.step).toFixed(6));
  const clamp = (v: number) =>
    Math.min(lastIndex, Math.max(0, Math.round((v - control.min) / control.step))) * control.step +
    control.min;
  const set = (v: number) => onChange(Number(clamp(v).toFixed(6)));
  const compared = step.compared ?? [];
  return (
    <div className={styles.lab}>
      <div>
        <p className={`${styles.small} ${styles.muted}`}>{step.prompt}</p>
        <p className={styles.small}>
          Use the slider, the arrow keys, or the buttons to change the value, then record it.
        </p>
      </div>
      <div className={styles.range}>
        <label htmlFor={id} className={styles.between}>
          <span>{control.label}</span>
          <strong>{`${control.name} = ${num(value)}`}</strong>
        </label>
        <input
          id={id}
          type="range"
          min={control.min}
          max={last}
          step={control.step}
          value={value}
          disabled={disabled}
          aria-valuetext={`${control.label} ${num(value)}`}
          onChange={(e) => set(Number(e.target.value))}
        />
        <div className={`${styles.between} ${styles.small} ${styles.muted}`}>
          <span>{num(control.min)}</span>
          <span>{num(last)}</span>
        </div>
        <div className={styles.nudge}>
          <button
            type="button"
            className={buttons.outline}
            disabled={disabled || value <= control.min}
            onClick={() => set(value - control.step)}
          >
            Decrease
          </button>
          <button
            type="button"
            className={buttons.outline}
            disabled={disabled || value >= last}
            onClick={() => set(value + control.step)}
          >
            Increase
          </button>
        </div>
        <div className={styles.readout}>
          {control.label}: <strong>{num(value)}</strong>
          <ul aria-label="Values recorded for comparison">
            {(step.compare ?? []).map((c) => (
              <li key={c}>
                {control.name} = {num(c)} · {compared.includes(c) ? 'recorded' : 'not yet recorded'}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
