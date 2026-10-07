// Checks one submitted notebook off the event loop (see submission-check.ts); tsx's loader is
// registered here for the same reason as in notebook.worker.mjs. A notebook that fails the check
// answers with its reason; any other failure is the input's too.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { parseNotebook } = await import('@parallax/contracts');
const { MAX_SUBMISSION_CELLS } = await import('@parallax/contracts/routes/notebookSubmissions');
const { notebookEnvironment } = await import('./submission.ts');
let reply;
try {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(workerData.bytes);
  const parsed = parseNotebook(text, { maxCells: MAX_SUBMISSION_CELLS });
  reply = parsed.ok
    ? { ok: true, value: notebookEnvironment(parsed.notebook) }
    : { ok: false, error: parsed.error };
} catch (err) {
  if (err instanceof TypeError) reply = { ok: false, error: 'The text is not valid UTF-8' };
  else reply = { ok: false };
}
parentPort?.postMessage(reply);
