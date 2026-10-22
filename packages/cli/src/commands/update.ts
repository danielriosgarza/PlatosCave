import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Command } from '../main';
import { packageRoot } from '../paths';
import { listed, published, type Refreshed, refresh, TEMPLATE, Unapplied } from '../site/template';
import { many, shown } from './check';

const USAGE = 'usage: parallax update [--to <version or npm tag>] [--dry-run]';
/** A version as a release names one (`packages/cli/scripts/release.ts`): no build metadata. */
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const TAG = /^[A-Za-z][\w.-]*$/;
/** The dependency's entry in the text of `package.json`, so that only its value is replaced. */
const ENTRY = /("parallax-site"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
/** Set for the installed tool that an update starts, which therefore starts no other. */
export const HANDOFF = 'PARALLAX_UPDATE_HANDOFF';
const windows = process.platform === 'win32';

/** Whether `a` comes after `b` in the order of semantic versions; both match `VERSION`. */
export function after(a: string, b: string): boolean {
  const [x, y] = [VERSION.exec(a), VERSION.exec(b)];
  if (!x || !y) return false;
  for (const i of [1, 2, 3]) {
    if (x[i] !== y[i]) return Number(x[i]) > Number(y[i]);
  }
  if (x[4] === y[4]) return false;
  if (x[4] === undefined || y[4] === undefined) return x[4] === undefined;
  const [p, q] = [x[4].split('.'), y[4].split('.')];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    const [s, t] = [p[i], q[i]];
    if (s === undefined || t === undefined) return t === undefined;
    if (s === t) continue;
    const [m, n] = [/^\d+$/.test(s), /^\d+$/.test(t)];
    // A numeric identifier comes before a word.
    return m && n ? Number(s) > Number(t) : m === n ? s > t : n;
  }
  return false;
}

/** The processes `update` starts, which a test replaces. Their output passes through. */
export const updating = {
  /** The one version that `npm view parallax-site@<spec> version` names, or why there is none. */
  view(spec: string, cwd: string): Promise<{ version: string } | { why: string }> {
    const args = ['view', `parallax-site@${spec}`, 'version', '--json'];
    return new Promise((done) => {
      execFile('npm', args, { cwd, shell: windows, encoding: 'utf8' }, (error, stdout, stderr) => {
        let named: unknown;
        try {
          named = JSON.parse(stdout);
        } catch {}
        if (typeof named === 'string' && VERSION.test(named)) done({ version: named });
        else if (Array.isArray(named)) done({ why: 'it names more than one' });
        else done({ why: (stderr || error?.message || 'none').trim().split('\n')[0] ?? 'none' });
      });
    });
  },
  /** `npm <args>` in `cwd`; resolves to the exit code. */
  npm(args: string[], cwd: string): Promise<number> {
    return started(spawn('npm', args, { cwd, stdio: 'inherit', shell: windows }), 'npm');
  },
  /** The tool installed in the site, with `args` and `HANDOFF` set; resolves to the exit code. */
  installed(root: string, args: string[]): Promise<number> {
    const bin = join(root, 'node_modules/parallax-site/bin/parallax.mjs');
    const env = { ...process.env, [HANDOFF]: '1' };
    const child = spawn(process.execPath, [bin, ...args], { cwd: root, stdio: 'inherit', env });
    return started(child, 'the installed parallax');
  },
};

function started(child: ReturnType<typeof spawn>, name: string): Promise<number> {
  return new Promise((done) => {
    child.on('error', (error) => {
      console.error(`parallax update: ${name} could not be started: ${error.message}`);
      done(127);
    });
    child.on('close', (code) => done(code ?? 1));
  });
}

/** The version in the manifest of the package at `dir`, if it has one. */
function versionAt(dir: string): string | undefined {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

const NAME = 'Name one with --to <version>.';
const RECORD = '.parallax-template.json';
type Manifest = { dependencies?: Record<string, string> };

/**
 * The text of `package.json` naming parallax-site `version`: where the text has the dependency's
 * entry once, only its value changes; otherwise the manifest is written again with the text's
 * indentation and line ends.
 */
function renamed(text: string, manifest: Manifest, version: string): string {
  const entries = text.match(ENTRY) ?? [];
  if (entries.length === 1 && manifest.dependencies?.['parallax-site'] !== undefined) {
    const edited = text.replace(ENTRY, (_, key: string) => `${key}${JSON.stringify(version)}`);
    try {
      if (JSON.parse(edited).dependencies['parallax-site'] === version) return edited;
    } catch {}
  }
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const dependencies = { ...manifest.dependencies, 'parallax-site': version };
  const json = JSON.stringify({ ...manifest, dependencies }, null, indent);
  return `${json.replaceAll('\n', eol)}${eol}`;
}

const say = (line: string) => console.log(`parallax update: ${line}`);
const stop = (line: string, code = 1) => {
  console.error(`parallax update: ${line}`);
  return code;
};

/**
 * `parallax update [--to <version or npm tag>] [--dry-run]` (docs/design/site.md §10.1): the site
 * on a new version of Parallax. `package.json` names the version `--to` gives, by default npm's
 * `latest`, and `npm install` installs it; the installed tool then compares the site's files with
 * its template, replaces the ones the author never changed, adds the template's new files and
 * keeps the rest, naming each kept file the template changed. With `--dry-run` it writes nothing
 * but `.parallax/template`. At levels 1 and 2 `parallax upgrade` then puts the version in service.
 */
export const run: Command['run'] = async ({ site, args }) => {
  let options: { to?: string; 'dry-run'?: boolean };
  try {
    const flags = { to: { type: 'string' }, 'dry-run': { type: 'boolean' } } as const;
    options = parseArgs({ args, options: flags, strict: true }).values;
  } catch (error) {
    return stop(`${shown((error as Error).message)}\n${USAGE}`, 2);
  }
  const { to, 'dry-run': dryRun = false } = options;
  if (to !== undefined && !VERSION.test(to) && !TAG.test(to)) {
    return stop(`--to takes a version, such as 0.1.1, or an npm tag, such as next\n${USAGE}`, 2);
  }
  const file = join(site.root, 'package.json');
  let text: string;
  let manifest: Manifest;
  try {
    text = readFileSync(file, 'utf8');
    manifest = JSON.parse(text);
  } catch (error) {
    const why = (error as NodeJS.ErrnoException).code ?? 'not JSON';
    return stop(`package.json cannot be read (${why}).`);
  }
  const named = manifest.dependencies?.['parallax-site'];
  const was = named === undefined ? 'no version' : shown(named);
  // A path, a link or a URL is no version of npm's, so only `--to` replaces it.
  if (to === undefined && named !== undefined && /[:/\\]/.test(named)) {
    return stop(`package.json names parallax-site ${was}, not a version from npm. ${NAME}`);
  }
  const running = versionAt(packageRoot) ?? '';
  const installed = versionAt(join(site.root, 'node_modules/parallax-site'));
  let target = to ?? 'latest';
  if (!VERSION.test(target)) {
    const found = await updating.view(target, site.root);
    if ('why' in found) {
      const why = `npm view gave no single version of parallax-site@${target} (${shown(found.why)})`;
      return stop(`${why}. ${NAME}`);
    }
    const current = installed ?? running;
    if (to === undefined && after(current, found.version)) {
      say(`parallax-site ${current} is newer than ${found.version}, npm's latest, and stays.`);
      target = current;
    } else target = found.version;
  }
  const write = named !== target;
  const install = write || installed !== target;
  if (dryRun && install) {
    const steps = [write && `make package.json name parallax-site ${target} (now ${was})`];
    say(`would ${[...steps, 'run npm install'].filter(Boolean).join(' and ')}.`);
    say(`The files are compared with the template once ${target} is installed.`);
    return 0;
  }
  if (write) {
    writeFileSync(file, renamed(text, manifest, target));
    say(`package.json names parallax-site ${target} (was ${was}).`);
  }
  if (install) {
    say('npm install');
    // Ctrl-C stops npm, and this process stays to give package.json its text back.
    const hold = () => {};
    process.on('SIGINT', hold);
    const code = await updating
      .npm(['install', '--no-audit', '--no-fund'], site.root)
      .finally(() => process.off('SIGINT', hold));
    if (code !== 0) {
      if (write) writeFileSync(file, text);
      const back = write ? `; package.json names ${was} again` : '';
      return stop(
        `npm install ended with ${code}${back}. The site's other files are as they were.`,
      );
    }
  }
  if (running !== target) {
    // This process is another version: the one installed compares the files with its template.
    if (process.env[HANDOFF])
      return stop(`the installed parallax-site is ${running}, not ${target}.`);
    if (!existsSync(join(site.root, 'node_modules/parallax-site/src/commands/update.ts'))) {
      const not = "so the site's other files were not compared with its template";
      return stop(`parallax-site ${target} is installed and has no update command, ${not}.`);
    }
    const again = ['update', '--to', target, ...(dryRun ? ['--dry-run'] : [])];
    return updating.installed(site.root, again);
  }
  let done: Refreshed;
  try {
    done = await refresh(site.root, site.config.mode, dryRun);
  } catch (error) {
    if (!(error instanceof Unapplied)) throw error;
    const where = `the update stopped at ${error.path} (${shown(error.why)})`;
    return stop(`${where} and put back every file it had written. Run it again to finish.`);
  }
  const verb = (word: 'add' | 'update' | 'remove') =>
    dryRun ? `would ${word}` : { add: 'added', update: 'updated', remove: 'removed' }[word];
  if (done.record !== 'read') {
    const all = listed(Object.keys(published.versions));
    const why = done.record === 'none' ? 'is not there' : 'cannot be read';
    say(`${RECORD} ${why}, so the files are compared with the templates of ${all}.`);
  }
  for (const { path, added } of done.write) say(`${verb(added ? 'add' : 'update')} ${path}`);
  for (const path of done.remove) say(`${verb('remove')} ${path}`);
  if (done.rewritten) say(`${verb(done.record === 'none' ? 'add' : 'update')} ${RECORD}`);
  for (const line of done.kept) say(line);
  const count = done.write.length + done.remove.length + (done.rewritten ? 1 : 0);
  const changed = many(count, 'file');
  const kept = done.kept.length > 0 ? `, ${done.kept.length} kept as you have them` : '';
  if (dryRun) {
    say(
      `parallax-site ${target}: ${changed} would change${kept}. Nothing was written but ${TEMPLATE}.`,
    );
    return 0;
  }
  const next =
    site.config.level === 0
      ? 'npx parallax build'
      : 'npx parallax upgrade where the site is served';
  say(`parallax-site ${target}: ${changed} changed${kept}. Its template is in ${TEMPLATE}.`);
  say(`Next: npx parallax check, then ${next}.`);
  return 0;
};
