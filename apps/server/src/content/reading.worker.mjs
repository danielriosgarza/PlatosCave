// Renders one native reading off the job worker's event loop (see reading-render.ts). The
// pipeline is TypeScript, so the thread registers tsx's loader before importing it. A failing
// import is left to fail the thread (the job retries); only a failing render is the reading's.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { renderReading } = await import('./reading.ts');
let reply;
try {
  const { source, format, assets } = workerData;
  reply = { ok: true, value: renderReading(source, format, assets) };
} catch {
  reply = { ok: false };
}
parentPort?.postMessage(reply);
