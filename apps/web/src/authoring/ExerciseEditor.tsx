import { type draftResource, getResource, updateResource } from '@parallax/contracts/routes/drafts';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import type { z } from 'zod';
import { call } from '../api/client';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { LocalProblem, useAutosave } from './autosave';
import { ConflictView } from './ConflictView';
import {
  blankStep,
  type DraftExercise,
  type DraftStep,
  type HintPolicy,
  kindNames,
  nextId,
  problemsOf,
  type Row,
  type StepKind,
  toContent,
  toDraft,
} from './exerciseForm';
import { authoringKey } from './queries';
import { SaveStatus } from './SaveStatus';

type Full = z.output<typeof draftResource>;

interface Values {
  title: string;
  visibility: 'visible' | 'hidden';
  archived: boolean;
  exercise: DraftExercise;
}

const toValues = (r: Full): Values => ({
  title: r.title,
  visibility: r.visibility,
  archived: r.archived,
  exercise: toDraft(r.head?.content),
});

export function ExerciseEditor({
  courseId,
  resourceId,
  onSaved,
}: {
  courseId: string;
  resourceId: string;
  onSaved: () => void;
}) {
  const loaded = useQuery({
    queryKey: [...authoringKey(courseId), 'resource', resourceId],
    queryFn: () => call(getResource, { params: { courseId, resourceId } }),
    gcTime: 0,
  });
  if (loaded.isError)
    return (
      <p role="alert" className={styles.small}>
        This exercise could not be loaded.
      </p>
    );
  if (!loaded.data) return <p className={`${styles.small} ${styles.muted}`}>Loading…</p>;
  return <ExerciseFields courseId={courseId} server={loaded.data} onSaved={onSaved} />;
}

const policyNames: Record<HintPolicy, string> = {
  free: 'Hints do not change the credit',
  reduces_credit: 'Each step solved with hints earns reduced credit',
  forfeits_credit: 'A step solved with hints earns no credit',
};

function ExerciseFields({
  courseId,
  server,
  onSaved,
}: {
  courseId: string;
  server: Full;
  onSaved: () => void;
}) {
  const { values, change, state, retry, takeTheirs, keepMine } = useAutosave({
    server,
    toValues,
    save: (v, expectedRevision) => {
      // A half-finished form stays on screen; only a valid definition becomes a revision.
      const problems = problemsOf(v.exercise);
      if (problems.length) throw new LocalProblem(`Not saved yet: ${problems[0]}`);
      return call(updateResource, {
        params: { courseId, resourceId: server.id },
        body: {
          expectedRevision,
          title: v.title.trim() || server.title,
          visibility: v.visibility,
          archived: v.archived,
          content: toContent(v.exercise) as Record<string, unknown>,
        },
      });
    },
    onSaved,
  });
  const { exercise } = values;
  const problems = problemsOf(exercise);
  const setExercise = (patch: Partial<DraftExercise>) =>
    change({ exercise: { ...exercise, ...patch } });
  const setStep = (index: number, step: DraftStep) =>
    setExercise({ steps: exercise.steps.map((s, i) => (i === index ? step : s)) });
  const move = (index: number, by: number) => {
    const steps = [...exercise.steps];
    const [step] = steps.splice(index, 1);
    if (step) steps.splice(index + by, 0, step);
    setExercise({ steps });
  };
  const rows = (theirs: Full) => {
    const t = toValues(theirs);
    return (
      [
        ['Title', values.title, t.title],
        ['Visibility', values.visibility, t.visibility],
        ['Steps', JSON.stringify(toContent(exercise)), JSON.stringify(toContent(t.exercise))],
      ] as const
    )
      .filter(([, a, b]) => a !== b)
      .map(([label, mine, other]) => ({
        label,
        mine: label === 'Steps' ? `${exercise.steps.length} steps` : mine,
        theirs: label === 'Steps' ? `${t.exercise.steps.length} steps` : other,
      }));
  };
  const [addKind, setAddKind] = useState<StepKind>('single_choice');

  return (
    <div>
      <SaveStatus state={state} onRetry={retry} />
      {state.kind === 'conflict' ? (
        <ConflictView
          what="exercise"
          rows={rows(state.current)}
          onKeepMine={() => keepMine(state.current)}
          onUseTheirs={() => takeTheirs(state.current)}
        />
      ) : null}
      {problems.length > 0 ? (
        <div className={local.hint} role="status" aria-label="Exercise problems">
          Not valid yet — this exercise cannot be published until these are fixed:
          <ul className={local.issues}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Text label="Exercise title" value={values.title} onChange={(v) => change({ title: v })} />
      <label className={local.field}>
        Visibility
        <select
          value={values.visibility}
          onChange={(e) => change({ visibility: e.target.value as Values['visibility'] })}
        >
          <option value="visible">Visible to students</option>
          <option value="hidden">Hidden from students</option>
        </select>
      </label>

      <fieldset className={local.choices}>
        <legend>Credit</legend>
        <Text
          label="Points (leave empty for ungraded practice)"
          value={exercise.points}
          inputMode="decimal"
          onChange={(v) => setExercise({ points: v })}
        />
        {exercise.points.trim() !== '' ? (
          <label className={local.field}>
            Hint policy
            <select
              value={exercise.hintPolicy}
              onChange={(e) => setExercise({ hintPolicy: e.target.value as HintPolicy })}
            >
              {Object.entries(policyNames).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className={local.hint}>Students see this exercise as ungraded practice.</p>
        )}
      </fieldset>

      {exercise.steps.map((step, index) => (
        <StepEditor
          key={step.id}
          index={index}
          count={exercise.steps.length}
          step={step}
          onChange={(s) => setStep(index, s)}
          onMove={(by) => move(index, by)}
          onRemove={() => setExercise({ steps: exercise.steps.filter((_, i) => i !== index) })}
        />
      ))}

      <div className={styles.row} style={{ marginTop: 20 }}>
        <label>
          Step type{' '}
          <select value={addKind} onChange={(e) => setAddKind(e.target.value as StepKind)}>
            {Object.entries(kindNames).map(([kind, name]) => (
              <option key={kind} value={kind}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={styles.outline}
          disabled={exercise.steps.length >= 20}
          onClick={() =>
            setExercise({
              steps: [
                ...exercise.steps,
                blankStep(
                  addKind,
                  exercise.steps.map((s) => s.id),
                ),
              ],
            })
          }
        >
          Add step
        </button>
      </div>
      <div className={styles.row} style={{ marginTop: 16 }}>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => change({ archived: !values.archived })}
        >
          {values.archived ? 'Restore this exercise' : 'Archive this exercise'}
        </button>
      </div>
    </div>
  );
}

function Text({
  label,
  value,
  onChange,
  inputMode,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputMode?: 'decimal';
  hint?: string;
}) {
  return (
    <label className={local.field}>
      {label}
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span className={local.hint}>{hint}</span> : null}
    </label>
  );
}

function Area({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className={local.field}>
      <label htmlFor={id}>{label}</label>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={local.choice}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function StepEditor({
  index,
  count,
  step,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  step: DraftStep;
  onChange: (s: DraftStep) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<DraftStep>) => onChange({ ...step, ...patch });
  const n = index + 1;
  return (
    <fieldset className={local.choices} aria-label={`Step ${n}`}>
      <legend>
        Step {n} · {kindNames[step.kind]}
      </legend>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.textButton}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          Move step {n} up
        </button>
        <button
          type="button"
          className={styles.textButton}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          Move step {n} down
        </button>
        <button
          type="button"
          className={styles.textButton}
          disabled={count === 1}
          onClick={onRemove}
        >
          Remove step {n}
        </button>
      </div>
      <Text label={`Step ${n} title`} value={step.title} onChange={(v) => set({ title: v })} />
      <Area label={`Step ${n} prompt`} value={step.prompt} onChange={(v) => set({ prompt: v })} />
      <KindFields n={n} step={step} set={set} />
      <Hints n={n} hints={step.hints} onChange={(hints) => set({ hints })} />
      <Area
        label={`Step ${n} solution (shown by Show solution)`}
        value={step.solution}
        onChange={(v) => set({ solution: v })}
      />
    </fieldset>
  );
}

function Hints({
  n,
  hints,
  onChange,
}: {
  n: number;
  hints: string[];
  onChange: (hints: string[]) => void;
}) {
  return (
    <div>
      {hints.map((hint, i) => (
        // Hints are positional (revealed in sequence), so the index is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={i} className={styles.row}>
          <Text
            label={`Step ${n} hint ${i + 1}`}
            value={hint}
            onChange={(v) => onChange(hints.map((h, j) => (j === i ? v : h)))}
          />
          <button
            type="button"
            className={styles.textButton}
            onClick={() => onChange(hints.filter((_, j) => j !== i))}
          >
            Remove hint {i + 1} of step {n}
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.textButton}
        disabled={hints.length >= 10}
        onClick={() => onChange([...hints, ''])}
      >
        Add hint to step {n}
      </button>
    </div>
  );
}

function RowList({
  n,
  noun,
  rows,
  onChange,
  extraLabel,
  mark,
  single,
  minRows = 2,
}: {
  n: number;
  noun: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  extraLabel?: string;
  /** Label of the "correct" checkbox, for choice steps. */
  mark?: string;
  single?: boolean;
  minRows?: number;
}) {
  const update = (i: number, patch: Partial<Row>) =>
    onChange(
      rows.map((r, j) => {
        if (j === i) return { ...r, ...patch };
        return single && patch.correct ? { ...r, correct: false } : r;
      }),
    );
  return (
    <div>
      {rows.map((row, i) => (
        <div key={row.id} className={styles.row}>
          <Text
            label={`Step ${n} ${noun} ${i + 1}`}
            value={row.label}
            onChange={(v) => update(i, { label: v })}
          />
          {extraLabel ? (
            <Text
              label={`Step ${n} ${noun} ${i + 1} ${extraLabel}`}
              value={row.extra}
              onChange={(v) => update(i, { extra: v })}
            />
          ) : null}
          {mark ? (
            <Check
              label={`${mark} ${i + 1} of step ${n}`}
              checked={row.correct}
              onChange={(v) => update(i, { correct: v })}
            />
          ) : null}
          <button
            type="button"
            className={styles.textButton}
            disabled={rows.length <= minRows}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            Remove {noun} {i + 1} of step {n}
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.textButton}
        onClick={() =>
          onChange([
            ...rows,
            {
              id: nextId(
                'o',
                rows.map((r) => r.id),
              ),
              label: '',
              extra: '',
              correct: false,
            },
          ])
        }
      >
        Add {noun} to step {n}
      </button>
    </div>
  );
}

function KindFields({
  n,
  step,
  set,
}: {
  n: number;
  step: DraftStep;
  set: (patch: Partial<DraftStep>) => void;
}): ReactNode {
  const feedback = (fields: [keyof DraftStep, string][]) =>
    fields.map(([key, label]) => (
      <Area
        key={key}
        label={`Step ${n} ${label}`}
        value={step[key] as string}
        onChange={(v) => set({ [key]: v })}
      />
    ));
  const shuffle = (
    <Check
      label={`Shuffle step ${n} for each attempt`}
      checked={step.shuffle}
      onChange={(v) => set({ shuffle: v })}
    />
  );
  switch (step.kind) {
    case 'numeric':
      return (
        <>
          <Text
            label={`Step ${n} correct answer`}
            inputMode="decimal"
            value={step.answer}
            onChange={(v) => set({ answer: v })}
          />
          <Text
            label={`Step ${n} tolerance`}
            inputMode="decimal"
            value={step.tolerance}
            hint="Answers within this distance of the correct answer are accepted."
            onChange={(v) => set({ tolerance: v })}
          />
          <Text label={`Step ${n} unit`} value={step.unit} onChange={(v) => set({ unit: v })} />
          {feedback([
            ['correct', 'feedback when correct'],
            ['incorrect', 'feedback when incorrect'],
            ['low', 'feedback when too low (optional)'],
            ['high', 'feedback when too high (optional)'],
          ])}
        </>
      );
    case 'single_choice':
    case 'multiple_choice':
      return (
        <>
          <RowList
            n={n}
            noun="option"
            rows={step.rows}
            extraLabel="feedback (optional)"
            mark="Correct option"
            single={step.kind === 'single_choice'}
            onChange={(rows) => set({ rows })}
          />
          {shuffle}
          {feedback([
            ['correct', 'feedback when correct'],
            ['incorrect', 'feedback when incorrect'],
          ])}
        </>
      );
    case 'ordering':
      return (
        <>
          <p className={local.hint}>List the items in their correct order.</p>
          <RowList n={n} noun="item" rows={step.rows} onChange={(rows) => set({ rows })} />
          {shuffle}
          {feedback([
            ['correct', 'feedback when correct'],
            ['incorrect', 'feedback when incorrect'],
          ])}
        </>
      );
    case 'matching':
      return (
        <>
          <RowList
            n={n}
            noun="prompt"
            rows={step.rows}
            extraLabel="matching choice"
            onChange={(rows) => set({ rows })}
          />
          {shuffle}
          {feedback([
            ['correct', 'feedback when correct'],
            ['incorrect', 'feedback when incorrect'],
          ])}
        </>
      );
    case 'text':
      return (
        <>
          <Text
            label={`Step ${n} maximum length`}
            inputMode="decimal"
            value={step.maxLength}
            onChange={(v) => set({ maxLength: v })}
          />
          {feedback([['saved', 'feedback when saved']])}
        </>
      );
    case 'simulation':
      return (
        <>
          <Text
            label={`Step ${n} control label`}
            value={step.controlLabel}
            onChange={(v) => set({ controlLabel: v })}
          />
          <div className={styles.row}>
            {(
              [
                ['min', 'minimum'],
                ['max', 'maximum'],
                ['stepSize', 'increment'],
                ['initial', 'starting value'],
              ] as const
            ).map(([key, label]) => (
              <Text
                key={key}
                label={`Step ${n} ${label}`}
                inputMode="decimal"
                value={step[key]}
                onChange={(v) => set({ [key]: v })}
              />
            ))}
          </div>
          <Text
            label={`Step ${n} values to compare`}
            value={step.compare}
            hint="Comma-separated. The step completes once each has been checked; each must be a value the control offers."
            onChange={(v) => set({ compare: v })}
          />
          <p className={local.hint}>Observations the student can read (only these are recorded).</p>
          <RowList
            n={n}
            noun="observation"
            rows={step.rows}
            extraLabel="unit (optional)"
            minRows={0}
            onChange={(rows) => set({ rows })}
          />
          {feedback([
            ['correct', 'feedback when complete'],
            ['incomplete', 'feedback when incomplete'],
          ])}
        </>
      );
    case 'code':
      return (
        <>
          <label className={local.field}>
            Step {n} language
            <select
              value={step.language}
              onChange={(e) => set({ language: e.target.value as 'python' | 'r' })}
            >
              <option value="python">Python</option>
              <option value="r">R</option>
            </select>
          </label>
          <Area
            label={`Step ${n} starter code`}
            value={step.starter}
            onChange={(v) => set({ starter: v })}
          />
          {feedback([['saved', 'feedback when saved']])}
        </>
      );
  }
}
