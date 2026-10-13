import { z } from 'zod';
import { folderId } from './courseFolder';
import {
  NOTEBOOK_CELL_ID,
  type NotebookOutput,
  type NotebookView,
  notebookView,
  type StoredNotebook,
  type StoredNotebookOutput,
} from './notebook';
import { type Tab, tabs } from './resources';
import { shinyAddressProblem } from './shiny';

/**
 * The open site, level 0 (docs/design/open-site.md §2 and §3): the data files `parallax build`
 * writes and the viewer reads, the notebook file offered for download, and the addresses both use.
 * Each schema is an allow-list, strict at every level but one (`notebook`, below): it has no field
 * for a definition, an answer, feedback, a hint, a solution, a check, a rubric, a release date, a
 * class, an account, a grade or a saved place, and a key it does not name is refused. A writer
 * serialises the parse result, never its input. The web application imports the index, so no Node
 * built-in.
 */

const text = z.string();
const title = text;
const on = z.boolean();
/** The permanent address of an object on the content origin. The viewer links to it: http(s). */
const objectUrl = z.url({ protocol: /^https?$/ });

/** `ref` is the course reference (`courseRef`), which stands for a class id and a course id. */
const courses = z.array(z.strictObject({ ref: text.min(1), title }));
/** `catalogue.json`: display names and titles, and no address of an instructor. */
export const openCatalogue = z.strictObject({
  mode: z.enum(['instructor', 'school']),
  instructors: z.array(z.strictObject({ name: text, courses })),
});
export type OpenCatalogue = z.output<typeof openCatalogue>;

/** Which tabs list at least one resource. */
const shown = z.strictObject({ slides: on, reading: on, exercises: on, notebooks: on, tests: on });
/** `course.json`: the topic index, as `getClassTopics` without what needs an account or a date. */
export const openCourse = z.strictObject({
  title,
  instructors: z.array(text),
  topics: z.array(
    z.strictObject({
      /** The topic's folder id. */
      topicId: folderId,
      /** 1-based place in the syllabus. */
      number: z.int(),
      title,
      objective: text,
      estimatedMinutes: z.int().nullable(),
      presence: shown,
      firstTab: z.enum(tabs).nullable(),
    }),
  ),
});
export type OpenCourse = z.output<typeof openCourse>;

const kind = z.enum(['native', 'pdf']);
/** A resource in the list of a tab: its folder id and its title. */
const listed = { resourceId: folderId, title };
/** All that is written of an exercise or a test: no data file exists for one. */
const titleOnly = z.array(z.strictObject(listed));

/** `topic.json`: the lists of the five tabs. */
export const openTopic = z.strictObject({
  slides: titleOnly,
  reading: z.array(z.strictObject({ ...listed, kind })),
  notebooks: z.array(z.strictObject({ ...listed, type: z.enum(['notebook', 'shiny']) })),
  exercises: titleOnly,
  tests: titleOnly,
});
export type OpenTopic = z.output<typeof openTopic>;

const pdf = z.strictObject({ url: objectUrl, pageCount: z.int().min(1) }).nullable();
/** A web deck: the sanitised HTML of each slide, in order. */
const web = z.strictObject({ slides: z.array(text).min(1) }).nullable();
const shiny = { type: z.literal('shiny'), title, url: text, origin: text.nullable() };
const NO_ORIGIN = 'expected the origin of url, or null';

/**
 * `<resource id>.json`: one deck, reading, notebook or Shiny app; no branch is an exercise or a
 * test. `notebook` is the rendered view as it is, which is not strict: a key it does not name is
 * dropped from the parse result, not refused. `file` is the notebook file composed for download
 * (`openNotebookFile`), not the stored `.ipynb`. A Shiny app's link is shown whatever its origin,
 * so its `url` is held to the address rule of the contracts; `origin` is what lets it be framed.
 */
export const openResource = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('slides'), title, pdf, web }),
  z.strictObject({ type: z.literal('reading'), title, kind, html: text.nullable(), pdf }),
  z.strictObject({ type: z.literal('notebook'), title, file: objectUrl, notebook: notebookView }),
  z.strictObject(shiny).superRefine(({ url, origin }, ctx) => {
    const problem = shinyAddressProblem(url);
    if (problem) ctx.addIssue({ code: 'custom', path: ['url'], message: problem });
    else if (origin !== null && origin !== new URL(url).origin) {
      ctx.addIssue({ code: 'custom', path: ['origin'], message: NO_ORIGIN });
    }
  }),
]);
export type OpenResource = z.output<typeof openResource>;

/** A cell keeps its id; a Markdown cell's source is its sanitised rendered HTML. */
const anyCell = { id: text.regex(NOTEBOOK_CELL_ID), metadata: z.strictObject({}), source: text };
const unrun = { cell_type: z.literal('code'), execution_count: z.null(), outputs: z.tuple([]) };

/**
 * The one notebook file a build writes, for download: nbformat 4.5, composed from the rendered
 * view. No field takes an output, an attachment or metadata beyond the language name, so the file
 * holds no stored payload, a JavaScript one included.
 */
export const openNotebookFile = z.strictObject({
  nbformat: z.literal(4),
  nbformat_minor: z.literal(5),
  metadata: z.strictObject({ language_info: z.strictObject({ name: text }).optional() }),
  cells: z.array(
    z.discriminatedUnion('cell_type', [
      z.strictObject({ ...anyCell, cell_type: z.literal(['markdown', 'raw']) }),
      z.strictObject({ ...anyCell, ...unrun }),
    ]),
  ),
});
export type OpenNotebookFile = z.output<typeof openNotebookFile>;

/** The course reference, in folder names: `<course>`, or `<name>/<course>` in school mode. */
export const courseRef = (mode: OpenCatalogue['mode'], instructor: string, course: string) =>
  mode === 'school' ? `${instructor}/${course}` : course;

/** An address below `/courses`: the folder names of `ref`, then `names`, each percent-encoded. */
const below = (ref: string, ...names: string[]) =>
  `/courses/${[...ref.split('/'), ...names].map(encodeURIComponent).join('/')}`;

/**
 * The addresses of the open site, from the site's root, for the build and the viewer. A build
 * writes a data file at the path its address decodes to.
 */
export const openPaths = {
  catalogue: '/courses/catalogue.json',
  course: (ref: string) => below(ref),
  courseData: (ref: string) => `${below(ref)}/course.json`,
  topic: (ref: string, topicId: string, tab: Tab) => below(ref, topicId, tab),
  topicData: (ref: string, topicId: string) => `${below(ref, topicId)}/topic.json`,
  resourceData: (ref: string, topicId: string, resourceId: string) =>
    `${below(ref, topicId, resourceId)}.json`,
};

/** The addresses Parallax keeps at every level: `/courses` and one to four segments below it. */
export const OPEN_ADDRESSES = [
  '/courses',
  '/courses/$a',
  '/courses/$a/$b',
  '/courses/$a/$b/$c',
  '/courses/$a/$b/$c/$d',
] as const;

/** The file extension of each content type an object may have (§2). No JavaScript type is here. */
const EXTENSIONS = new Map([
  ['application/pdf', 'pdf'],
  ['application/x-ipynb+json', 'ipynb'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['text/html; charset=utf-8', 'html'],
]);
/** An object's extension, from which a static host picks its type; undefined stops a build. */
export const objectExtension = (contentType: string) => EXTENSIONS.get(contentType);

type UrlFor = (key: string) => string | null;

/**
 * The read-time step of the notebook route (`notebookView` in the server's `notebooks.routes.ts`,
 * which a build cannot load), restated: `urlFor` gives the address of a stored object, and `html`
 * sets the image addresses of an HTML string (the server's `resolveReadingImages`). A test in the
 * server package holds the two equal.
 */
export function viewNotebook(
  stored: StoredNotebook,
  urlFor: UrlFor,
  html: (html: string, urlFor: UrlFor) => string,
): NotebookView {
  const view = (out: StoredNotebookOutput): NotebookOutput => {
    if (out.type === 'image') {
      const { key, contentType: _type, ...rest } = out;
      return { ...rest, url: urlFor(key) };
    }
    if (out.type === 'html') {
      const { key, ...rest } = out;
      return { ...rest, url: urlFor(key) };
    }
    return out.type === 'markdown' ? { ...out, html: html(out.html, urlFor) } : out;
  };
  return {
    ...stored,
    cells: stored.cells.map((cell) =>
      cell.type === 'code'
        ? { ...cell, outputs: cell.outputs.map(view) }
        : cell.type === 'markdown'
          ? { ...cell, html: html(cell.html, urlFor) }
          : cell,
    ),
  };
}
