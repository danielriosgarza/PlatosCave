import { z } from 'zod';
import { anchor } from '../anchors';
import { defineRoute } from '../define';
import { placementView } from './annotations';

/**
 * Annotation placements across revisions (ADR-0003, §8, A06). After a class adopts a release
 * with changed revisions, a job maps each mark; what it cannot place confidently is listed for
 * reattachment with its original quote and context.
 */

const exampleClass = '00000000-0000-4000-8000-000000000000';
const exampleThread = '00000000-0000-4000-8000-0000000000dd';

const classParams = z.object({ classId: z.uuid() });

export const mappingItem = z.object({
  threadId: z.uuid(),
  resourceId: z.uuid(),
  resourceTitle: z.string(),
  audience: z.enum(['instructor', 'class']),
  author: z.object({ id: z.uuid(), name: z.string() }),
  /** The revision the thread was asked on and its anchor there: the original context. */
  originalRevisionId: z.uuid(),
  anchor,
  placement: placementView,
});

/**
 * Discussions the instructor can read whose resource changed revision in the class's release,
 * reattachment first. Nothing here derives from private notes, which only their authors see
 * (§8, A05); authors find their own notes' placements on their annotation reads.
 */
export const listPlacements = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/placements',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Discussions to map onto the revisions the class uses, reattachment first',
  params: classParams,
  response: z.object({
    releaseId: z.uuid().nullable(),
    threads: z.array(mappingItem),
  }),
  examples: { params: { classId: exampleClass } },
});

/**
 * Manual placement on the revision the class uses now: an author reattaches their own note;
 * a thread is placed by its author or an instructor. The anchor keeps the mark's anchor kind.
 */
export const placeMark = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/placements',
  scope: { kind: 'class', role: 'any' },
  summary: 'Place an annotation or discussion on the revision the class uses now',
  params: classParams,
  body: z.union([
    z.object({ annotationId: z.uuid(), anchor }).strict(),
    z.object({ threadId: z.uuid(), anchor }).strict(),
  ]),
  response: placementView,
  examples: {
    params: { classId: exampleClass },
    body: { threadId: exampleThread, anchor: { kind: 'none' } },
  },
});
