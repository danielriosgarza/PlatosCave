import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SketchControls, SketchLayer, SketchTools } from './Surface';
import type { Sketches, Surface } from './useSketches';

interface Hosts {
  surface: Surface;
  label: string;
  head: HTMLElement;
  layer: HTMLElement;
  panel: HTMLElement;
}

const MEDIA = 'img, svg, picture, canvas, video';

/** Lays `layer` over the figure's picture (or the whole figure), in figure-relative pixels. */
function place(figure: HTMLElement, layer: HTMLElement) {
  const media = figure.querySelector<HTMLElement>(MEDIA);
  const f = figure.getBoundingClientRect();
  const m = (media ?? figure).getBoundingClientRect();
  layer.style.left = `${m.left - f.left}px`;
  layer.style.top = `${m.top - f.top}px`;
  layer.style.width = `${m.width}px`;
  layer.style.height = `${m.height}px`;
}

/** Number of the figure within the reading, for the labels a reader sees. */
export const figureLabel = (root: HTMLElement | null, figureId: string): string => {
  const figures = root ? [...root.querySelectorAll<HTMLElement>('figure[data-figure-id]')] : [];
  const index = figures.findIndex((f) => f.dataset.figureId === figureId);
  return index >= 0 ? `Figure ${index + 1}` : 'Figure';
};

/**
 * Adds the Sketch actions to every figure of a native reading: a head row above the figure, the
 * ink over its picture, and the open sketch's controls under its caption. The HTML is the
 * reading's own, so these are portals into elements added beside it (as the selection toolbar
 * is), rebuilt whenever the HTML is.
 */
export function FigureSketches({
  root,
  html,
  api,
}: {
  root: HTMLElement | null;
  html: string | null;
  api: Sketches;
}) {
  const [hosts, setHosts] = useState<Hosts[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the figures change with the html
  useLayoutEffect(() => {
    if (!root || html === null) return setHosts([]);
    const made: Hosts[] = [];
    const watchers: (() => void)[] = [];
    for (const figure of root.querySelectorAll<HTMLElement>('figure[data-figure-id]')) {
      const figureId = figure.dataset.figureId ?? '';
      const head = document.createElement('div');
      const layer = document.createElement('div');
      const panel = document.createElement('div');
      layer.style.position = 'absolute';
      layer.style.pointerEvents = 'none';
      // The tools row and the panel lie above the ink layer, which on a figure without a picture
      // covers the whole figure: their buttons must stay reachable while a sketch is drawn.
      for (const host of [head, panel]) {
        host.style.position = 'relative';
        host.style.zIndex = '1';
      }
      figure.prepend(head);
      figure.append(layer, panel);
      const move = () => place(figure, layer);
      move();
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(move);
        observer.observe(figure);
        const media = figure.querySelector(MEDIA);
        if (media) observer.observe(media);
        watchers.push(() => observer.disconnect());
      }
      figure.addEventListener('load', move, true);
      watchers.push(() => figure.removeEventListener('load', move, true));
      made.push({
        surface: { kind: 'figure', figureId },
        label: figureLabel(root, figureId),
        head,
        layer,
        panel,
      });
    }
    setHosts(made);
    return () => {
      for (const stop of watchers) stop();
      for (const h of made) {
        h.head.remove();
        h.layer.remove();
        h.panel.remove();
      }
    };
  }, [root, html]);

  return (
    <>
      {hosts.map((h) => (
        <FigureHost
          key={h.surface.kind === 'figure' ? h.surface.figureId : ''}
          hosts={h}
          api={api}
        />
      ))}
    </>
  );
}

function FigureHost({ hosts, api }: { hosts: Hosts; api: Sketches }) {
  const { surface, label } = hosts;
  return (
    <>
      {createPortal(<SketchTools surface={surface} api={api} label={label} />, hosts.head)}
      {createPortal(<SketchLayer surface={surface} api={api} label={label} />, hosts.layer)}
      {createPortal(<SketchControls surface={surface} api={api} label={label} />, hosts.panel)}
    </>
  );
}
