import { type draftResource, getResource, updateResource } from '@parallax/contracts/routes/drafts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { useAutosave } from './autosave';
import { CodeQuestionEditor } from './CodeQuestionEditor';
import { ConflictView } from './ConflictView';
import { PreviewRunPanel } from './PreviewRunPanel';
import { authoringKey, validationQuery } from './queries';
import { SaveStatus } from './SaveStatus';
import { Area, Check, moved, replaceAt, Select, Text } from './TestFields';
import {
  blankQuestion,
  type DraftCriterion,
  type DraftQuestion,
  type DraftSettings,
  type DraftTest,
  nextOptionId,
  nextQuestionId,
  problemsOf,
  type QuestionKind,
  toContent,
  toDraft,
} from './testForm';

type Full = z.output<typeof draftResource>;

interface Values {
  title: string;
  visibility: 'visible' | 'hidden';
  archived: boolean;
  test: DraftTest;
}

const toValues = (r: Full): Values => ({
  title: r.title,
  visibility: r.visibility,
  archived: r.archived,
  test: toDraft(r.head?.content),
});

const kindNames: Record<QuestionKind, string> = {
  choice: 'Quiz (choice)',
  numeric: 'Numeric answer',
  explanation: 'Explanation',
  code: 'Code',
};

export function TestEditor({
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
        This test could not be loaded.
      </p>
    );
  if (!loaded.data) return <p className={`${styles.small} ${styles.muted}`}>Loading…</p>;
  return <TestFields courseId={courseId} server={loaded.data} onSaved={onSaved} />;
}

function TestFields({
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
    save: async (v, expectedRevision) => {
      // Title, visibility and archive state are saved whatever the questions look like; the
      // questions become a revision only once the whole test is valid.
      const built = problemsOf(v.test).length === 0 ? toContent(v.test) : undefined;
      return call(updateResource, {
        params: { courseId, resourceId: server.id },
        body: {
          expectedRevision,
          title: v.title.trim() || server.title,
          visibility: v.visibility,
          archived: v.archived,
          ...(built && 'content' in built && { content: built.content as Record<string, unknown> }),
        },
      });
    },
    onSaved,
    partial: (v) =>
      problemsOf(v.test).length
        ? 'Title, visibility and archive state saved; question and setting edits are not saved yet'
        : undefined,
  });
  const { test } = values;
  const problems = problemsOf(test);
  const setTest = (patch: Partial<DraftTest>) => change({ test: { ...test, ...patch } });
  const setQuestion = (i: number, patch: Partial<DraftQuestion>) =>
    setTest({
      questions: replaceAt(test.questions, i, {
        ...(test.questions[i] as DraftQuestion),
        ...patch,
      }),
    });
  const [addKind, setAddKind] = useState<QuestionKind>('choice');
  // The form matches the saved revision when nothing is waiting to be sent and it is valid.
  const saved = state.kind === 'saved' || state.kind === 'idle';
  const rows = (theirs: Full) => {
    const t = toValues(theirs);
    return (
      [
        ['Title', values.title, t.title],
        ['Visibility', values.visibility, t.visibility],
        [
          'Questions and settings',
          JSON.stringify(toContent(test)),
          JSON.stringify(toContent(t.test)),
        ],
      ] as const
    )
      .filter(([, a, b]) => a !== b)
      .map(([label, mine, other]) => ({
        label,
        mine: label === 'Questions and settings' ? `${test.questions.length} questions` : mine,
        theirs: label === 'Questions and settings' ? `${t.test.questions.length} questions` : other,
      }));
  };

  return (
    <div>
      <SaveStatus state={state} onRetry={retry} />
      {state.kind === 'conflict' ? (
        <ConflictView
          what="test"
          rows={rows(state.current)}
          onKeepMine={() => keepMine(state.current)}
          onUseTheirs={() => takeTheirs(state.current)}
        />
      ) : null}
      {problems.length > 0 ? (
        <div className={local.hint} role="status" aria-label="Test problems">
          {server.head
            ? 'These edits are not saved yet; publishing would release the last saved version. Fix:'
            : 'This test has no saved content yet and cannot be published. Fix:'}
          <ul className={local.issues}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <PublicationCheck courseId={courseId} resourceId={server.id} />
      <Text label="Test title" value={values.title} onChange={(v) => change({ title: v })} />
      <Select
        label="Visibility"
        value={values.visibility}
        onChange={(v) => change({ visibility: v })}
        options={[
          ['visible', 'Visible to students'],
          ['hidden', 'Hidden from students'],
        ]}
      />

      <SettingsEditor
        settings={test.settings}
        onChange={(patch) => setTest({ settings: { ...test.settings, ...patch } })}
      />

      {test.questions.map((q, i) => (
        <QuestionEditor
          key={q.uid}
          index={i}
          count={test.questions.length}
          question={q}
          courseId={courseId}
          resourceId={server.id}
          saved={saved && problems.length === 0}
          onChange={(patch) => setQuestion(i, patch)}
          onMove={(by) => setTest({ questions: moved(test.questions, i, by) })}
          onRemove={() => setTest({ questions: test.questions.filter((_, j) => j !== i) })}
        />
      ))}

      <div className={`${styles.row} ${styles.mt20}`}>
        <Select
          label="Question type"
          value={addKind}
          onChange={setAddKind}
          options={Object.entries(kindNames) as [QuestionKind, string][]}
        />
        <button
          type="button"
          className={buttons.outline}
          disabled={test.questions.length >= 100}
          onClick={() =>
            setTest({
              questions: [
                ...test.questions,
                blankQuestion(addKind, nextQuestionId(test.questions)),
              ],
            })
          }
        >
          Add question
        </button>
      </div>
      <div className={`${styles.row} ${styles.mt16}`}>
        <button
          type="button"
          className={buttons.textButton}
          onClick={() => change({ archived: !values.archived })}
        >
          {values.archived ? 'Restore this test' : 'Archive this test'}
        </button>
      </div>
    </div>
  );
}

/** What publication says about the saved version of this test: errors block, warnings do not. */
function PublicationCheck({ courseId, resourceId }: { courseId: string; resourceId: string }) {
  const report = useQuery(validationQuery(courseId));
  if (!report.data) return null;
  const mine = (i: { resourceId?: string | undefined }) => i.resourceId === resourceId;
  const errors = report.data.errors.filter(mine);
  const warnings = report.data.warnings.filter(mine);
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <div className={local.hint} role="status" aria-label="Publication check">
      {errors.length > 0 ? 'The saved test cannot be published yet:' : 'Publication warnings:'}
      <ul className={local.issues}>
        {errors.map((e) => (
          <li key={e.message}>{e.message}</li>
        ))}
        {warnings.map((w) => (
          <li key={w.message}>Warning: {w.message}</li>
        ))}
      </ul>
    </div>
  );
}

function SettingsEditor({
  settings: s,
  onChange,
}: {
  settings: DraftSettings;
  onChange: (patch: Partial<DraftSettings>) => void;
}) {
  return (
    <fieldset className={local.choices}>
      <legend>Attempts, timing and release</legend>
      <p className={local.hint}>
        Defaults for the assignment; a class can override them before it uses a release. Times are
        entered in your browser’s time zone.
      </p>
      <div className={local.inlineFields}>
        <Text
          label="Attempts allowed"
          inputMode="numeric"
          value={s.attempts}
          onChange={(v) => onChange({ attempts: v })}
        />
        <Text
          label="Duration (minutes, empty for untimed)"
          inputMode="numeric"
          value={s.durationMinutes}
          onChange={(v) => onChange({ durationMinutes: v })}
        />
        <Text
          label="Time zone shown to students"
          value={s.timeZone}
          hint="An IANA name such as Europe/Madrid"
          onChange={(v) => onChange({ timeZone: v })}
        />
      </div>
      <div className={local.inlineFields}>
        <Text
          label="Opens"
          type="datetime-local"
          value={s.opensAt}
          onChange={(v) => onChange({ opensAt: v })}
        />
        <Text
          label="Closes"
          type="datetime-local"
          value={s.closesAt}
          onChange={(v) => onChange({ closesAt: v })}
        />
      </div>
      <div className={local.inlineFields}>
        <Select
          label="Late submission"
          value={s.late}
          onChange={(v) => onChange({ late: v })}
          options={[
            ['none', 'Not accepted after closing'],
            ['accept', 'Accepted and marked late until'],
          ]}
        />
        {s.late === 'accept' ? (
          <Text
            label="Late submissions accepted until"
            type="datetime-local"
            value={s.lateUntil}
            onChange={(v) => onChange({ lateUntil: v })}
          />
        ) : null}
      </div>
      <div className={local.inlineFields}>
        <Select
          label="Results released"
          value={s.releaseResults}
          onChange={(v) => onChange({ releaseResults: v })}
          options={[
            ['manual', 'By an instructor'],
            ['scheduled', 'At a set time'],
          ]}
        />
        {s.releaseResults === 'scheduled' ? (
          <Text
            label="Results released at"
            type="datetime-local"
            value={s.releaseAt}
            onChange={(v) => onChange({ releaseAt: v })}
          />
        ) : null}
        <Select
          label="Solutions"
          value={s.solutions}
          onChange={(v) => onChange({ solutions: v })}
          options={[
            ['never', 'Never shown'],
            ['with_results', 'Shown with results'],
          ]}
        />
        <Select
          label="Reported grade"
          value={s.reportedGrade}
          onChange={(v) => onChange({ reportedGrade: v })}
          options={[
            ['latest', 'Latest attempt'],
            ['highest', 'Highest attempt'],
            ['instructor_selected', 'Chosen by an instructor'],
          ]}
        />
      </div>
      <Check
        label="Show hidden test details with results"
        checked={s.hiddenTestDetails}
        onChange={(v) => onChange({ hiddenTestDetails: v })}
      />
      <Area
        label="Allowed materials"
        value={s.allowedMaterials}
        onChange={(v) => onChange({ allowedMaterials: v })}
      />
    </fieldset>
  );
}

function QuestionEditor({
  index,
  count,
  question: q,
  courseId,
  resourceId,
  saved,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  question: DraftQuestion;
  courseId: string;
  resourceId: string;
  saved: boolean;
  onChange: (patch: Partial<DraftQuestion>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <section className={local.card} aria-label={`Question ${n}`}>
      <div className={local.cardHead}>
        <h3 className={styles.subheading}>
          Question {n} · {kindNames[q.kind]}
        </h3>
        <span className={styles.row}>
          <button
            type="button"
            className={buttons.textButton}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            Move question {n} up
          </button>
          <button
            type="button"
            className={buttons.textButton}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            Move question {n} down
          </button>
          <button type="button" className={buttons.textButton} onClick={onRemove}>
            Remove question {n}
          </button>
        </span>
      </div>
      <div className={local.inlineFields}>
        <Text label={`Question ${n} id`} value={q.id} onChange={(v) => onChange({ id: v })} />
        <Text
          label={`Question ${n} points`}
          inputMode="decimal"
          value={q.points}
          onChange={(v) => onChange({ points: v })}
        />
      </div>
      <Area
        label={
          q.kind === 'code'
            ? `Question ${n} prompt and input/output contract`
            : `Question ${n} prompt`
        }
        rows={q.kind === 'code' ? 6 : 3}
        value={q.prompt}
        hint={
          q.kind === 'code'
            ? 'State the function or program interface, what it reads and what it must produce.'
            : undefined
        }
        onChange={(v) => onChange({ prompt: v })}
      />
      {q.kind === 'choice' ? <ChoiceFields n={n} q={q} onChange={onChange} /> : null}
      {q.kind === 'numeric' ? (
        <div className={local.inlineFields}>
          <Text
            label={`Question ${n} correct answer`}
            inputMode="decimal"
            value={q.answer}
            onChange={(v) => onChange({ answer: v })}
          />
          <Text
            label={`Question ${n} tolerance`}
            inputMode="decimal"
            value={q.tolerance}
            onChange={(v) => onChange({ tolerance: v })}
          />
          <Text
            label={`Question ${n} unit`}
            value={q.unit}
            onChange={(v) => onChange({ unit: v })}
          />
        </div>
      ) : null}
      {q.kind === 'explanation' ? (
        <Text
          label={`Question ${n} maximum length (characters)`}
          inputMode="numeric"
          value={q.maxLength}
          onChange={(v) => onChange({ maxLength: v })}
        />
      ) : null}
      {q.kind === 'code' ? (
        <>
          <CodeQuestionEditor question={q} courseId={courseId} onChange={onChange} />
          <PreviewRunPanel courseId={courseId} resourceId={resourceId} question={q} saved={saved} />
        </>
      ) : null}
      <RubricEditor n={n} rubric={q.rubric} onChange={(rubric) => onChange({ rubric })} />
    </section>
  );
}

function ChoiceFields({
  n,
  q,
  onChange,
}: {
  n: number;
  q: DraftQuestion;
  onChange: (patch: Partial<DraftQuestion>) => void;
}) {
  const setOption = (i: number, patch: Partial<DraftQuestion['options'][number]>) =>
    onChange({
      options: replaceAt(q.options, i, {
        ...(q.options[i] as DraftQuestion['options'][number]),
        ...patch,
      }),
    });
  return (
    <fieldset className={local.choices}>
      <legend>{`Question ${n} options`}</legend>
      <Check
        label="More than one option can be correct"
        checked={q.multiple}
        onChange={(multiple) =>
          onChange({ multiple, correct: multiple ? q.correct : q.correct.slice(0, 1) })
        }
      />
      {q.options.map((o, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: option ids are edited, so the position is the only stable key.
        <div key={i} className={local.inlineFields}>
          <Text
            label={`Option ${i + 1} id`}
            value={o.id}
            onChange={(v) =>
              onChange({
                options: replaceAt(q.options, i, { ...o, id: v }),
                // The correct mark follows the option it was set on.
                correct: q.correct.map((c) => (c === o.id ? v : c)),
              })
            }
          />
          <Text
            label={`Option ${i + 1} label`}
            value={o.label}
            onChange={(v) => setOption(i, { label: v })}
          />
          <Check
            type={q.multiple ? 'checkbox' : 'radio'}
            name={`correct-${n}`}
            label={`Option ${i + 1} is correct`}
            checked={q.correct.includes(o.id)}
            onChange={(on) =>
              onChange({
                correct: q.multiple
                  ? on
                    ? [...q.correct, o.id]
                    : q.correct.filter((c) => c !== o.id)
                  : on
                    ? [o.id]
                    : [],
              })
            }
          />
          <button
            type="button"
            className={buttons.textButton}
            disabled={q.options.length <= 2}
            onClick={() =>
              onChange({
                options: q.options.filter((_, j) => j !== i),
                correct: q.correct.filter((c) => c !== o.id),
              })
            }
          >
            Remove option {i + 1}
          </button>
        </div>
      ))}
      <div className={styles.mt12}>
        <button
          type="button"
          className={buttons.outline}
          disabled={q.options.length >= 12}
          onClick={() =>
            onChange({
              options: [...q.options, { id: nextOptionId(q.options), label: '' }],
            })
          }
        >
          Add option
        </button>
      </div>
    </fieldset>
  );
}

function RubricEditor({
  n,
  rubric,
  onChange,
}: {
  n: number;
  rubric: DraftCriterion[];
  onChange: (rubric: DraftCriterion[]) => void;
}) {
  return (
    <fieldset className={local.choices}>
      <legend>{`Question ${n} rubric`}</legend>
      {rubric.length === 0 ? (
        <p className={local.hint}>No manual criteria: the question is scored automatically.</p>
      ) : null}
      {rubric.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: criterion ids are edited, so the position is the only stable key.
        <div key={i} className={local.inlineFields}>
          <Text
            label={`Criterion ${i + 1} id`}
            value={r.id}
            onChange={(v) => onChange(replaceAt(rubric, i, { ...r, id: v }))}
          />
          <Text
            label={`Criterion ${i + 1} description`}
            value={r.label}
            onChange={(v) => onChange(replaceAt(rubric, i, { ...r, label: v }))}
          />
          <Text
            label={`Criterion ${i + 1} points`}
            inputMode="decimal"
            value={r.points}
            onChange={(v) => onChange(replaceAt(rubric, i, { ...r, points: v }))}
          />
          <button
            type="button"
            className={buttons.textButton}
            onClick={() => onChange(rubric.filter((_, j) => j !== i))}
          >
            Remove criterion {i + 1}
          </button>
        </div>
      ))}
      <div className={styles.mt12}>
        <button
          type="button"
          className={buttons.outline}
          disabled={rubric.length >= 20}
          onClick={() =>
            onChange([...rubric, { id: `c${rubric.length + 1}`, label: '', points: '1' }])
          }
        >
          Add criterion
        </button>
      </div>
    </fieldset>
  );
}
