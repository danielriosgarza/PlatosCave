import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterAll, describe, expect, onTestFailed, test } from 'vitest';
import { composeArgs, processes } from '../../../../packages/cli/src/host/compose';
import { main } from '../../../../packages/cli/src/main';

/**
 * A52 on Docker (docs/design/site.md §9, §10): the instructor template's installation, started
 * by `parallax start` with the server image that the `image` workflow has built and loaded under
 * the reference `parallax env` writes. Skipped without that image; mandatory in CI.
 */
const repo = resolve(import.meta.dirname, '../../../..');
const cli = JSON.parse(readFileSync(join(repo, 'packages/cli/package.json'), 'utf8'));
const IMAGE = `${cli.parallax.registry}/parallax-server:${cli.version}`;
const imagePresent = (() => {
  try {
    return execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'pipe' }).length > 0;
  } catch {
    return false;
  }
})();
// The site folder, whose name is the Compose project's; made only where the suite runs.
const temp = imagePresent ? mkdtempSync(join(tmpdir(), 'parallax-a52-')) : tmpdir();
const root = join(temp, 'a52-onehost');
const docker = (args: string[], input?: string) =>
  execFileSync('docker', args, { cwd: root, encoding: 'utf8', input, stdio: 'pipe' });
const project = (args: string[], input?: string) => docker([...composeArgs(1), ...args], input);
const psql = (sql: string) =>
  project(['exec', '-T', 'postgres', 'psql', '-U', 'parallax', '-d', 'parallax', '-tAc', sql]);
/** The state of the one container of `service`, running or not. */
const state = (service: string) =>
  JSON.parse(docker(['inspect', '-f', '{{json .State}}', project(['ps', '-aq', service]).trim()]));

/** GET `path` from Caddy on 127.0.0.1:443 as `host`, and the names its certificate holds. */
const get = (host: string, path: string) =>
  new Promise<{ status: number; body: string; names: string }>((done, fail) => {
    const options = { host: '127.0.0.1', port: 443, path, servername: host, headers: { host } };
    request({ ...options, rejectUnauthorized: false }, (res) => {
      const names = (res.socket as TLSSocket).getPeerCertificate().subjectaltname ?? '';
      let body = '';
      res.setEncoding('utf8').on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => done({ status: res.statusCode ?? 0, body, names }));
    })
      .on('error', fail)
      .end();
  });

/** Every docker call's output, shown when the test fails; `pull` asks for nothing (local image). */
let output = '';
processes.run = (args, cwd, input) =>
  new Promise((done) => {
    if (args.at(-1) === 'pull') return done(0);
    const child = spawn('docker', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => (output += d));
    if (input) input.pipe(child.stdin);
    else child.stdin.end();
    child.on('error', () => done(127)).on('close', (code) => done(code ?? 1));
  });

/** The first answer, once Caddy has its certificates. */
async function reach(host: string, path: string) {
  for (let tries = 1; ; tries++) {
    const answer = await get(host, path).catch((error: Error) => error);
    if (!(answer instanceof Error) || tries === 30) return answer;
    await new Promise((wait) => setTimeout(wait, 1000));
  }
}

afterAll(async () => {
  if (!imagePresent) return;
  await processes.run([...composeArgs(1), 'down', '--volumes'], root);
  rmSync(temp, { recursive: true, force: true });
});

test.runIf(process.env.CI)('CI provides Docker and the server image', () => {
  expect(imagePresent).toBe(true);
});

describe.skipIf(!imagePresent)('A52 one-host installation (site.md §9, §10)', () => {
  test('A52 the one-host installation answers on both host names', {
    timeout: 900_000,
  }, async () => {
    onTestFailed(() => console.error(output));
    const templates = join(repo, 'packages/create-parallax-site/templates');
    for (const from of ['shared', 'instructor'])
      cpSync(join(templates, from), root, { recursive: true });
    const site = { private: true, type: 'module', dependencies: { 'parallax-site': cli.version } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(site));
    const config = join(root, 'parallax.config.ts');
    const origins =
      "origins: { app: 'https://app.localhost', content: 'https://content.localhost' },";
    writeFileSync(config, readFileSync(config, 'utf8').replace(/origins: .*/, origins));
    writeFileSync(join(root, '.env'), "SMTP_URL='smtp://relay.example.org:587'\n");
    // As a restrictive umask leaves it; Caddy, with no capability to read it, needs it readable.
    chmodSync(join(root, 'Caddyfile'), 0o600);
    expect(await main(['start'], { cwd: root })).toBe(0);

    // Caddy's local certificates for both names; one server tells the two origins apart.
    const health = await reach('app.localhost', '/api/health');
    expect(health).toMatchObject({ status: 200, names: expect.stringContaining('app.localhost') });
    expect(await get('content.localhost', '/api/health')).toMatchObject({ status: 404 });
    const home = await get('app.localhost', '/');
    expect(home.body).toBe(readFileSync(join(root, 'dist/index.html'), 'utf8'));
    const running = project(['ps', '--format', '{{.Service}} {{.Command}}', '--no-trunc']);
    const lines = running.trim().split('\n').sort();
    expect(lines.map((line) => line.split(' ')[0])).toEqual([
      'caddy',
      'postgres',
      'server',
      'worker',
    ]);
    expect(lines.filter((line) => /main\.ts relay\W*$/.test(line))).toHaveLength(1);

    // No instructor has signed in: apply reaches the database, names instructor.yaml, writes nothing.
    output = '';
    expect(await main(['apply'], { cwd: root })).toBe(1);
    expect(output).toContain('instructor.yaml: no active account has this address');
    expect(psql('select count(*) from classes').trim()).toBe('0');

    // An upgrade backs up the stack's database and storage volume, then migrate runs again first.
    const bytes = 'an object of the storage volume\n';
    const key = `a52/objects/${createHash('sha256').update(bytes).digest('hex')}`;
    const write = `mkdir -p /var/lib/parallax/storage/a52/objects && cat > /var/lib/parallax/storage/${key}`;
    project(['exec', '-T', 'server', 'sh', '-c', write], bytes);
    const before = state('migrate');
    expect(await main(['upgrade'], { cwd: root })).toBe(0);
    const [backup = ''] = readdirSync(join(root, 'backups'));
    const files = readdirSync(join(root, 'backups', backup)).sort();
    expect(files).toEqual(['backup.info', 'database.dump', 'storage', 'storage.manifest']);
    const manifest = readFileSync(join(root, 'backups', backup, 'storage.manifest'), 'utf8');
    expect(manifest).toBe(`${key.split('/').at(-1)}\t${bytes.length}\t${key}\n`);
    const [migrate, server] = [state('migrate'), state('server')];
    expect(migrate.ExitCode).toBe(0);
    expect(Date.parse(migrate.StartedAt)).toBeGreaterThan(Date.parse(before.FinishedAt));
    expect(Date.parse(migrate.FinishedAt)).toBeLessThanOrEqual(Date.parse(server.StartedAt));
    expect((await get('app.localhost', '/api/health')).status).toBe(200);

    // A database a later version migrated: migrate exits non-zero and the server is not restarted.
    const journal = readFileSync(join(repo, 'apps/server/drizzle/meta/_journal.json'), 'utf8');
    const later = Math.max(...JSON.parse(journal).entries.map((e: { when: number }) => e.when)) + 1;
    psql(`insert into drizzle.__drizzle_migrations (hash, created_at) values ('a52', ${later})`);
    expect(await processes.run([...composeArgs(1), 'up', '-d', '--wait'], root)).not.toBe(0);
    expect(state('migrate').ExitCode).not.toBe(0);
    expect(state('server').StartedAt).toBe(server.StartedAt);
    expect(project(['logs', 'migrate'])).toContain(new Date(later).toISOString());
  });
});
