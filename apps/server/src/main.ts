import { buildApp } from './app';
import { loadConfig } from './config';

const mode = process.argv[2] ?? 'api';
if (mode !== 'api') {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

const config = loadConfig();
const app = await buildApp(config);
await app.listen({ port: config.PORT, host: config.HOST });

const stop = () => {
  app.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
