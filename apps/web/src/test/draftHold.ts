import { afterEach } from 'vitest';
import { draftWriteHold } from '../reading/margin/drafts';

/**
 * Keeps the device's draft deletes uncommitted until the returned function is called; the hold is
 * dropped after every test. The real `removeDraft` still registers its pending write first.
 */
let release: () => void = () => {};

export function holdDraftDeletes(): () => void {
  draftWriteHold.deletes = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

afterEach(() => {
  // A test that failed before letting go must not leave later tests waiting on its delete.
  release();
  draftWriteHold.deletes = null;
});
