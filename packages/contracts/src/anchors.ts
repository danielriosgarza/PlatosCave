import { z } from 'zod';

/**
 * Annotation anchors (ADR-0003): where a note, highlight, sketch or thread sits in one
 * resource revision. Anchors reference blocks and normalised page space, never pixels, so
 * zoom, reflow and Focus cannot detach them.
 */

const unit = z.number().min(0).max(1);
const context = z.string().max(32);

/** Normalised rectangle on a PDF page: 0..1 of the page width and height. */
export const rect = z.object({ x: unit, y: unit, w: unit, h: unit });

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
});

export const slideAnchor = z.object({ kind: z.literal('slide'), page: z.int().min(0) });

/** A native figure or bounded sketch area; the drawing itself is the annotation's `strokes`. */
export const figureAnchor = z.object({
  kind: z.literal('figure'),
  figureId: z.string().min(1).max(100),
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

/** Freehand drawing in coordinates normalised to the anchor's page or figure (§8). */
export const strokes = z
  .array(
    z.object({
      tool: z.enum(['pen', 'eraser']),
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      width: z.number().positive().max(64),
      points: z
        .array(z.tuple([unit, unit]))
        .min(1)
        .max(2000),
    }),
  )
  .max(500);
export type Strokes = z.infer<typeof strokes>;
