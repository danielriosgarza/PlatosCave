import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterAll, describe, expect, onTestFailed, test } from 'vitest';
import { composeArgs, processes } from '../../../../packages/cli/src/host/compose';
import { readEnv, readText } from '../../../../packages/cli/src/host/secrets';
import { main } from '../../../../packages/cli/src/main';

/**
 * A52 on Docker (docs/design/site.md §9 to §11): the instructor template's installation, started
 * by `parallax start` with the server image that the `image` workflow has built and loaded under
 * the reference `parallax env` writes, and at level 2 its database alone. Skipped without that
 * image; mandatory in CI.
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
// The site folders, whose names are the Compose projects'; made only where the suite runs.
const temp = imagePresent ? mkdtempSync(join(tmpdir(), 'parallax-a52-')) : tmpdir();
const root = join(temp, 'a52-onehost');
const two = join(temp, 'a52-level2');
const docker = (args: string[], input?: string, cwd = root) =>
  execFileSync('docker', args, { cwd, encoding: 'utf8', input, stdio: 'pipe' });
const project = (args: string[], input?: string) => docker([...composeArgs(1), ...args], input);
const psql = (sql: string) =>
  project(['exec', '-T', 'postgres', 'psql', '-U', 'parallax', '-d', 'parallax', '-tAc', sql]);
/** The state of the one container of `service`, running or not. */
const state = (service: string) =>
  JSON.parse(docker(['inspect', '-f', '{{json .State}}', project(['ps', '-aq', service]).trim()]));
/** The level 2 site's compose calls, and a `docker` call that may fail, with `env` added. */
const level2 = (args: string[], input?: string) => docker([...composeArgs(2), ...args], input, two);
const attempt = (args: string[], env: Record<string, string | undefined> = {}) =>
  spawnSync('docker', args, { cwd: two, encoding: 'utf8', env: { ...process.env, ...env } });

/** A copy of the instructor template in `folder`, with one edit of its configuration. */
function template(folder: string, from: RegExp | string, to: string) {
  const templates = join(repo, 'packages/create-parallax-site/templates');
  for (const name of ['shared', 'instructor'])
    cpSync(join(templates, name), folder, { recursive: true });
  const site = { private: true, type: 'module', dependencies: { 'parallax-site': cli.version } };
  writeFileSync(join(folder, 'package.json'), JSON.stringify(site));
  const config = join(folder, 'parallax.config.ts');
  writeFileSync(config, readFileSync(config, 'utf8').replace(from, to));
}

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
  await processes.run([...composeArgs(2), 'down', '--volumes'], two);
  rmSync(temp, { recursive: true, force: true });
});

test.runIf(process.env.CI)('CI provides Docker and the server image', () => {
  expect(imagePresent).toBe(true);
});

describe.skipIf(!imagePresent)('A52 one-host installation (site.md §9 to §11)', () => {
  test('A52 the one-host installation answers on both host names', {
    timeout: 900_000,
  }, async () => {
    onTestFailed(() => console.error(output));
    const origins =
      "origins: { app: 'https://app.localhost', content: 'https://content.localhost' },";
    template(root, /origins: .*/, origins);
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

  test('A52 a level 2 database admits only the rules of pg_hba.conf', {
    timeout: 300_000,
  }, async () => {
    output = '';
    onTestFailed(() => console.error(output));
    // compose.level2.yml publishes the port on this host's own address. The level 1 stack has
    // the template's backend subnet, so this site changes it, as compose.yml tells an operator.
    const own = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal);
    const subnet = '172.30.20.0/24';
    const python = { id: 'python-3.12', language: 'python', harnessVersion: '4', packages: [] };
    const image = { image: 'registry.example.org/runner', digest: `sha256:${'1'.repeat(64)}` };
    const runtimes = [{ ...python, ...image }];
    const runner = { host: '192.0.2.7', databaseHost: own?.address, runtimes };
    template(two, 'level: 1,', `level: 2, runner: ${JSON.stringify(runner)},`);
    const compose = join(two, 'compose.yml');
    writeFileSync(compose, readFileSync(compose, 'utf8').replace('172.30.10.0/24', subnet));
    expect(await main(['env'], { cwd: two })).toBe(0);

    // postgres alone on a fresh volume: the image's first start initialises over the socket.
    expect(await processes.run([...composeArgs(2), 'up', '-d', '--wait', 'postgres'], two)).toBe(0);
    expect(level2(['logs', 'postgres'])).toContain('PostgreSQL init process complete');
    // The runner role as scripts/runner-role.sql makes it (migration 0010 repeats it, and no
    // migrate runs here), then the ALTER ROLE on psql's standard input as `start` sends it.
    const psqlIn = 'exec -T postgres psql -U parallax -d parallax -v ON_ERROR_STOP=1'.split(' ');
    const role = readFileSync(join(repo, 'scripts/runner-role.sql'), 'utf8');
    level2([...psqlIn, '-v', 'app_role=parallax'], role);
    const env = readEnv(readText(join(two, '.env')));
    const password = env.get('RUNNER_DB_PASSWORD')?.value;
    const login = `LOGIN PASSWORD '${password}' CONNECTION LIMIT 8`;
    level2(psqlIn, `ALTER ROLE parallax_runner ${login};\nSELECT pg_reload_conf();\n`);
    const query = (sql: string) => level2([...psqlIn, '-tAc', sql]).match(/.+/g);
    const roles = 'select rolname, rolcanlogin, rolconnlimit from pg_roles';
    expect(query(`${roles} where rolname = 'parallax_runner'`)).toEqual(['parallax_runner|t|8']);

    // Exactly the generated file's three rules, each read without an error.
    const columns = 'type, database, user_name, address, netmask, auth_method, error';
    expect(query(`select ${columns} from pg_hba_file_rules order by rule_number`)).toEqual([
      'local|{all}|{all}|||trust|',
      'host|{parallax}|{parallax}|172.30.20.0|255.255.255.0|scram-sha-256|',
      'host|{parallax}|{parallax_runner}|192.0.2.7|255.255.255.255|scram-sha-256|',
    ]);
    // No rule names a loopback address, so TCP inside the container is refused.
    const tcp = 'exec -T postgres psql -h 127.0.0.1 -U parallax -d parallax -w -c';
    const loopback = attempt([...composeArgs(2), ...tcp.split(' '), 'select 1']);
    expect(loopback.status).not.toBe(0);
    expect(loopback.stderr).toContain('no pg_hba.conf entry for host "127.0.0.1"');

    // From a container on backend: the application role, from the subnet its rule names; not
    // parallax_runner, which may log in now, but only from the runner host.
    const run = 'run --rm --network a52-level2_backend -e PGPASSWORD postgres:16.15'.split(' ');
    const sql = `select current_user, inet_client_addr() << '${subnet}'`;
    const psqlAs = (user: string) => ['psql', '-h', 'postgres', '-U', user, '-d', 'parallax', '-w'];
    const client = (user: string, secret?: string) =>
      attempt([...run, ...psqlAs(user), '-tAc', sql], { PGPASSWORD: secret });
    const app = client('parallax', env.get('POSTGRES_PASSWORD')?.value);
    expect(app).toMatchObject({ status: 0, stdout: 'parallax|t\n' });
    const refused = /no pg_hba.conf entry for host "172\.30\.20\.\d+", user "parallax_runner"/;
    expect(client('parallax_runner', password).stderr).toMatch(refused);
  });
});
