import { z } from 'zod';
import type { ResourceType } from './resources';

/**
 * Annotation anchors (ADR-0003): where a note, highlight, sketch or thread sits in one
 * resource revision. Anchors reference blocks and normalised page space, never pixels, so
 * zoom, reflow and Focus cannot detach them. Drawings are part of the anchor (`figure`, and
 * `pdf` for sketches on a page), so sharing an annotation shares its drawing.
 */

const unit = z.number().min(0).max(1);
const context = z.string().max(32);

/** A colour as `#rrggbb`, for pens and highlights. */
export const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);

/** Normalised rectangle on a PDF page: 0..1 of the page width and height. */
export const rect = z.object({ x: unit, y: unit, w: unit, h: unit });

/** Freehand drawing in coordinates normalised to the anchor's page or figure (§8). */
export const strokes = z
  .array(
    z.object({
      tool: z.enum(['pen', 'eraser']),
      color: hexColor,
      width: z.number().positive().max(64),
      points: z
        .array(z.tuple([unit, unit]))
        .min(1)
        .max(2000),
    }),
  )
  .max(500);
export type Strokes = z.infer<typeof strokes>;

export const textAnchor = z
  .object({
    kind: z.literal('text'),
    blockId: z.string().regex(/^[0-9a-f]{12}$/),
    /** Code-unit offsets in the block's text content. */
    start: z.int().min(0),
    end: z.int().min(0),
    quote: z.string().min(1).max(2000),
    prefix: context,
    suffix: context,
  })
  .refine((a) => a.end > a.start, { message: 'end must be after start', path: ['end'] });

export const pdfAnchor = z.object({
  kind: z.literal('pdf'),
  page: z.int().min(0),
  rect,
  quote: z.string().max(2000).optional(),
  /** A sketch on the page, in coordinates normalised to the page. */
  strokes: strokes.optional(),
});

export const slideAnchor = z.object({ kind: z.literal('slide'), page: z.int().min(0) });

/** A native figure or bounded sketch area, with the drawing made on it. */
export const figureAnchor = z.object({
  kind: z.literal('figure'),
  figureId: z.string().min(1).max(100),
  strokes,
});

/** General notes on a resource without a passage (§8 "may exist without a text anchor"). */
export const noAnchor = z.object({ kind: z.literal('none') });

export const anchor = z.discriminatedUnion('kind', [
  textAnchor,
  pdfAnchor,
  slideAnchor,
  figureAnchor,
  noAnchor,
]);
export type Anchor = z.infer<typeof anchor>;

/**
 * Anchor kinds each resource type can place (ADR-0003 "produced by"): text blocks in native
 * readings and web slides, pages in PDFs, slides in decks, figures in native readings. Other
 * types take general notes only.
 */
export const anchorKindsByType: Record<ResourceType, readonly Anchor['kind'][]> = {
  reading_native: ['text', 'figure', 'none'],
  reading_pdf: ['pdf', 'none'],
  slides_web: ['text', 'slide', 'none'],
  slides_pdf: ['pdf', 'slide', 'none'],
  exercise: ['none'],
  notebook: ['none'],
  shiny: ['none'],
  test: ['none'],
};

/**
 * Whether `anchor` can be placed on a revision of `resourceType`. A type missing from the
 * table (the database enum grew first) takes general notes only.
 */
export const anchorFits = (resourceType: ResourceType, a: Anchor): boolean =>
  (anchorKindsByType[resourceType] ?? ['none']).includes(a.kind);
