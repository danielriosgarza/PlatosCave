import type { Anchor } from '@parallax/contracts';
import type { Annotation, Thread } from './data';

/** The anchor a mark should sit on today: where the class's revision places it (ADR-0003). */
export function shownAnchor(a: Annotation | Thread): Anchor | null {
  const placement = a.placement;
  if (!placement) return a.anchor;
  if (placement.status === 'needs_reattachment' || placement.status === 'pending') return null;
  return placement.anchor ?? a.anchor;
}
