import { strokesToSvg } from '@parallax/contracts';
import type { Annotation } from '../margin/data';

/** The default proportions of a figure and of a page, for a surface never drawn in this view. */
export const FIGURE_ASPECT = 0.6;
export const PAGE_ASPECT = 1.414;

/** A saved sketch as an SVG document: its strokes, with the description as the accessible text. */
export function sketchSvg(annotation: Annotation, label: string, aspect: number): string {
  const strokes =
    annotation.anchor.kind === 'figure' || annotation.anchor.kind === 'pdf'
      ? (annotation.anchor.strokes ?? [])
      : [];
  return strokesToSvg(strokes, {
    aspect,
    title: `Sketch · ${label}`,
    description: annotation.body ?? '',
  });
}

/** Hands the browser the SVG as a download named for the surface. */
export function downloadSvg(svg: string, label: string): void {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `sketch-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.svg`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari and older Firefox start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
