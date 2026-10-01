import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import { OfflineBanner } from '../components/OfflineBanner';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import { useSession } from '../session/useSession';
import { NativeReading } from './NativeReading';
import { PdfReading } from './PdfReading';
import { positionFromSearch, type ReadingSearch, searchFor } from './place';
import styles from './Reading.module.css';
import {
  type ReadingPosition,
  type ReadingSummary,
  renewPdfUrl,
  useReadingContent,
  useReadings,
  useSavePosition,
} from './readings';
import { useReporter } from './useReporter';

interface Props {
  classId: string;
  courseId: string;
  topicId: string;
  instructor: boolean;
  search: ReadingSearch;
  /** Moves the address: a new entry when the reading changes, in place for a new position. */
  onSearch: (search: ReadingSearch, mode: 'push' | 'replace') => void;
}

/** The Reading tab (§5, §8): resource toolbar, then the picked reading in its reader. */
export function ReadingTab({ classId, courseId, topicId, instructor, search, onSearch }: Props) {
  const list = useReadings(classId, topicId);
  // Adding a reading is course authoring (§12): an instructor without an editor grant has no page for it.
  const session = useSession();
  const canAdd =
    instructor &&
    session.status === 'signed-in' &&
    session.me.courses.some((c) => c.courseId === courseId && (c.editor || c.owner));

  // An entry opened without a reading in its address is pinned to the one shown, so Back returns
  // to it even after a later save has moved "the reading studied last".
  const shown =
    list.data &&
    (list.data.readings.find((r) => r.revisionId === search.resource) ??
      list.data.readings.find((r) => r.revisionId === list.data?.lastRevisionId) ??
      list.data.readings[0]);
  const shownId = shown?.revisionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `onSearch` is a new function every render
  useEffect(() => {
    if (shownId && search.resource === undefined) onSearch({ resource: shownId }, 'replace');
  }, [shownId, search.resource]);

  if (!list.data) {
    return (
      <div className={styles.stage}>
        {list.isError ? (
          <RetryNotice
            message="The readings could not be loaded."
            onRetry={() => void list.refetch()}
          />
        ) : (
          <p className={styles.loading} role="status">
            Loading reading
          </p>
        )}
      </div>
    );
  }

  const { readings, lastRevisionId } = list.data;
  if (readings.length === 0) {
    return (
      <div className={styles.stage}>
        <p className={styles.empty}>No reading has been added</p>
        {canAdd && (
          <p>
            <Link
              to="/courses/$courseId/edit/$topicId"
              params={{ courseId, topicId }}
              className={page.link}
            >
              Add reading
            </Link>
          </p>
        )}
      </div>
    );
  }

  const chosen =
    readings.find((r) => r.revisionId === search.resource) ??
    readings.find((r) => r.revisionId === lastRevisionId) ??
    readings[0];
  if (!chosen) return null;
  // The address place wins over the saved one: it is where this history entry was left.
  const initial =
    (search.resource === undefined || search.resource === chosen.revisionId
      ? positionFromSearch(search)
      : null) ?? chosen.position;

  return (
    <>
      <div className={styles.toolbar}>
        {readings.length > 1 ? (
          <label className={styles.picker}>
            <span className={styles.small}>Reading</span>
            <select
              value={chosen.revisionId}
              onChange={(e) => onSearch({ resource: e.target.value }, 'push')}
            >
              {readings.map((r) => (
                <option key={r.revisionId} value={r.revisionId}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className={styles.small}>{chosen.title}</span>
        )}
        {canAdd && (
          <Link
            to="/courses/$courseId/edit/$topicId"
            params={{ courseId, topicId }}
            className={page.link}
          >
            Add reading
          </Link>
        )}
      </div>
      <div className={styles.stage}>
        <ReadingView
          key={chosen.revisionId}
          classId={classId}
          topicId={topicId}
          reading={chosen}
          initial={initial}
          onSearch={onSearch}
        />
      </div>
    </>
  );
}

interface ViewProps {
  classId: string;
  topicId: string;
  reading: ReadingSummary;
  initial: ReadingPosition | null;
  onSearch: Props['onSearch'];
}

function ReadingView({ classId, topicId, reading, initial, onSearch }: ViewProps) {
  const content = useReadingContent(classId, reading.revisionId);
  const save = useSavePosition(classId, topicId);
  const { revisionId } = reading;
  const lastSaved = useRef<string>('');

  const store = useCallback(
    (position: ReadingPosition) => {
      const key = JSON.stringify(position);
      if (key === lastSaved.current) return;
      lastSaved.current = key;
      // A save that fails is retried by the next move; nothing here claims it was kept.
      save(revisionId, position).catch(() => {
        lastSaved.current = '';
      });
    },
    [save, revisionId],
  );
  const report = useReporter((position) => {
    store(position);
    onSearch(searchFor(revisionId, position), 'replace');
  }, store);

  const renew = useCallback(() => renewPdfUrl(classId, revisionId), [classId, revisionId]);

  if (content.error instanceof ApiError && content.error.status === 404 && !content.data) {
    return (
      <div className={page.feedback} role="alert">
        <p>This reading is not available.</p>
      </div>
    );
  }
  const data = content.data;
  if (!data) {
    return content.isError ? (
      <RetryNotice
        message="This reading could not be loaded."
        onRetry={() => void content.refetch()}
      />
    ) : (
      <p className={styles.loading} role="status">
        Loading reading
      </p>
    );
  }
  if (data.status === 'pending') {
    return (
      <p className={styles.loading} role="status">
        {data.title} is being prepared
      </p>
    );
  }
  if (data.status === 'failed') {
    return (
      <div className={page.feedback} role="alert">
        <p>
          {data.title} could not be processed{data.error ? `: ${data.error}` : ''}
        </p>
        <button type="button" className={page.outline} onClick={() => void content.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const offline = (
    <OfflineBanner>
      You are offline. This reading stays open; your place is not saved until you are back online.
    </OfflineBanner>
  );
  if (data.html !== null) {
    return (
      <>
        {offline}
        <NativeReading html={data.html} initial={initial} onPosition={report} />
      </>
    );
  }
  if (data.pdf) {
    return (
      <>
        {offline}
        <PdfReading
          url={data.pdf.url}
          pageCount={data.pdf.pageCount}
          renew={renew}
          initial={initial}
          onPosition={report}
        />
      </>
    );
  }
  return null;
}
