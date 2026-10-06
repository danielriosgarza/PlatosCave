import { afterEach } from 'vitest';
import { draftWriteHold } from '../reading/margin/drafts';

/**
 * Keeps the device's draft deletes uncommitted until the returned function is called; the hold is
 * dropped after every test. The real `removeDraft` still registers its pending write first.
 * Calling it again while a hold is in place returns the same release.
 */
const releases: (() => void)[] = [];

export function holdDraftDeletes(): () => void {
  if (draftWriteHold.deletes) return () => releaseAll();
  draftWriteHold.deletes = new Promise<void>((resolve) => releases.push(resolve));
  return releaseAll;
}

function releaseAll() {
  draftWriteHold.deletes = null;
  for (const release of releases.splice(0)) release();
}

afterEach(() => {
  // A test that failed before letting go must not leave later tests waiting on its delete.
  releaseAll();
});
