// Replies with the byte length it received (runInThread tests).
import { parentPort, workerData } from 'node:worker_threads';

parentPort?.postMessage({ ok: true, value: workerData.byteLength });
