import { z } from 'zod';
import { defineRoute } from '../define';

const example = '00000000-0000-4000-8000-000000000000';

/**
 * "Preview as student" of the course draft (§3, §12, ADR-0002): the browser's session becomes
 * the caller's preview principal in one class they teach, which studies the draft snapshot
 * with that class's student rules. The instructor's own session is kept aside for the exit.
 * 404 when the class is not one the caller teaches in this course, or the topic is not in its
 * draft.
 */
export const startPreview = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/preview',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Start a student preview of the course draft in a class the caller teaches',
  params: z.object({ courseId: z.uuid() }),
  body: z.object({
    classId: z.uuid(),
    /** The topic being edited; leaving the preview returns to its editor. */
    topicId: z.uuid().optional(),
  }),
  response: z.object({
    classId: z.uuid(),
    preview: z.object({ id: z.uuid(), name: z.string() }),
    expiresAt: z.iso.datetime({ offset: true }),
    /**
     * App path the preview opens on, read as the preview student: the topic's saved tab, else
     * its first tab with material, else the class's topic list.
     */
    landing: z.string(),
  }),
  examples: { params: { courseId: example }, body: { classId: example, topicId: example } },
});

/**
 * Leaves the draft preview: ends the preview session and restores the instructor's session
 * when it is still valid (`restored`), else signs the browser out. `returnTo` is the editor the
 * preview started from. Public, so a browser whose preview session already ended (expired, or
 * replaced by a later start) still gets its instructor session back. 409 `not_previewing` when
 * the browser's session is a person's own, or it holds neither a session nor a kept one.
 */
export const exitPreview = defineRoute({
  method: 'POST',
  path: '/api/preview/exit',
  scope: { kind: 'public' },
  summary: 'Leave the draft preview and return to the instructor session and editor',
  response: z.object({ restored: z.boolean(), returnTo: z.string() }),
  errors: { 409: z.object({ error: z.literal('not_previewing') }) },
  examples: {},
});
