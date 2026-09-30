import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';

const mode = process.argv[2] ?? 'api';
if (mode !== 'api') {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

const config = loadConfig();
const database = config.DATABASE_URL ? createDb(config.DATABASE_URL) : undefined;
const app = await buildApp(config, database ? { db: database.db } : {});
await app.listen({ port: config.PORT, host: config.HOST });

const stop = () => {
  app
    .close()
    .then(() => database?.pool.end())
    .then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
