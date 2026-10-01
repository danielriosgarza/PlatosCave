// Runs the hungry script through runInThread and prints how it failed. Spawned by thread.test.ts
// without NODE_OPTIONS: a process-wide --max-old-space-size overrides a thread's heap cap.
import { runInThread, ThreadInputError } from '../../../src/content/thread';

const messages = { failed: 'refused', timeout: 'too slow', outOfMemory: 'too big' };
const outcome = await runInThread(new URL('./hungry.mjs', import.meta.url), null, messages, {
  timeoutMs: 20_000,
  maxHeapMb: 32,
}).then(
  () => 'answered',
  (err: Error) => `${err instanceof ThreadInputError ? 'final' : 'retry'}: ${err.message}`,
);
console.log(outcome);
