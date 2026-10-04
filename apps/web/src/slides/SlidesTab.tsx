import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import {
  isArchivedRefusal,
  markPositionsRefused,
  positionsRefused,
} from '../reading/positionRefusal';
import { SourceDownload } from '../reading/SourceDownload';
import { useReporter } from '../reading/useReporter';
import { useSession } from '../session/useSession';
import { ResourceTools } from '../workspace/ResourceTools';
import { SlideNotes } from './SlideNotes';
import styles from './Slides.module.css';
import { type NotesContext, SlideViewer } from './SlideViewer';
import {
  type DeckSummary,
  renewDeckUrl,
  slidePosition,
  useDeckContent,
  useDecks,
  useSaveSlide,
} from './slides';

interface Props {
  classId: string;
  courseId: string;
  topicId: string;
  instructor: boolean;
  /** The deck the address names, if any. */
  resource: string | undefined;
  /** Moves the address to another deck: a new history entry. */
  onResource: (revisionId: string, mode: 'push' | 'replace') => void;
}

/** The Slides tab (§5, §7): the picked deck in its viewer, opened at the slide studied last. */
export function SlidesTab({ classId, courseId, topicId, instructor, resource, onResource }: Props) {
  const list = useDecks(classId, topicId);
  const session = useSession();
  const canAdd =
    instructor &&
    session.status === 'signed-in' &&
    session.me.courses.some((c) => c.courseId === courseId && (c.editor || c.owner));

  const decks = list.data?.decks ?? [];
  const chosen =
    decks.find((d) => d.revisionId === resource) ??
    decks.find((d) => d.revisionId === list.data?.lastRevisionId) ??
    decks[0];
  // An entry opened without a deck in its address is pinned to the one shown, so Back returns to it.
  const shownId = chosen?.revisionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `onResource` is a new function every render
  useEffect(() => {
    if (shownId && resource === undefined) onResource(shownId, 'replace');
  }, [shownId, resource]);

  if (!list.data) {
    return (
      <div className={styles.status}>
        {list.isError ? (
          <RetryNotice
            message="The slides could not be loaded."
            onRetry={() => void list.refetch()}
          />
        ) : (
          <Loading label="Loading slides" />
        )}
      </div>
    );
  }
  if (!chosen) {
    return (
      <div className={styles.empty}>
        <p>No slides have been added</p>
        {canAdd && (
          <p>
            <Link
              to="/courses/$courseId/edit/$topicId"
              params={{ courseId, topicId }}
              className={page.link}
            >
              Add slides
            </Link>
          </p>
        )}
      </div>
    );
  }

  const picker =
    decks.length > 1 ? (
      <label className={styles.picker}>
        <span className={styles.label}>Slides</span>
        <select value={chosen.revisionId} onChange={(e) => onResource(e.target.value, 'push')}>
          {decks.map((d) => (
            <option key={d.revisionId} value={d.revisionId}>
              {d.title}
            </option>
          ))}
        </select>
      </label>
    ) : undefined;

  return (
    <>
      {/* In the toolbar whatever the deck's state, so another deck stays reachable. */}
      <ResourceTools>
        {picker ?? <span className={styles.label}>{chosen.title}</span>}
        {canAdd && (
          <Link
            to="/courses/$courseId/edit/$topicId"
            params={{ courseId, topicId }}
            className={page.link}
          >
            Add slides
          </Link>
        )}
      </ResourceTools>
      <DeckView key={chosen.revisionId} classId={classId} topicId={topicId} deck={chosen} />
    </>
  );
}

interface ViewProps {
  classId: string;
  topicId: string;
  deck: DeckSummary;
}

function DeckView({ classId, topicId, deck }: ViewProps) {
  const { revisionId } = deck;
  const content = useDeckContent(classId, revisionId);
  const save = useSaveSlide(classId, topicId);
  const queryClient = useQueryClient();
  const lastSaved = useRef(deck.position && 'page' in deck.position ? deck.position.page : 0);
  const saving = useRef(false);
  const next = useRef<number | null>(null);

  const send = useCallback(
    function send(slide: number) {
      // An archived class refused a save and takes no more for the life of the page.
      if (positionsRefused(queryClient, classId)) {
        next.current = null;
        return;
      }
      saving.current = true;
      save(revisionId, slide)
        .catch((error: unknown) => {
          if (isArchivedRefusal(error)) {
            markPositionsRefused(queryClient, classId);
            next.current = null;
            return;
          }
          // Retried by the next move unless a newer slide is already waiting; nothing here
          // claims it was kept.
          if (next.current === null) lastSaved.current = 0;
        })
        .finally(() => {
          saving.current = false;
          const waiting = next.current;
          next.current = null;
          if (waiting !== null) send(waiting);
        });
    },
    [save, revisionId, queryClient, classId],
  );

  /** One save at a time, so an older PUT cannot land after a newer one. */
  const store = useCallback(
    (slide: number, now = false) => {
      if (slide === lastSaved.current) return;
      lastSaved.current = slide;
      if (saving.current && !now) {
        next.current = slide;
        return;
      }
      next.current = null;
      send(slide);
    },
    [send],
  );
  const report = useReporter(
    (position, reason) => {
      if ('page' in position) store(position.page, reason !== 'pause');
    },
    (position) => {
      if ('page' in position) store(position.page);
    },
    () => {
      const waiting = next.current;
      next.current = null;
      if (waiting !== null) send(waiting);
    },
  );
  const onPage = useCallback((n: number) => report(slidePosition(n)), [report]);
  const renew = useCallback(() => renewDeckUrl(classId, revisionId), [classId, revisionId]);
  // Notes and questions belong to the deck's resource, so they outlive a replaced revision (§7).
  const notes = useCallback(
    ({ page: slide }: NotesContext) => (
      <SlideNotes classId={classId} resourceId={deck.resourceId} page={slide} />
    ),
    [classId, deck.resourceId],
  );

  if (content.error instanceof ApiError && content.error.status === 404) {
    return (
      <div className={`${page.feedback} ${styles.status}`} role="alert">
        <p>These slides are not available.</p>
      </div>
    );
  }
  const data = content.data;
  if (!data) {
    return content.isError ? (
      <div className={styles.status}>
        <RetryNotice
          message="These slides could not be loaded."
          onRetry={() => void content.refetch()}
        />
      </div>
    ) : (
      <Loading label="Loading slides" className={styles.status} />
    );
  }
  if (data.status === 'pending') {
    return <Loading label={`${data.title} is being prepared`} className={styles.status} />;
  }
  if (data.status === 'failed' || (!data.pdf && !data.web)) {
    return (
      <div className={styles.status}>
        <RetryNotice
          message={`${data.title} could not be processed${data.error ? `: ${data.error}` : ''}`}
          onRetry={() => void content.refetch()}
        >
          {data.sourceKey && (
            <SourceDownload
              classId={classId}
              revisionId={revisionId}
              sourceKey={data.sourceKey}
              className={buttons.outline}
            />
          )}
        </RetryNotice>
      </div>
    );
  }
  const initialPage = deck.position && 'page' in deck.position ? deck.position.page : 1;
  if (data.web) {
    return (
      <SlideViewer
        slides={data.web.slides}
        pageCount={data.web.slides.length}
        initialPage={initialPage}
        source={{ classId, revisionId, key: null }}
        onPage={onPage}
        notes={notes}
      />
    );
  }
  if (!data.pdf) return null;
  return (
    <SlideViewer
      url={data.pdf.url}
      pageCount={data.pdf.pageCount}
      renew={renew}
      initialPage={initialPage}
      source={{ classId, revisionId, key: data.sourceKey }}
      onPage={onPage}
      notes={notes}
    />
  );
}
