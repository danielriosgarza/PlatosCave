import { type ReactNode, useId } from 'react';
import local from './Authoring.module.css';

/** Labelled inputs of the test editor; every control has a visible label. */

export function Text({
  label,
  value,
  onChange,
  inputMode,
  hint,
  type = 'text',
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputMode?: 'decimal' | 'numeric';
  hint?: string;
  type?: 'text' | 'datetime-local';
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className={local.field}>
      {label}
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span className={local.hint}>{hint}</span> : null}
    </label>
  );
}

export function Area({
  label,
  value,
  onChange,
  mono,
  rows,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  rows?: number;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className={local.field}>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={rows}
        className={mono ? local.mono : undefined}
        spellCheck={mono ? false : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span className={local.hint}>{hint}</span> : null}
    </div>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <label className={local.field}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, name]) => (
          <option key={v} value={v}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Check({
  label,
  checked,
  onChange,
  type = 'checkbox',
  name,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  type?: 'checkbox' | 'radio';
  name?: string;
}) {
  return (
    <label className={local.choice}>
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/** Moves the item at `index` by `by` places; the list itself is not changed. */
export function moved<T>(list: readonly T[], index: number, by: number): T[] {
  const copy = [...list];
  const [item] = copy.splice(index, 1);
  if (item !== undefined) copy.splice(index + by, 0, item);
  return copy;
}

export const replaceAt = <T,>(list: readonly T[], index: number, item: T): T[] =>
  list.map((x, i) => (i === index ? item : x));
