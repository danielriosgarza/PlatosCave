import { publishRelease, type validationIssue } from '@parallax/contracts/routes/releases';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { ApiError, call } from '../api/client';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { canPublish } from './grants';
import { authoringKey, overviewQuery, processingQuery, validationQuery } from './queries';

type Issue = z.output<typeof validationIssue>;

interface Props {
  courseId: string;
  grant: { owner: boolean; publisher: boolean };
}

/**
 * The publication side panel (§12): which release each class runs, the validation report for
 * the current drafts, and the Publish button. Publishing creates a release and moves no class.
 */
export function PublishPanel({ courseId, grant }: Props) {
  const queryClient = useQueryClient();
  const overview = useQuery(overviewQuery(courseId));
  const validation = useQuery(validationQuery(courseId));
  const [notice, setNotice] = useState<string | null>(null);

  const processing = useQuery(processingQuery(courseId));
  // The report depends on processing: when a job finishes or fails, check the drafts again.
  const processingStates = processing.data?.resources
    .map((r) => `${r.resourceId}:${r.state}`)
    .join();
  useEffect(() => {
    if (processingStates !== undefined) {
      void queryClient.invalidateQueries({ queryKey: validationQuery(courseId).queryKey });
    }
  }, [processingStates, courseId, queryClient]);

  const publish = useMutation({
    mutationFn: () => call(publishRelease, { params: { courseId } }),
    onMutate: () => setNotice(null),
    onSuccess: async ({ release }) => {
      setNotice(`Release ${release.version} created.`);
      await queryClient.invalidateQueries({ queryKey: authoringKey(courseId) });
    },
    onError: (err) => {
      // A refusal means the drafts changed since the last check: show the fresh report.
      if (err instanceof ApiError && err.status === 422) {
        void queryClient.invalidateQueries({ queryKey: validationQuery(courseId).queryKey });
      }
    },
  });

  const latest = overview.data?.latestRelease ?? null;
  const next = (latest?.version ?? 0) + 1;
  const errors = validation.data?.errors ?? [];
  const warnings = validation.data?.warnings ?? [];
  const mayPublish = canPublish(grant);

  return (
    <aside className={styles.side} aria-label="Publication">
      <h2 style={{ fontSize: 18, margin: '16px 0' }}>Publication</h2>
      {overview.isError ? (
        <p role="alert">The classes of this course could not be loaded.</p>
      ) : overview.data ? (
        overview.data.classes.length === 0 ? (
          <p className={styles.muted}>This course has no class yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {overview.data.classes.map((c) => (
              <li key={c.id} className={styles.muted}>
                {c.name}{' '}
                {c.release ? `uses release ${c.release.version}.` : 'has not adopted a release.'}
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className={styles.muted} aria-busy="true">
          Loading classes…
        </p>
      )}
      <p style={{ margin: '18px 0' }}>
        {latest
          ? `Latest release: ${latest.version}. Publishing creates release ${next}; classes stay on their release until an instructor adopts it.`
          : 'Nothing is published yet. Publishing creates release 1.'}
      </p>
      {validation.isError ? (
        <p role="alert">The publication check could not run.</p>
      ) : validation.data ? (
        <div role="status">
          {errors.length === 0 ? (
            <p className={`${styles.small} ${local.success}`}>
              Publication check: no blocking problems
              {warnings.length ? `, ${warnings.length} to review` : ''}
            </p>
          ) : (
            <p className={`${styles.small} ${local.failure}`}>
              Publication check: {errors.length} blocking{' '}
              {errors.length === 1 ? 'problem' : 'problems'}
            </p>
          )}
        </div>
      ) : (
        <p className={`${styles.small} ${styles.muted}`}>Checking the drafts…</p>
      )}
      {errors.length > 0 ? <IssueList heading="Blocks publication" issues={errors} /> : null}
      {warnings.length > 0 ? <IssueList heading="To review" issues={warnings} /> : null}
      <div style={{ marginTop: 24 }}>
        <button
          type="button"
          className={styles.primary}
          disabled={!mayPublish || publish.isPending}
          onClick={() => publish.mutate()}
        >
          {publish.isPending ? 'Publishing…' : `Publish release ${next}`}
        </button>
      </div>
      {!mayPublish ? (
        <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 12 }}>
          Publishing needs the publisher permission on this course.
        </p>
      ) : null}
      {notice ? (
        <p className={`${styles.small} ${local.success}`} role="status" style={{ marginTop: 12 }}>
          {notice}
        </p>
      ) : null}
      {publish.isError && !(publish.error instanceof ApiError && publish.error.status === 422) ? (
        <p className={styles.small} role="alert" style={{ marginTop: 12 }}>
          The release was not created. Try again.
        </p>
      ) : null}
    </aside>
  );
}

function IssueList({ heading, issues }: { heading: string; issues: Issue[] }) {
  return (
    <>
      <h3 style={{ fontSize: 13, marginTop: 16 }}>{heading}</h3>
      <ul className={local.issues}>
        {issues.map((i, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two issues can share code and resource
          <li key={`${i.code}-${i.resourceId ?? i.topicId ?? ''}-${n}`}>{i.message}</li>
        ))}
      </ul>
    </>
  );
}
