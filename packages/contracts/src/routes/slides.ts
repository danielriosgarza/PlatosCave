import { z } from 'zod';
import { defineRoute } from '../define';
import { exampleIds } from '../examples';
import { readingPosition } from './readings';

/**
 * The Slides tab (§5, §7): the decks of a topic (PDF files and Markdown web decks) and one deck's content. A deck's place is saved
 * with `PUT /api/classes/:classId/positions` (tab `slides`), by page with offset 0; it belongs
 * to the deck revision, so a replaced deck starts again at its first slide.
 */

const exampleClass = exampleIds.zero;
const exampleTopic = exampleIds.aa;
const exampleRevision = exampleIds.bb;

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
  summary:
    'One deck of the class release: a PDF’s short-lived file link and page count, or a web deck’s slides',
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
    /** A web deck: the sanitised HTML of each slide, in order (the reading allow-list). */
    web: z.object({ slides: z.array(z.string()).min(1) }).nullable(),
  }),
  examples: { params: { classId: exampleClass, revisionId: exampleRevision } },
});
