/**
 * Tabs of one browser share one session cookie, so starting or leaving a draft preview in one
 * tab changes who every other tab acts as. The tab that changed it says so here; the others
 * re-read the session at once instead of after their cache goes stale.
 */
const CHANNEL = 'parallax-session';

export function announceSessionChange(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage('changed');
  channel.close();
}

/** Calls `listener` when another tab announces a session change; returns the unsubscribe. */
export function onSessionChange(listener: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = () => listener();
  // Node's channel (tests) would otherwise keep the process alive.
  (channel as { unref?: () => void }).unref?.();
  return () => channel.close();
}
