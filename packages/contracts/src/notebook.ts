import { z } from 'zod';

/**
 * The notebook import contract (§10.7): the Jupyter notebook format, nbformat 4.5
 * (https://nbformat.readthedocs.io/en/latest/format_description.html). Earlier 4.x files are
 * accepted in the same shape; their cells have no `id`, so ingestion numbers them. Fields the
 * renderer does not use pass through unchecked, as the format allows extra metadata.
 */

/** Text in a notebook is one string or a list of lines that join into one. */
const multiline = z.union([z.string(), z.array(z.string())]);

/** One output's representations by MIME type; JSON types hold objects, the rest text. */
const mimeBundle = z.record(z.string(), z.unknown());

const metadata = z.record(z.string(), z.unknown());

/** nbformat 4.5 cell ids: 1–64 letters, digits, `-` and `_`. */
export const NOTEBOOK_CELL_ID = /^[a-zA-Z0-9_-]{1,64}$/;

const executionCount = z.int().min(0).nullable();

const nbOutput = z.discriminatedUnion('output_type', [
  z.looseObject({
    output_type: z.literal('execute_result'),
    execution_count: executionCount,
    data: mimeBundle,
    metadata: metadata.optional(),
  }),
  z.looseObject({
    output_type: z.literal('display_data'),
    data: mimeBundle,
    metadata: metadata.optional(),
  }),
  z.looseObject({
    output_type: z.literal('stream'),
    name: z.string(),
    text: multiline,
  }),
  z.looseObject({
    output_type: z.literal('error'),
    ename: z.string(),
    evalue: z.string(),
    traceback: z.array(z.string()),
  }),
]);
export type NbOutput = z.output<typeof nbOutput>;

const cellBase = {
  id: z.string().regex(NOTEBOOK_CELL_ID).optional(),
  metadata: metadata.default({}),
  source: multiline,
};

const nbCell = z.discriminatedUnion('cell_type', [
  z.looseObject({
    ...cellBase,
    cell_type: z.literal('markdown'),
    attachments: z.record(z.string(), mimeBundle).optional(),
  }),
  z.looseObject({
    ...cellBase,
    cell_type: z.literal('code'),
    execution_count: executionCount,
    outputs: z.array(nbOutput),
  }),
  z.looseObject({
    ...cellBase,
    cell_type: z.literal('raw'),
    attachments: z.record(z.string(), mimeBundle).optional(),
  }),
]);
export type NbCell = z.output<typeof nbCell>;

export const nbformatNotebook = z
  .looseObject({
    nbformat: z.literal(4, { error: 'Only nbformat 4 notebooks can be imported' }),
    nbformat_minor: z.int().min(0),
    metadata: z.looseObject({
      kernelspec: z.looseObject({ name: z.string(), display_name: z.string() }).optional(),
      language_info: z.looseObject({ name: z.string() }).optional(),
    }),
    cells: z.array(nbCell),
  })
  .superRefine((nb, ctx) => {
    // From 4.5 every cell has an id, unique within the notebook.
    if (nb.nbformat_minor < 5) return;
    const seen = new Set<string>();
    nb.cells.forEach((cell, i) => {
      if (cell.id === undefined) {
        ctx.addIssue({ code: 'custom', path: ['cells', i, 'id'], message: 'A cell has no id' });
      } else if (seen.has(cell.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cells', i, 'id'],
          message: 'Two cells share an id',
        });
      } else seen.add(cell.id);
    });
  });
export type NbNotebook = z.output<typeof nbformatNotebook>;

/** Joins a multiline field as nbformat defines it. */
export const joinLines = (text: string | string[]): string =>
  Array.isArray(text) ? text.join('') : text;

/**
 * Parses and checks the bytes of an `.ipynb` file: the notebook, or the reason to show the
 * editor (the first problem found, with where it is).
 */
export function parseNotebook(
  text: string,
): { ok: true; notebook: NbNotebook } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not a Jupyter notebook: it is not valid JSON' };
  }
  if (typeof json === 'object' && json !== null && 'nbformat' in json && json.nbformat !== 4) {
    return {
      ok: false,
      error: 'Only nbformat 4 notebooks can be imported; save it with Jupyter 4 or later',
    };
  }
  const parsed = nbformatNotebook.safeParse(json);
  if (parsed.success) return { ok: true, notebook: parsed.data };
  const [issue] = parsed.error.issues;
  const where = issue?.path.length ? ` (at ${issue.path.join('.')})` : '';
  return {
    ok: false,
    error: `The file is not a valid nbformat 4 notebook: ${issue?.message ?? 'unknown problem'}${where}`,
  };
}

/* ---------------------------------------------------------------------------------------------
 * The rendered notebook as the reader receives it. Ingestion builds it once per revision; only
 * the links to objects on the content origin are added at read time.
 * ------------------------------------------------------------------------------------------- */

/** One table cell of a stored table output, as text. */
export const notebookTableCell = z.object({
  text: z.string(),
  header: z.boolean(),
  colSpan: z.int().min(1).max(1000).optional(),
  rowSpan: z.int().min(1).max(1000).optional(),
});

const outputBase = {
  /** `Out [n]` of an execute result; null for display data, streams and errors. */
  executionCount: z.int().nullable(),
};

const textOutput = z.object({
  ...outputBase,
  type: z.literal('text'),
  /** `stdout` / `stderr` for a stream; null for a `text/plain` result. */
  stream: z.enum(['stdout', 'stderr']).nullable(),
  text: z.string(),
  truncated: z.boolean(),
});
const errorOutput = z.object({
  ...outputBase,
  type: z.literal('error'),
  name: z.string(),
  value: z.string(),
  traceback: z.string(),
  truncated: z.boolean(),
});
const tableOutput = z.object({
  ...outputBase,
  type: z.literal('table'),
  caption: z.string().nullable(),
  head: z.array(z.array(notebookTableCell)),
  body: z.array(z.array(notebookTableCell)),
  /** Text after the table, such as pandas' "5 rows × 3 columns". */
  notes: z.array(z.string()),
});
/** Markdown or LaTeX output, rendered and sanitised like a native reading. */
const markdownOutput = z.object({ ...outputBase, type: z.literal('markdown'), html: z.string() });
/** Representations that need a live kernel or scripts (widgets, JavaScript). */
const unsupportedOutput = z.object({
  ...outputBase,
  type: z.literal('unsupported'),
  mimeTypes: z.array(z.string()),
});
const htmlFields = {
  ...outputBase,
  type: z.literal('html'),
  /** Estimated frame height in CSS pixels. */
  height: z.int().min(1),
  /** The stored output held scripts or event handlers; they were removed and never run. */
  scriptsRemoved: z.boolean(),
};

/** Outputs as stored in `derived.notebook`: objects are named by storage key. */
const storedOutput = z.discriminatedUnion('type', [
  textOutput,
  errorOutput,
  z.object({
    ...outputBase,
    type: z.literal('image'),
    key: z.string(),
    contentType: z.string(),
    alt: z.string(),
    /** An SVG held script or event handlers; they were removed (§13). Absent otherwise. */
    scriptsRemoved: z.boolean().optional(),
  }),
  tableOutput,
  /** A whole HTML document on the content origin, shown in a sandboxed frame. */
  z.object({ ...htmlFields, key: z.string() }),
  markdownOutput,
  unsupportedOutput,
]);
export type StoredNotebookOutput = z.output<typeof storedOutput>;

const cellShape = <O extends z.ZodType>(output: O) =>
  z.discriminatedUnion('type', [
    z.object({
      id: z.string(),
      type: z.literal('markdown'),
      /** Sanitised with the reading allow-list; images carry `data-object-key` until read time. */
      html: z.string(),
    }),
    z.object({ id: z.string(), type: z.literal('raw'), text: z.string() }),
    z.object({
      id: z.string(),
      type: z.literal('code'),
      source: z.string(),
      executionCount: z.int().nullable(),
      /** The notebook's own collapsed state (`metadata.jupyter.source_hidden` / `outputs_hidden`). */
      sourceHidden: z.boolean(),
      outputsHidden: z.boolean(),
      outputs: z.array(output),
    }),
  ]);

export const notebookHeading = z.object({
  cellId: z.string(),
  level: z.int().min(1).max(6),
  text: z.string(),
});

const notebookShape = <O extends z.ZodType>(output: O) =>
  z.object({
    /** The kernel the outputs were stored with, as the notebook names it (`Python 3`). */
    kernel: z.string().nullable(),
    language: z.string().nullable(),
    cells: z.array(cellShape(output)),
    /** Headings of Markdown cells, in order, for the outline. */
    outline: z.array(notebookHeading),
  });

export const storedNotebook = notebookShape(storedOutput);
export type StoredNotebook = z.output<typeof storedNotebook>;

/** Outputs as the reader receives them: stored objects become short-lived content-origin links. */
export const notebookOutput = z.discriminatedUnion('type', [
  textOutput,
  errorOutput,
  z.object({
    ...outputBase,
    type: z.literal('image'),
    /** Null when no link could be made; the alt text shows instead. */
    url: z.url().nullable(),
    alt: z.string(),
    scriptsRemoved: z.boolean().optional(),
  }),
  tableOutput,
  z.object({ ...htmlFields, url: z.url().nullable() }),
  markdownOutput,
  unsupportedOutput,
]);
export type NotebookOutput = z.output<typeof notebookOutput>;

export const notebookView = notebookShape(notebookOutput);
export type NotebookView = z.output<typeof notebookView>;
