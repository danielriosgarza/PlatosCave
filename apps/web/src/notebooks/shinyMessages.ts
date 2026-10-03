/**
 * What a Shiny frame may tell the page (§10.7). Only readiness and a height are accepted, and
 * only from the approved origin and the frame itself. Everything else is ignored: a browser
 * message from an app is never a grade, a score or a completion. A graded Shiny task returns its
 * result through an authenticated server adapter, which this page does not touch.
 */
export type ShinyMessage = { type: 'ready' } | { type: 'resize'; height: number };

export const MIN_FRAME_HEIGHT = 240;
export const MAX_FRAME_HEIGHT = 4000;

export function readShinyMessage(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  approved: { origin: string; frame: Window | null },
): ShinyMessage | null {
  if (event.origin !== approved.origin) return null;
  if (approved.frame === null || event.source !== approved.frame) return null;
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) return null;
  const { type, height } = data as { type?: unknown; height?: unknown };
  if (type === 'ready') return { type: 'ready' };
  if (type === 'resize' && typeof height === 'number' && Number.isFinite(height)) {
    return {
      type: 'resize',
      height: Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(height))),
    };
  }
  return null;
}
