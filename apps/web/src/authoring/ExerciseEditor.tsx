import { type draftResource, getResource, updateResource } from '@parallax/contracts/routes/drafts';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import type { z } from 'zod';
import { call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { useAutosave } from './autosave';
import { ConflictView } from './ConflictView';
import {
  blankStep,
  type DraftExercise,
  type DraftStep,
  type HintPolicy,
  kindNames,
  nextId,
  presentedAsAnswer,
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

/** Whether the stored head can be published: absent, valid, or stored but no longer valid. */
type HeadState = 'none' | 'valid' | 'invalid';
function headOf(server: Full, valid?: boolean): HeadState {
  if (server.head === null) return 'none';
  return valid || toValues(server).exercise.loadProblems.length === 0 ? 'valid' : 'invalid';
}

function ExerciseFields({
  courseId,
  server,
  onSaved,
}: {
  courseId: string;
  server: Full;
  onSaved: () => void;
}) {
  const [head, setHead] = useState(() => headOf(server));
  const { values, change, state, retry, takeTheirs, keepMine } = useAutosave({
    server,
    toValues,
    save: async (v, expectedRevision) => {
      // Title, visibility and archive are saved whatever the steps look like; the steps become
      // a revision only once the whole definition is valid, so a half-finished form stays here.
      const valid = problemsOf(v.exercise).length === 0;
      const saved = await call(updateResource, {
        params: { courseId, resourceId: server.id },
        body: {
          expectedRevision,
          title: v.title.trim() || server.title,
          visibility: v.visibility,
          archived: v.archived,
          ...(valid && { content: toContent(v.exercise) as Record<string, unknown> }),
        },
      });
      // Content is sent only when valid, so a save that sent it leaves a valid head.
      setHead((prev) => (valid ? headOf(saved, true) : prev));
      return saved;
    },
    onSaved,
    partial: (v) =>
      problemsOf(v.exercise).length
        ? 'Title, visibility and archive state saved; step and credit edits are not saved yet'
        : undefined,
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
          onUseTheirs={() => {
            setHead(headOf(state.current));
            takeTheirs(state.current);
          }}
        />
      ) : null}
      {head === 'invalid' && exercise.loadProblems.length > 0 ? (
        <div className={local.hint} role="status" aria-label="Saved definition problems">
          The saved definition is no longer valid, so this form starts blank. Saving a new
          definition replaces it; the earlier revision is kept.
          <ul className={local.issues}>
            {exercise.loadProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <div className={local.hint} role="status" aria-label="Exercise problems">
          {head === 'invalid'
            ? 'Publishing is blocked until a valid definition is saved. Fix:'
            : head === 'valid'
              ? 'These step edits are not saved yet; publishing would release the last saved version. Fix:'
              : 'This exercise has no content yet and cannot be published. Fix:'}
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

      <div className={`${styles.row} ${styles.mt20}`}>
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
          className={buttons.outline}
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
      <div className={`${styles.row} ${styles.mt16}`}>
        <button
          type="button"
          className={buttons.textButton}
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
          className={buttons.textButton}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          Move step {n} up
        </button>
        <button
          type="button"
          className={buttons.textButton}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          Move step {n} down
        </button>
        <button
          type="button"
          className={buttons.textButton}
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
            className={buttons.textButton}
            onClick={() => onChange(hints.filter((_, j) => j !== i))}
          >
            Remove hint {i + 1} of step {n}
          </button>
        </div>
      ))}
      <button
        type="button"
        className={buttons.textButton}
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
  maxRows = 12,
  taken = [],
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
  /** The schema's limit on this list; Add is disabled at it. */
  maxRows?: number;
  /** Ids already used elsewhere in the step, so a new row never repeats one. */
  taken?: string[];
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
            className={buttons.textButton}
            disabled={rows.length <= minRows}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            Remove {noun} {i + 1} of step {n}
          </button>
        </div>
      ))}
      <button
        type="button"
        className={buttons.textButton}
        disabled={rows.length >= maxRows}
        onClick={() =>
          onChange([
            ...rows,
            {
              id: nextId('o', [...rows.map((r) => r.id), ...taken]),
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
          <p className={local.hint}>
            List the items in their correct order.
            {step.presented.length === 0
              ? ' Students see them in a different order for each attempt.'
              : step.shuffle
                ? ''
                : presentedAsAnswer(step)
                  ? ' Students will see them in this order, which is the correct order.'
                  : ' Students will see them in the order stored for this step, which is not the correct order.'}
          </p>
          <RowList n={n} noun="item" rows={step.rows} onChange={(rows) => set({ rows })} />
          {step.presented.length > 0 ? shuffle : null}
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
          <p className={local.hint}>Choices that match no prompt (optional).</p>
          <RowList
            n={n}
            noun="extra choice"
            rows={step.distractors}
            minRows={0}
            maxRows={12 - new Set(step.rows.map((r) => r.extra.trim()).filter(Boolean)).size}
            taken={step.rows.map((r) => r.choiceId ?? '')}
            onChange={(distractors) => set({ distractors })}
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
            maxRows={10}
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
