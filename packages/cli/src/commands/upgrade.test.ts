import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { place } from '../build/web';
import { composeArgs, processes } from '../host/compose';
import { main } from '../main';
import { building } from './upgrade';

const pkg = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'parallax-upgrade-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const gitignore = join(pkg, '../create-parallax-site/templates/shared/_gitignore');
const ignored = readFileSync(gitignore, 'utf8').split(/\r?\n/).filter(Boolean);
/** Each file of the site outside the paths its `.gitignore` lists, with its content. */
const tracked = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .filter((file) => !ignored.some((path) => file === path || file.startsWith(path)))
    .map((file) => `${file}: ${readFileSync(join(root, file), 'base64')}`);

const SMTP = "SMTP_URL='smtp://relay.example.org:587'\n";
/**
 * `parallax upgrade` in a copy of the instructor fixture, with the compile, the placing and the
 * process runner injected: each step goes into one log, and the compose call `failing` ends 1.
 * The Caddyfile and the compiled site are private, as an umask of 077 leaves them.
 */
async function upgrade(failing?: 'backup' | 'up', dotenv = SMTP) {
  const root = mkdtempSync(join(temp, 'site-'));
  cpSync(join(pkg, 'fixtures/config/instructor'), root, { recursive: true });
  writeFileSync(join(root, '.env'), dotenv);
  writeFileSync(join(root, 'compose.yml'), 'services: {}\n');
  writeFileSync(join(root, 'Caddyfile'), '', { mode: 0o600 });
  mkdirSync(join(root, 'dist'), { mode: 0o700 });
  writeFileSync(join(root, 'dist/index.html'), 'the old site');
  const before = tracked(root);
  const log: string[] = [];
  building.compile = async (site) => {
    log.push('compile');
    const out = join(site.root, '.parallax/dist');
    mkdirSync(join(out, 'assets'), { recursive: true, mode: 0o700 });
    writeFileSync(join(out, 'index.html'), 'the new site', { mode: 0o600 });
    writeFileSync(join(out, 'assets/a.js'), '', { mode: 0o600 });
  };
  building.place = (site) => {
    log.push('place');
    place(site);
  };
  processes.run = async (args) => {
    const call = args.slice(composeArgs(1).length).join(' ');
    const run = '-f .parallax/compose.backup.yml run --rm --no-deps backup /backups/';
    const step = call.startsWith(run) ? 'backup' : call;
    log.push(step);
    return failing && step.startsWith(failing) ? 1 : 0;
  };
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line) => lines.push(line));
  const code = await main(['upgrade'], { cwd: root }).finally(() => vi.restoreAllMocks());
  const site = readFileSync(join(root, 'dist/index.html'), 'utf8');
  return { root, code, log, site, said: lines.join('\n'), before, after: tracked(root) };
}

test('A52 an upgrade backs up before it migrates, and a failed backup starts no migration', async () => {
  // The pull takes the backup's image too, so nothing is pulled once the services have stopped.
  const pull = '-f .parallax/compose.backup.yml pull';
  const steps = ['compile', pull, 'stop server worker', 'backup', 'place', 'up -d --wait'];
  const done = await upgrade();
  expect(done).toMatchObject({ code: 0, log: steps, site: 'the new site' });
  expect(existsSync(join(done.root, '.parallax/site.env'))).toBe(true);
  // Nothing outside the git-ignored paths (.env, .parallax/, dist/, backups/) was written.
  expect(done.after).toEqual(done.before);
  const failed = await upgrade('backup');
  expect(failed).toMatchObject({ code: 1, log: steps.slice(0, 4), site: 'the old site' });
  expect(failed.said).toMatch(/backup .*no migration ran.*start server worker/s);
  const stopped = await upgrade('up');
  expect(stopped).toMatchObject({ code: 1, log: steps, site: 'the new site' });
  expect(stopped.said).toMatch(/may be stopped.*backups\/\d{4}-/s);
  // start's check of what the operator typed into .env comes before anything else.
  const typed = await upgrade(undefined, "SMTP_URL=''\n");
  expect(typed).toMatchObject({ code: 1, log: [], site: 'the old site' });
  expect(typed.said).toContain('signIn.email is set and SMTP_URL is empty');
  if (process.platform === 'win32') return; // Windows keeps no mode bits.
  // Caddy and the server have no capability to read what is not readable to all.
  const files = ['Caddyfile', 'dist', 'dist/assets', 'dist/index.html', 'dist/assets/a.js'];
  const modes = files.map((file) => statSync(join(done.root, file)).mode & 0o777);
  expect(modes).toEqual([0o644, 0o755, 0o755, 0o644, 0o644]);
});
