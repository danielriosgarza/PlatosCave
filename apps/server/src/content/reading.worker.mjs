// Renders one native reading, or a Markdown slide deck, off the job worker's event loop (see reading-render.ts). The
// pipeline is TypeScript with extensionless imports. A worker does not get tsx's resolution
// from its parent (the inherited `--import` hooks do not serve it, and Node's own type stripping
// does not resolve `./text`), so the thread registers tsx's loader itself. A failing import is
// left to fail the thread (the job retries); only a failing render is the reading's.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { renderReading, renderSlides } = await import('./reading.ts');
let reply;
try {
  const { source, format, assets, deck } = workerData;
  reply = { ok: true, value: deck ? renderSlides(source) : renderReading(source, format, assets) };
} catch {
  reply = { ok: false };
}
parentPort?.postMessage(reply);
