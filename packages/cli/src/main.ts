import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSite, type Site, SiteProblems } from './site/load';

/**
 * One command is one module `src/commands/<name>.ts` that exports `run`, found as the server
 * finds its route modules: a later unit adds a file and edits no list (docs/design/site.md §5).
 * `run` gets the loaded site and resolves to the exit code.
 */
export interface Command {
  run(context: { site: Site; args: string[] }): Promise<number>;
}

/** `cwd` is the site folder and `commands` the folder of the command modules. */
type Options = { cwd?: string; commands?: string; print?: (line: string) => void };

/** `parallax <command> [arguments]`; resolves to the exit code. */
export async function main(argv: string[], options: Options = {}): Promise<number> {
  const { cwd = process.cwd(), print = console.error } = options;
  const commands = options.commands ?? join(import.meta.dirname, 'commands');
  // A name is letters, digits and hyphens, so a test file or a declaration file is no command.
  const names = (existsSync(commands) ? readdirSync(commands) : [])
    .flatMap((file) => /^([a-z][a-z0-9-]*)\.ts$/.exec(file)?.[1] ?? [])
    .sort();
  const [name, ...args] = argv;
  if (!name || !names.includes(name)) {
    print(name ? `parallax: unknown command ${name}` : 'usage: parallax <command>');
    print(`Commands: ${names.join(', ') || 'none'}`);
    return 1;
  }
  try {
    // Every command first loads the site, so a problem stops it before it writes anything.
    const site = await loadSite(cwd);
    const command: Command = await import(pathToFileURL(join(commands, `${name}.ts`)).href);
    return await command.run({ site, args });
  } catch (error) {
    if (!(error instanceof SiteProblems)) throw error;
    for (const line of error.lines) print(line);
    return 1;
  }
}
