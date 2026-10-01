import { type draftTopic, updateTopic } from '@parallax/contracts/routes/drafts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { z } from 'zod';
import { call } from '../api/client';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { LocalProblem, useAutosave } from './autosave';
import { ConflictView } from './ConflictView';
import { authoringKey } from './queries';
import { SaveStatus } from './SaveStatus';

export type Topic = z.output<typeof draftTopic>;

/** A resource the completion rule can require work from (§4: graded requirements). */
export interface Requirable {
  id: string;
  title: string;
}

interface Values {
  title: string;
  objective: string;
  estimatedMinutes: string;
  prerequisites: string[];
  completion: 'default' | 'custom';
  requires: string[];
}

const REVIEWED = 'reviewed:*';

function toValues(topic: Topic): Values {
  const rule = topic.completionRule as { requires?: unknown } | null;
  const requires = Array.isArray(rule?.requires)
    ? rule.requires.filter((r): r is string => typeof r === 'string')
    : [];
  return {
    title: topic.title,
    objective: topic.objective,
    estimatedMinutes: topic.estimatedMinutes === null ? '' : String(topic.estimatedMinutes),
    prerequisites: topic.prerequisites,
    completion: rule ? 'custom' : 'default',
    requires,
  };
}

function toBody(v: Values) {
  const title = v.title.trim();
  if (!title) throw new LocalProblem('A topic needs a title. Nothing is saved until it has one.');
  const minutes = v.estimatedMinutes.trim();
  const estimatedMinutes = minutes === '' ? null : Number(minutes);
  if (estimatedMinutes !== null && (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 0)) {
    throw new LocalProblem('Study time must be a whole number of minutes.');
  }
  return {
    title,
    objective: v.objective,
    estimatedMinutes,
    prerequisites: v.prerequisites,
    completionRule: v.completion === 'custom' ? { requires: v.requires } : null,
  };
}

interface Props {
  courseId: string;
  topic: Topic;
  /** The course's other unarchived topics, for prerequisites. */
  others: Topic[];
  requirable: Requirable[];
}

/** Title, objective, prerequisites, completion rule and study time of one draft topic (§12). */
export function TopicForm({ courseId, topic, others, requirable }: Props) {
  const queryClient = useQueryClient();
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: authoringKey(courseId) }),
    [queryClient, courseId],
  );
  const { values, change, state, retry, takeTheirs, keepMine } = useAutosave({
    server: topic,
    toValues,
    save: (v, expectedRevision) =>
      call(updateTopic, {
        params: { courseId, topicId: topic.id },
        body: { expectedRevision, ...toBody(v) },
      }),
    onSaved: () => void refresh(),
  });

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const titleOf = (id: string) => others.find((t) => t.id === id)?.title ?? 'a removed topic';
  const rows = (theirs: Topic) => {
    const t = toValues(theirs);
    const label = (v: Values) => ({
      title: v.title,
      objective: v.objective,
      time: v.estimatedMinutes ? `${v.estimatedMinutes} min` : '',
      prerequisites: v.prerequisites.map(titleOf).join(', '),
      completion: v.completion === 'default' ? 'Default' : `${v.requires.length} requirement(s)`,
    });
    const mine = label(values);
    const other = label(t);
    return (
      [
        ['Title', 'title'],
        ['Objective', 'objective'],
        ['Study time', 'time'],
        ['Prerequisites', 'prerequisites'],
        ['Completion rule', 'completion'],
      ] as const
    )
      .filter(([, k]) => mine[k] !== other[k])
      .map(([l, k]) => ({ label: l, mine: mine[k], theirs: other[k] }));
  };

  return (
    <div>
      <SaveStatus state={state} onRetry={retry} />
      {state.kind === 'conflict' ? (
        <ConflictView
          what="topic"
          rows={rows(state.current)}
          onKeepMine={() => keepMine(state.current)}
          onUseTheirs={() => takeTheirs(state.current)}
        />
      ) : null}
      <label className={local.field}>
        Title
        <input
          type="text"
          value={values.title}
          onChange={(e) => change({ title: e.target.value })}
          aria-invalid={values.title.trim() === ''}
        />
      </label>
      <label className={local.field}>
        Learning objective
        <textarea
          rows={3}
          value={values.objective}
          onChange={(e) => change({ objective: e.target.value })}
        />
      </label>
      <label className={local.field}>
        Estimated study time (minutes)
        <input
          type="number"
          min={0}
          value={values.estimatedMinutes}
          onChange={(e) => change({ estimatedMinutes: e.target.value })}
        />
      </label>
      <fieldset className={local.choices}>
        <legend>Prerequisites</legend>
        {others.length === 0 ? (
          <span className={local.hint}>This course has no other topic.</span>
        ) : (
          others.map((t) => (
            <label key={t.id} className={local.choice}>
              <input
                type="checkbox"
                checked={values.prerequisites.includes(t.id)}
                onChange={() => change({ prerequisites: toggle(values.prerequisites, t.id) })}
              />
              {t.title}
            </label>
          ))
        )}
      </fieldset>
      <fieldset className={local.choices}>
        <legend>Completion rule</legend>
        <label className={local.choice}>
          <input
            type="radio"
            name="completion"
            checked={values.completion === 'default'}
            onChange={() => change({ completion: 'default' })}
          />
          All ungraded material reviewed and graded work submitted
        </label>
        <label className={local.choice}>
          <input
            type="radio"
            name="completion"
            checked={values.completion === 'custom'}
            onChange={() => change({ completion: 'custom' })}
          />
          Only the requirements I choose
        </label>
        {values.completion === 'custom' ? (
          <div style={{ paddingLeft: 24, display: 'grid', gap: 8 }}>
            <label className={local.choice}>
              <input
                type="checkbox"
                checked={values.requires.includes(REVIEWED)}
                onChange={() => change({ requires: toggle(values.requires, REVIEWED) })}
              />
              All ungraded material reviewed
            </label>
            {requirable.map((r) => (
              <label key={r.id} className={local.choice}>
                <input
                  type="checkbox"
                  checked={values.requires.includes(`submitted:${r.id}`)}
                  onChange={() =>
                    change({ requires: toggle(values.requires, `submitted:${r.id}`) })
                  }
                />
                Submission of {r.title}
              </label>
            ))}
          </div>
        ) : null}
        <span className={local.hint}>
          Completion is shown to students and is separate from any grade.
        </span>
      </fieldset>
      <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 24 }}>
        Edits change the course draft only. Classes keep the release they use.
      </p>
    </div>
  );
}
