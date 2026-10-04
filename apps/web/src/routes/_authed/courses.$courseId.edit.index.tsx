import { createTopic, updateTopic } from '@parallax/contracts/routes/drafts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError, call } from '../../api/client';
import local from '../../authoring/Authoring.module.css';
import { canEdit, grantLabel } from '../../authoring/grants';
import { PublishPanel } from '../../authoring/PublishPanel';
import { authoringKey, draftsQuery } from '../../authoring/queries';
import { failureMessage } from '../../authoring/upload';
import styles from '../../components/Page.module.css';
import { usePageTitle } from '../../components/pageTitle';
import { Unavailable } from '../../components/Unavailable';
import { useSession } from '../../session/useSession';

export const Route = createFileRoute('/_authed/courses/$courseId/edit/')({
  component: EditCourse,
});

function EditCourse() {
  const { courseId } = Route.useParams();
  const session = useSession();
  if (session.status !== 'signed-in')
    return <main id="main" className={styles.index} aria-busy="true" />;
  const grant = session.me.courses.find((c) => c.courseId === courseId);
  if (!grant || !canEdit(grant)) return <Unavailable />;
  return <CourseDraft courseId={courseId} title={grant.title} grant={grant} />;
}

function CourseDraft({
  courseId,
  title,
  grant,
}: {
  courseId: string;
  title: string;
  grant: { owner: boolean; editor: boolean; publisher: boolean };
}) {
  const queryClient = useQueryClient();
  const drafts = useQuery(draftsQuery(courseId));
  usePageTitle(title);
  const [newTitle, setNewTitle] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: authoringKey(courseId) });

  const add = useMutation({
    mutationFn: () => call(createTopic, { params: { courseId }, body: { title: newTitle.trim() } }),
    onSuccess: async () => {
      setNewTitle('');
      await refresh();
    },
  });
  /** Swaps two topics' positions; each write carries the revision the editor saw (§12). */
  const move = useMutation({
    mutationFn: async ({
      a,
      b,
    }: {
      a: { id: string; position: number; revision: number };
      b: { id: string; position: number; revision: number };
    }) => {
      const first = await call(updateTopic, {
        params: { courseId, topicId: a.id },
        body: { expectedRevision: a.revision, position: b.position },
      });
      try {
        await call(updateTopic, {
          params: { courseId, topicId: b.id },
          body: { expectedRevision: b.revision, position: a.position },
        });
      } catch (err) {
        // Two topics must never keep the same position: put the first one back.
        await call(updateTopic, {
          params: { courseId, topicId: a.id },
          body: { expectedRevision: first.revision, position: a.position },
        }).catch(() => undefined);
        throw err;
      }
    },
    onSettled: refresh,
  });
  const archive = useMutation({
    mutationFn: (t: { id: string; revision: number; archived: boolean }) =>
      call(updateTopic, {
        params: { courseId, topicId: t.id },
        body: { expectedRevision: t.revision, archived: !t.archived },
      }),
    onSettled: refresh,
  });

  const topics = drafts.data?.topics ?? [];
  const live = topics.filter((t) => !t.archived);

  return (
    <main id="main" className={styles.index}>
      <p className={`${styles.small} ${styles.muted}`}>
        <Link to="/courses" search={{ view: 'instructor' }} className={styles.link}>
          Courses you teach
        </Link>
      </p>
      <h1 style={{ marginTop: 8 }}>{title}</h1>
      <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 8 }}>
        Course draft · your permission: {grantLabel(grant)}
      </p>
      <div className={styles.editGrid}>
        <div>
          <h2 style={{ fontSize: 20 }}>Topics</h2>
          {drafts.isError ? (
            <p role="alert" style={{ marginTop: 16 }}>
              The topics could not be loaded.{' '}
              <button
                type="button"
                className={styles.textButton}
                onClick={() => void drafts.refetch()}
              >
                Retry
              </button>
            </p>
          ) : !drafts.data ? (
            <p className={styles.muted} aria-busy="true" style={{ marginTop: 16 }}>
              Loading topics…
            </p>
          ) : topics.length === 0 ? (
            <p className={styles.muted} style={{ marginTop: 16 }}>
              This course has no topics yet.
            </p>
          ) : (
            <ol style={{ listStyle: 'none', padding: 0, margin: '16px 0 0' }}>
              {topics.map((t) => {
                const at = live.findIndex((x) => x.id === t.id);
                const before = at > 0 ? live[at - 1] : undefined;
                const after = at >= 0 ? live[at + 1] : undefined;
                return (
                  <li key={t.id} className={local.topicRow} data-archived={t.archived}>
                    <div>
                      <Link
                        to="/courses/$courseId/edit/$topicId"
                        params={{ courseId, topicId: t.id }}
                        className={`${styles.link} ${local.topicTitle}`}
                      >
                        {t.title}
                      </Link>
                      <div className={local.resourceMeta}>
                        {t.archived ? 'Archived · ' : ''}
                        {t.resources.filter((r) => !r.archived).length} resources
                      </div>
                    </div>
                    <div className={styles.row}>
                      {before ? (
                        <button
                          type="button"
                          className={styles.textButton}
                          disabled={move.isPending}
                          aria-label={`Move ${t.title} earlier`}
                          onClick={() => move.mutate({ a: t, b: before })}
                        >
                          Earlier
                        </button>
                      ) : null}
                      {after ? (
                        <button
                          type="button"
                          className={styles.textButton}
                          disabled={move.isPending}
                          aria-label={`Move ${t.title} later`}
                          onClick={() => move.mutate({ a: t, b: after })}
                        >
                          Later
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={styles.textButton}
                        disabled={archive.isPending}
                        onClick={() => archive.mutate(t)}
                      >
                        {t.archived ? `Restore ${t.title}` : `Archive ${t.title}`}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {move.isError || archive.isError ? (
            <p role="alert" className={styles.small} style={{ marginTop: 12 }}>
              {(move.error ?? archive.error) instanceof ApiError &&
              ((move.error ?? archive.error) as ApiError).status === 409
                ? 'Another editor changed the topics meanwhile. The list is reloaded; try again.'
                : 'The change was not saved. Try again.'}
            </p>
          ) : null}
          <form
            style={{ marginTop: 24 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (newTitle.trim()) add.mutate();
            }}
          >
            <label className={local.field}>
              New topic title
              <input type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </label>
            <div className={styles.row} style={{ marginTop: 12 }}>
              <button
                type="submit"
                className={styles.outline}
                disabled={!newTitle.trim() || add.isPending}
              >
                {add.isPending ? 'Adding…' : 'Add topic'}
              </button>
            </div>
            {add.isError ? (
              <p role="alert" className={styles.small} style={{ marginTop: 8 }}>
                The topic was not added. {failureMessage(add.error)}
              </p>
            ) : null}
          </form>
        </div>
        <PublishPanel courseId={courseId} grant={grant} />
      </div>
    </main>
  );
}
