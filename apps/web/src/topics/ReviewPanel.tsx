import { getTopicReviews, putReviewed } from '@parallax/contracts/routes/topicReviews';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, call } from '../api/client';
import { refreshProgress, reviewSheetKey } from './progress';
import styles from './ReviewPanel.module.css';

const TAB_NAMES = {
  slides: 'Slides',
  reading: 'Reading',
  exercises: 'Exercises',
  notebooks: 'Notebooks',
  tests: 'Tests',
} as const;

type Item = { submitted: boolean; required: 'review' | 'submission' | null };
const submission = (item: Item) =>
  `${item.submitted ? 'Submitted' : 'Not submitted'}${
    item.required === 'submission' ? ', required for completion' : ''
  }`;

/**
 * The student's reviewed marks for one topic (§4). Each ungraded resource carries a checkbox the
 * student sets themself; graded work shows whether it has been submitted. Opening or viewing
 * material never sets a mark. A mark shows only after the server has acknowledged it.
 */
export function ReviewPanel({ classId, topicId }: { classId: string; topicId: string }) {
  const queryClient = useQueryClient();
  const key = reviewSheetKey(classId, topicId);
  const sheet = useQuery({
    queryKey: key,
    queryFn: () => call(getTopicReviews, { params: { classId, topicId } }),
  });
  const [problem, setProblem] = useState<string | null>(null);
  const mark = useMutation({
    mutationFn: (v: { resourceId: string; reviewed: boolean }) =>
      call(putReviewed, {
        params: { classId, topicId, resourceId: v.resourceId },
        body: { reviewed: v.reviewed },
      }),
    onMutate: () => setProblem(null),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      // The syllabus state, the footer count and the course cards all follow the marks.
      refreshProgress(queryClient);
    },
    onError: (err) =>
      setProblem(
        err instanceof ApiError && err.status === 409
          ? 'This class is archived, so reviewed marks can no longer change.'
          : 'The mark was not saved. Try again.',
      ),
  });

  if (sheet.isError) {
    return (
      <p className={styles.status}>
        Reviewed marks could not be loaded.{' '}
        <button type="button" className={styles.retry} onClick={() => void sheet.refetch()}>
          Retry reviewed marks
        </button>
      </p>
    );
  }
  const data = sheet.data;
  if (!data || data.items.length === 0) return null;
  return (
    <section className={styles.panel} aria-labelledby="pc-review-heading">
      <h2 id="pc-review-heading" className={styles.heading}>
        Reviewed
      </h2>
      <p className={styles.status} role="status">
        {data.complete ? 'This topic is complete.' : 'This topic is not complete yet.'}
      </p>
      <ul className={styles.list}>
        {data.items.map((item) => (
          <li key={item.resourceId}>
            {item.graded ? (
              <span className={styles.item}>
                <span>
                  {item.title} <span className={styles.tab}>{TAB_NAMES[item.tab]}</span>
                  <span className={styles.tab}> · {submission(item)}</span>
                </span>
              </span>
            ) : (
              <label className={styles.item}>
                <input
                  type="checkbox"
                  checked={item.reviewed}
                  disabled={mark.isPending}
                  onChange={(e) =>
                    mark.mutate({ resourceId: item.resourceId, reviewed: e.target.checked })
                  }
                />
                <span>
                  {item.title} <span className={styles.tab}>{TAB_NAMES[item.tab]}</span>
                  {item.required === 'review' ? (
                    <span className={styles.tab}> · counts toward completion</span>
                  ) : null}
                  {item.required === 'submission' ? (
                    <span className={styles.tab}> · {submission(item)}</span>
                  ) : null}
                </span>
              </label>
            )}
          </li>
        ))}
      </ul>
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
