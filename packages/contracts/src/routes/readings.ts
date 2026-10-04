import { z } from 'zod';
import { classArchived, defineRoute, invalidBody } from '../define';
import { exampleIds } from '../examples';
import { topicTab } from './topics';

/**
 * The Reading tab (§5, §8): the readings of a topic, one reading's content, and the place a
 * person last studied it. Every route is class-scoped and reads only the class's adopted release.
 */

const exampleClass = exampleIds.zero;
const exampleTopic = exampleIds.aa;
const exampleRevision = exampleIds.bb;

const timestamp = z.iso.datetime({ offset: true });

/**
 * Where someone stopped in a reading. A native reading names the block (`data-block-id`) and
 * the character offset into that block's text; a PDF names the 1-based page and the vertical
 * offset in thousandths of the page height, so the place survives zoom and fit-width (§8).
 */
export const readingPosition = z.union([
  z.object({
    blockId: z.string().min(1).max(200),
    offset: z.number().int().min(0).max(1_000_000),
  }),
  z.object({
    page: z.number().int().min(1).max(100_000),
    offset: z.number().int().min(0).max(1000),
  }),
]);
export type ReadingPosition = z.output<typeof readingPosition>;

export const readingKind = z.enum(['native', 'pdf']);

export const readingSummary = z.object({
  resourceId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string(),
  kind: readingKind,
  /** The caller's saved place in this reading, if any. */
  position: readingPosition.nullable(),
});

export const listReadings = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/topics/:topicId/readings',
  scope: { kind: 'class', role: 'any' },
  summary: 'The readings of a topic the caller may open, with the caller’s saved places',
  params: z.object({ classId: z.uuid(), topicId: z.uuid() }),
  response: z.object({
    readings: z.array(readingSummary),
    /** The reading studied last in this topic, to open first. */
    lastRevisionId: z.uuid().nullable(),
  }),
  examples: { params: { classId: exampleClass, topicId: exampleTopic } },
});

export const getReading = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:revisionId/reading',
  scope: { kind: 'class', role: 'any' },
  summary:
    'One reading of the class release: sanitised HTML with image links, or a short-lived PDF link',
  params: z.object({ classId: z.uuid(), revisionId: z.uuid() }),
  response: z.object({
    revisionId: z.uuid(),
    title: z.string(),
    kind: readingKind,
    /** `pending` while the ingestion job runs; `failed` carries its reason. */
    status: z.enum(['ready', 'pending', 'failed']),
    error: z.string().nullable(),
    /**
     * Storage key of the uploaded source file, the `:key` of the object route's attachment
     * download, present only while it is downloadable: always for a PDF reading, and for a
     * native reading only when its conversion has failed (§14). Null otherwise, and for a
     * reading written inline.
     */
    sourceKey: z.string().nullable(),
    /** Native readings: ingested HTML, images resolved to content-origin links. */
    html: z.string().nullable(),
    /** PDF readings: the file on the content origin and its page count. */
    pdf: z
      .object({ url: z.url(), expiresAt: timestamp, pageCount: z.number().int().min(1) })
      .nullable(),
  }),
  examples: { params: { classId: exampleClass, revisionId: exampleRevision } },
});

export const putPosition = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/positions',
  scope: { kind: 'class', role: 'any' },
  summary: 'Save where the caller is in one resource revision of the class release (never a grade)',
  params: z.object({ classId: z.uuid() }),
  body: z.object({
    revisionId: z.uuid(),
    tab: topicTab,
    position: readingPosition,
  }),
  response: z.object({ updatedAt: timestamp }),
  errors: { 400: invalidBody, 409: classArchived },
  examples: {
    params: { classId: exampleClass },
    body: { revisionId: exampleRevision, tab: 'reading', position: { blockId: 'b1', offset: 0 } },
  },
});
