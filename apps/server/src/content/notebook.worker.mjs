// Renders one notebook off the job worker's event loop (see notebook-render.ts); tsx's loader is
// registered here for the same reason as in reading.worker.mjs. A notebook that fails the import
// contract answers with its reason; any other failure of the render is the notebook's too.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { renderNotebook, NotebookError } = await import('./notebook.ts');
let reply;
try {
  const { text, prefix } = workerData;
  reply = { ok: true, value: renderNotebook(text, prefix) };
} catch (err) {
  reply = { ok: false, ...(err instanceof NotebookError && { error: err.message }) };
}
parentPort?.postMessage(reply);
