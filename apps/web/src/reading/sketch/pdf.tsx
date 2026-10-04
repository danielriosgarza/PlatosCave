import type { ReactNode } from 'react';
import { SketchControls, SketchLayer, SketchTools } from './Surface';
import type { Sketches } from './useSketches';

/** What the margin gives a PDF reader so pages can be sketched on (§8: a PDF page is a surface). */
export interface PdfSketch {
  /** A sketch is open: the reader holds its page until Done or Discard, so no work is lost. */
  busy: boolean;
  /** A page the margin asked to see (Edit on a sketch of another page); `seq` makes each ask new. */
  show: { page: number; seq: number } | null;
  tools(page: number): ReactNode;
  layer(page: number): ReactNode;
  panel(page: number): ReactNode;
}

/** `page` is 1-based, as the reader counts; anchors are 0-based. */
export function pdfSketch(api: Sketches, show: { page: number; seq: number } | null): PdfSketch {
  const surface = (page: number) => ({ kind: 'page' as const, page: page - 1 });
  return {
    busy: api.open !== null,
    show,
    tools: (page) => <SketchTools surface={surface(page)} api={api} label={`Page ${page}`} />,
    layer: (page) => <SketchLayer surface={surface(page)} api={api} label={`Page ${page}`} />,
    panel: (page) => <SketchControls surface={surface(page)} api={api} label={`Page ${page}`} />,
  };
}
