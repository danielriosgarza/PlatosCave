import { z } from 'zod';
import { defineRoute } from '../define';
import { notebookView } from '../notebook';

/**
 * The Notebooks tab (§10.1, §10.7): the rendered notebooks of a topic and one notebook with its
 * stored outputs. Nothing here runs code; HTML outputs and images are links to the content
 * origin, minted for the caller and short-lived.
 */

const exampleClass = '00000000-0000-4000-8000-000000000000';
const exampleTopic = '00000000-0000-4000-8000-0000000000aa';
const exampleRevision = '00000000-0000-4000-8000-0000000000bb';

export const notebookSummary = z.object({
  resourceId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string(),
  /** A Jupyter notebook or an embedded Shiny app; the tab shows each its own way. */
  type: z.enum(['notebook', 'shiny']),
});

export const listNotebooks = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/topics/:topicId/notebooks',
  scope: { kind: 'class', role: 'any' },
  summary: 'The notebooks of a topic the caller may open',
  params: z.object({ classId: z.uuid(), topicId: z.uuid() }),
  response: z.object({ notebooks: z.array(notebookSummary) }),
  examples: { params: { classId: exampleClass, topicId: exampleTopic } },
});

export const getNotebook = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:revisionId/notebook',
  scope: { kind: 'class', role: 'any' },
  summary: 'One notebook of the class release, rendered with its stored outputs; never executed',
  params: z.object({ classId: z.uuid(), revisionId: z.uuid() }),
  response: z.object({
    revisionId: z.uuid(),
    title: z.string(),
    /** `pending` while the import job runs; `failed` carries its reason. */
    status: z.enum(['ready', 'pending', 'failed']),
    error: z.string().nullable(),
    /** Storage key of the `.ipynb` file, the `:key` of the object route's attachment download. */
    sourceKey: z.string().nullable(),
    notebook: notebookView.nullable(),
  }),
  examples: { params: { classId: exampleClass, revisionId: exampleRevision } },
});

export const getShiny = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:revisionId/shiny',
  scope: { kind: 'class', role: 'any' },
  summary: 'A Shiny resource of the class release with its address, if its origin is approved',
  params: z.object({ classId: z.uuid(), revisionId: z.uuid() }),
  response: z.object({
    revisionId: z.uuid(),
    title: z.string(),
    /** `unapproved`: the address is on an origin the host has not approved, so it is neither framed nor linked. */
    status: z.enum(['ready', 'unapproved']),
    url: z.string().nullable(),
    /** The origin messages from the frame must come from; null with `unapproved`. */
    origin: z.string().nullable(),
  }),
  examples: { params: { classId: exampleClass, revisionId: exampleRevision } },
});
