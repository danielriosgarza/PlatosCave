import { z } from 'zod';
import { defineRoute } from '../define';
import { exerciseCredit } from '../exercise';

const courseParams = z.object({ courseId: z.uuid() });
const classParams = z.object({ classId: z.uuid() });
const exampleCourse = { courseId: '00000000-0000-4000-8000-000000000000' };
const exampleClass = { classId: '00000000-0000-4000-8000-000000000000' };
const exampleRelease = '00000000-0000-4000-8000-000000000000';

const tab = z.enum(['slides', 'reading', 'exercises', 'notebooks', 'tests']);
const resourceType = z.enum([
  'slides_pdf',
  'slides_web',
  'reading_native',
  'reading_pdf',
  'exercise',
  'notebook',
  'shiny',
  'test',
]);

export const validationIssue = z.object({
  code: z.string(),
  message: z.string(),
  topicId: z.uuid().optional(),
  resourceId: z.uuid().optional(),
});

/** Errors block publication; warnings are stored with the release (ADR-0003). */
export const validationReport = z.object({
  errors: z.array(validationIssue),
  warnings: z.array(validationIssue),
});

const releaseRef = z.object({ id: z.uuid(), version: z.number().int() });

export const validateDrafts = defineRoute({
  method: 'GET',
  path: '/api/courses/:courseId/releases/validation',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Validation report for publishing the current drafts, without publishing',
  params: courseParams,
  response: validationReport,
  examples: { params: exampleCourse },
});

/** 200 with the new release; 422 `{ error: 'validation_failed', report }` when errors block. */
export const publishRelease = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/releases',
  scope: { kind: 'course', role: 'publisher' },
  summary: 'Validate the drafts and snapshot them as the next immutable course release',
  params: courseParams,
  response: z.object({
    release: releaseRef.extend({ createdAt: z.iso.datetime({ offset: true }) }),
    report: validationReport,
  }),
  examples: { params: exampleCourse },
});

const releasedResource = z.object({
  /** The `release_resources` row: stable for this release only. */
  id: z.uuid(),
  resourceId: z.uuid(),
  revisionId: z.uuid(),
  type: resourceType,
  tab,
  position: z.number().int(),
  title: z.string(),
  /** Always `visible` for students; instructors also see `hidden` resources. */
  visibility: z.enum(['visible', 'hidden']),
  releaseAt: z.iso.datetime({ offset: true }).nullable(),
  /** Points and hint policy of an exercise assigned for credit; null otherwise (§9). */
  credit: exerciseCredit.nullable(),
});

export const getClassRelease = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/release',
  scope: { kind: 'class', role: 'any' },
  summary: 'The topics and pinned resource revisions of the release this class adopted',
  params: classParams,
  response: z.object({
    release: releaseRef.extend({ createdAt: z.iso.datetime({ offset: true }) }).nullable(),
    topics: z.array(
      z.object({
        id: z.uuid(),
        topicId: z.uuid(),
        position: z.number().int(),
        title: z.string(),
        objective: z.string(),
        /** Draft topic ids, matching `topicId` of other topics in this release. */
        prerequisites: z.array(z.string()),
        estimatedMinutes: z.number().int().nullable(),
        resources: z.array(releasedResource),
      }),
    ),
  }),
  examples: { params: exampleClass },
});

const counts = z.object({ annotations: z.number().int(), assignments: z.number().int() });
const diffEntry = z.object({
  resourceId: z.uuid(),
  title: z.string(),
  tab,
  topicTitle: z.string(),
});

/** What adopting `to` instead of `from` changes for one class (§12, ADR-0003). */
export const adoptionDiff = z.object({
  from: releaseRef.nullable(),
  to: releaseRef,
  added: z.array(diffEntry.extend({ revisionId: z.uuid() })),
  removed: z.array(diffEntry.extend({ revisionId: z.uuid(), affected: counts })),
  changed: z.array(
    diffEntry.extend({
      fromRevisionId: z.uuid(),
      toRevisionId: z.uuid(),
      /** Which snapshot fields differ: revision, title, tab, topic, position, visibility, releaseAt. */
      fields: z.array(z.string()),
      affected: counts,
    }),
  ),
  totals: counts.extend({
    added: z.number().int(),
    removed: z.number().int(),
    changed: z.number().int(),
  }),
});

export const listClassReleases = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/releases',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Releases of the class’s course that can be adopted, and the class’s adoption history',
  params: classParams,
  response: z.object({
    currentReleaseId: z.uuid().nullable(),
    releases: z.array(releaseRef.extend({ createdAt: z.iso.datetime({ offset: true }) })),
    history: z.array(
      z.object({
        id: z.uuid(),
        from: releaseRef.nullable(),
        to: releaseRef,
        actor: z.object({ id: z.uuid(), name: z.string() }).nullable(),
        diff: adoptionDiff,
        createdAt: z.iso.datetime({ offset: true }),
      }),
    ),
  }),
  examples: { params: exampleClass },
});

/** 404 when the release is not one of the class's course. */
export const previewAdoption = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/adoption',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Diff the class would see by adopting a release: changed resources, affected work',
  params: classParams,
  query: z.object({ releaseId: z.uuid() }),
  response: adoptionDiff,
  examples: { params: exampleClass, query: { releaseId: exampleRelease } },
});

/**
 * `expectedReleaseId` is the release the instructor saw the diff against; 409
 * `{ error: 'release_conflict', currentReleaseId }` when another adoption happened since.
 * 404 when the release is not one of the class's course; 409 `class_archived`.
 */
export const adoptRelease = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/adopt',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Move the class to another release of its course and record the diff',
  params: classParams,
  body: z.object({ releaseId: z.uuid(), expectedReleaseId: z.uuid().nullable() }),
  response: z.object({ releaseId: z.uuid(), diff: adoptionDiff }),
  examples: {
    params: exampleClass,
    body: { releaseId: exampleRelease, expectedReleaseId: null },
  },
});
