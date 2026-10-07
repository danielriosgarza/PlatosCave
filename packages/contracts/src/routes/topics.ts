import { z } from 'zod';
import { defineRoute } from '../define';
import { exampleIds } from '../examples';
import { tabs } from '../resources';

export const topicTab = z.enum(tabs);

/**
 * `available` and `complete` topics open; `scheduled` waits for a release date and `locked`
 * for unmet prerequisites (§4). Instructors never see a lock.
 */
export const topicState = z.enum(['available', 'scheduled', 'locked', 'complete']);

export const classTopic = z.object({
  /** The draft topic id, stable across releases; the address of `/topics/:topicId/:tab`. */
  topicId: z.uuid(),
  /** 1-based place in the syllabus. */
  number: z.number().int(),
  title: z.string(),
  objective: z.string(),
  estimatedMinutes: z.number().int().nullable(),
  /** Which tabs hold at least one resource the caller can open now. */
  presence: z.object({
    slides: z.boolean(),
    reading: z.boolean(),
    exercises: z.boolean(),
    notebooks: z.boolean(),
    tests: z.boolean(),
  }),
  /** First-visit tab (§4): Slides when present, else the first populated tab. */
  firstTab: topicTab.nullable(),
  /** Tab of the caller's latest position in this topic; opening the topic goes there (§4). */
  savedTab: topicTab.nullable(),
  state: topicState,
  /** When a `scheduled` topic opens. */
  availableAt: z.iso.datetime({ offset: true }).nullable(),
  /** Prerequisite topics a `locked` topic is waiting for. */
  requires: z.array(z.object({ topicId: z.uuid(), title: z.string() })),
});

export const getClassTopics = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/topics',
  scope: { kind: 'class', role: 'any' },
  summary:
    'The syllabus of the release this class adopted: availability, locks, time and the place to resume',
  params: z.object({ classId: z.uuid() }),
  response: z.object({
    release: z.object({ id: z.uuid(), version: z.number().int() }).nullable(),
    course: z.object({ id: z.uuid(), title: z.string() }),
    /** The class (cohort) name. */
    cohort: z.string(),
    instructors: z.array(z.string()),
    topics: z.array(classTopic),
    /**
     * The current row: the topic last studied in this class (`saved`), else the first open
     * topic. Null when no topic is open.
     */
    resume: z.object({ topicId: z.uuid(), tab: topicTab, saved: z.boolean() }).nullable(),
    /** Topics the caller has completed, of all topics; never a grade (§4). */
    reviewed: z.object({ count: z.number().int(), total: z.number().int() }),
  }),
  examples: { params: { classId: exampleIds.zero } },
});
