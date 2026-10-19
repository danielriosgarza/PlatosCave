import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { Site } from '../site/load';

/** What a process reads on its standard input: text, or bytes as `sync` (P5-18c) sends them. */
export type Input = string | Uint8Array | Readable;

/**
 * The process runner, which a test replaces: runs `docker` with `args` in `cwd`, with `input` on
 * its standard input. The process's output and errors pass through untouched and unbuffered, and
 * it resolves to the exit code.
 */
export const processes = {
  run(args: string[], cwd: string, input?: Readable): Promise<number> {
    return new Promise((done) => {
      const stdin = input ? 'pipe' : 'inherit';
      const child = spawn('docker', args, { cwd, stdio: [stdin, 'inherit', 'inherit'] });
      // A process that ends before it has read its input leaves the rest unread.
      child.stdin?.on('error', () => {});
      if (input && child.stdin) input.pipe(child.stdin);
      child.on('error', (error) => {
        console.error(`parallax: docker could not be started: ${error.message}`);
        done(127);
      });
      child.on('close', (code) => done(code ?? 1));
    });
  },
};

/** The start of every `docker compose` call (docs/design/site.md §9, §11): both env files, the level's files. */
export const composeArgs = (level: number) => [
  ...['compose', '--env-file', '.env', '--env-file', '.parallax/site.env', '-f', 'compose.yml'],
  ...(level === 2 ? ['-f', 'compose.level2.yml'] : []),
];

/** `docker compose <args>` in the site folder, with `input` on standard input; resolves to the exit code. */
export function compose(site: Site, args: string[], input?: Input): Promise<number> {
  const bytes = typeof input === 'string' || input instanceof Uint8Array;
  const stream = bytes ? Readable.from([input]) : input;
  return processes.run([...composeArgs(site.config.level), ...args], site.root, stream);
}

/**
 * Runs `script` of the server image in a one-off `server` container, on the networks that reach
 * the database, with `input` on its standard input, so no value is on a command line: `apply`
 * sends its document so, and `sync` (P5-18c) a byte stream.
 */
export const runInServer = (site: Site, script: string, input: Input) =>
  compose(site, ['run', '--rm', '-T', 'server', 'node_modules/.bin/tsx', script], input);

/** What a command that needs a server says at level 0, which has none (§5). */
export function noServer(command: string): number {
  console.error(`parallax ${command}: level 0 has no server; ${command} is for levels 1 and 2.`);
  return 1;
}
