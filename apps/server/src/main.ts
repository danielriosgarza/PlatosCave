import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';

const mode = process.argv[2] ?? 'api';
if (mode !== 'api') {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

const config = loadConfig();
// The pool is created before the app (and its logger); errors go to the app logger once it exists.
let logPoolError = (err: Error) => console.error('pg pool error', err);
const database = config.DATABASE_URL
  ? createDb(config.DATABASE_URL, { onError: (err) => logPoolError(err) })
  : undefined;
const app = await buildApp(config, database ? { db: database.db } : {});
logPoolError = (err) => app.log.error({ err }, 'pg pool error');
await app.listen({ port: config.PORT, host: config.HOST });

let stopping = false;
const stop = () => {
  if (stopping) process.exit(1); // second signal forces exit if close() hangs
  stopping = true;
  app
    .close()
    .then(() => database?.pool.end())
    .then(
      () => process.exit(0),
      (err) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
