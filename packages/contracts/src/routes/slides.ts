import { z } from 'zod';
import { defineRoute } from '../define';
import { readingPosition } from './readings';

/**
 * The Slides tab (§5, §7): the PDF decks of a topic and one deck's file. A deck's place is saved
 * with `PUT /api/classes/:classId/positions` (tab `slides`), by page with offset 0; it belongs
 * to the deck revision, so a replaced deck starts again at its first slide.
 */

const exampleClass = '00000000-0000-4000-8000-000000000000';
const exampleTopic = '00000000-0000-4000-8000-0000000000aa';
const exampleRevision = '00000000-0000-4000-8000-0000000000bb';

const timestamp = z.iso.datetime({ offset: true });

export const deckSummary = z.object({
  resourceId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string(),
  /** The caller's last slide in this deck revision, if any. */
  position: readingPosition.nullable(),
});

export const listSlides = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/topics/:topicId/slides',
  scope: { kind: 'class', role: 'any' },
  summary: 'The slide decks of a topic the caller may open, with the caller’s last slides',
  params: z.object({ classId: z.uuid(), topicId: z.uuid() }),
  response: z.object({
    decks: z.array(deckSummary),
    /** The deck studied last in this topic, to open first. */
    lastRevisionId: z.uuid().nullable(),
  }),
  examples: { params: { classId: exampleClass, topicId: exampleTopic } },
});

export const getSlides = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:revisionId/slides',
  scope: { kind: 'class', role: 'any' },
  summary: 'One PDF deck of the class release: its short-lived file link and page count',
  params: z.object({ classId: z.uuid(), revisionId: z.uuid() }),
  response: z.object({
    revisionId: z.uuid(),
    title: z.string(),
    /** `pending` while the ingestion job runs; `failed` carries its reason. */
    status: z.enum(['ready', 'pending', 'failed']),
    error: z.string().nullable(),
    /** Storage key of the uploaded file, the `:key` of the object route's attachment download. */
    sourceKey: z.string().nullable(),
    /** The file on the content origin, which answers byte-range requests, and its page count. */
    pdf: z
      .object({ url: z.url(), expiresAt: timestamp, pageCount: z.number().int().min(1) })
      .nullable(),
  }),
  examples: { params: { classId: exampleClass, revisionId: exampleRevision } },
});
