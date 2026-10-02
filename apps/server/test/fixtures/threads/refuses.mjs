// Says its input cannot be processed (runInThread tests).
import { parentPort } from 'node:worker_threads';

parentPort?.postMessage({ ok: false });
