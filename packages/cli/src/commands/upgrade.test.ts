import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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

/**
 * `parallax upgrade` in a copy of the instructor fixture, with the compile, the placing and the
 * process runner injected: each step goes into one log, and the compose call `failing` ends 1.
 */
async function upgrade(failing?: 'backup' | 'up') {
  const root = mkdtempSync(join(temp, 'site-'));
  cpSync(join(pkg, 'fixtures/config/instructor'), root, { recursive: true });
  writeFileSync(join(root, '.env'), "SMTP_URL='smtp://relay.example.org:587'\n");
  writeFileSync(join(root, 'compose.yml'), 'services: {}\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/index.html'), 'the old site');
  const before = tracked(root);
  const log: string[] = [];
  building.compile = async (site) => {
    log.push('compile');
    mkdirSync(join(site.root, '.parallax/dist'), { recursive: true });
    writeFileSync(join(site.root, '.parallax/dist/index.html'), 'the new site');
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
    return step.startsWith(failing ?? '-') ? 1 : 0;
  };
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line) => lines.push(line));
  const code = await main(['upgrade'], { cwd: root }).finally(() => vi.restoreAllMocks());
  const site = readFileSync(join(root, 'dist/index.html'), 'utf8');
  return { code, log, site, said: lines.join('\n'), before, after: tracked(root) };
}

test('A52 an upgrade backs up before it migrates, and a failed backup starts no migration', async () => {
  const steps = ['compile', 'pull', 'stop server worker', 'backup', 'place', 'up -d --wait'];
  const done = await upgrade();
  expect(done).toMatchObject({ code: 0, log: steps, site: 'the new site' });
  // Nothing outside the git-ignored paths (.env, .parallax/, dist/, backups/) was written.
  expect(done.after).toEqual(done.before);
  const failed = await upgrade('backup');
  expect(failed).toMatchObject({ code: 1, log: steps.slice(0, 4), site: 'the old site' });
  expect(failed.said).toMatch(/backup .*no migration ran.*start server worker/s);
  const stopped = await upgrade('up');
  expect(stopped).toMatchObject({ code: 1, log: steps, site: 'the new site' });
  expect(stopped.said).toMatch(/server and worker are stopped.*backups\/\d{4}-/s);
});
