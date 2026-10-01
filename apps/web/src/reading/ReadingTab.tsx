import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import page from '../components/Page.module.css';
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
import { type PlaceReason, useReporter } from './useReporter';

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
  const queryClient = useQueryClient();
  // Adding a reading is course authoring (§12): an instructor without an editor grant has no page for it.
  const session = useSession();
  const canAdd =
    instructor &&
    session.status === 'signed-in' &&
    session.me.courses.some((c) => c.courseId === courseId && (c.editor || c.owner));

  // The reading the address names, else the one studied last, else the first.
  const readings = list.data?.readings ?? [];
  const chosen =
    readings.find((r) => r.revisionId === search.resource) ??
    readings.find((r) => r.revisionId === list.data?.lastRevisionId) ??
    readings[0];
  // An entry opened without a reading in its address is pinned to the one shown, so Back returns
  // to it even after a later save has moved "the reading studied last".
  const shownId = chosen?.revisionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `onSearch` is a new function every render
  useEffect(() => {
    if (shownId && search.resource === undefined) onSearch({ resource: shownId }, 'replace');
  }, [shownId, search.resource]);

  if (!list.data) {
    return (
      <div className={styles.stage}>
        {list.isError ? (
          <div className={page.feedback} role="alert">
            <p>The readings could not be loaded.</p>
            <button type="button" className={page.outline} onClick={() => void list.refetch()}>
              Try again
            </button>
          </div>
        ) : (
          <p className={styles.loading} role="status">
            Loading reading
          </p>
        )}
      </div>
    );
  }

  if (!chosen) {
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

  // The address place wins over the saved one: it is where this history entry was left, unless
  // the reader moved on from it before leaving (see `LeftAt`).
  const addressed =
    search.resource === undefined || search.resource === chosen.revisionId
      ? positionFromSearch(search)
      : null;
  const left = queryClient.getQueryData<LeftAt>(leftAtKey(classId, chosen.revisionId));
  const initial =
    (left && left.from === JSON.stringify(addressed) ? left.place : addressed) ?? chosen.position;

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
          addressed={addressed}
          onSearch={onSearch}
        />
      </div>
    </>
  );
}

/**
 * The place flushed as a reader left a reading (a tab click within the pause before a save),
 * which the address of the entry left behind does not hold: `from` is the place that address
 * names. Back to that entry restores `place` instead. Held in the query cache, so it belongs to
 * this app and session and is dropped with them.
 */
interface LeftAt {
  from: string;
  place: ReadingPosition;
}
const leftAtKey = (classId: string, revisionId: string) => ['reading', 'left', classId, revisionId];

interface ViewProps {
  classId: string;
  topicId: string;
  reading: ReadingSummary;
  initial: ReadingPosition | null;
  /** The place the address names for this reading, if any. */
  addressed: ReadingPosition | null;
  onSearch: Props['onSearch'];
}

function ReadingView({ classId, topicId, reading, initial, addressed, onSearch }: ViewProps) {
  const content = useReadingContent(classId, reading.revisionId);
  const save = useSavePosition(classId, topicId);
  const { revisionId } = reading;
  const queryClient = useQueryClient();
  const left = leftAtKey(classId, revisionId);
  const inAddress = useRef(JSON.stringify(addressed));
  const lastSaved = useRef<string>('');
  const saving = useRef(false);
  const next = useRef<ReadingPosition | null>(null);

  /**
   * One save at a time per reading, so an older PUT cannot land after a newer one; a place that
   * arrives meanwhile waits and replaces any place already waiting. Only a page being closed
   * sends at once, since nothing would be left to send the waiting place.
   */
  const store = useCallback(
    (position: ReadingPosition, now = false) => {
      const key = JSON.stringify(position);
      if (key === lastSaved.current) return;
      lastSaved.current = key;
      if (saving.current && !now) {
        next.current = position;
        return;
      }
      // A place sent at once supersedes any still waiting, which would otherwise land after it.
      next.current = null;
      const send = (place: ReadingPosition) => {
        saving.current = true;
        save(revisionId, place)
          .catch(() => {
            // Retried by the next move unless a newer place is already waiting; nothing here
            // claims it was kept.
            if (!next.current) lastSaved.current = '';
          })
          .finally(() => {
            saving.current = false;
            const waiting = next.current;
            next.current = null;
            if (waiting) send(waiting);
          });
      };
      send(position);
    },
    [save, revisionId],
  );
  const report = useReporter(
    (position: ReadingPosition, reason: PlaceReason) => {
      store(position, reason === 'close');
      queryClient.removeQueries({ queryKey: left, exact: true });
      inAddress.current = JSON.stringify(position);
      onSearch(searchFor(revisionId, position), 'replace');
    },
    (position) => {
      store(position);
      // An address without a place falls back to the saved place, which this save updates.
      const from = inAddress.current;
      if (from !== 'null' && from !== JSON.stringify(position)) {
        queryClient.setQueryData<LeftAt>(left, { from, place: position });
      }
    },
  );

  const renew = useCallback(() => renewPdfUrl(classId, revisionId), [classId, revisionId]);

  if (content.error instanceof ApiError && content.error.status === 404) {
    return (
      <div className={page.feedback} role="alert">
        <p>You no longer have access to this reading.</p>
      </div>
    );
  }
  const data = content.data;
  if (!data) {
    return content.isError ? (
      <div className={page.feedback} role="alert">
        <p>This reading could not be loaded.</p>
        <button type="button" className={page.outline} onClick={() => void content.refetch()}>
          Try again
        </button>
      </div>
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
  if (data.html !== null) {
    return <NativeReading html={data.html} initial={initial} onPosition={report} />;
  }
  if (data.pdf) {
    return (
      <PdfReading
        url={data.pdf.url}
        pageCount={data.pdf.pageCount}
        renew={renew}
        initial={initial}
        onPosition={report}
      />
    );
  }
  return null;
}
