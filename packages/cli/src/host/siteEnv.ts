import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { parse } from 'yaml';
import { packageRoot } from '../paths';
import { CONFIG, type Site, SiteProblems } from '../site/load';
import { completeEnv, readEnv, readText } from './secrets';

/** The server's rule for a host name (`HostName`, apps/server/src/config.ts), on a URL's host. */
const HOST = /^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/;
/** `KEY='value'`, which Compose reads back unchanged: in single quotes only `\'` is an escape. */
const quoted = ([key, value]: string[]) => `${key}='${value?.replaceAll("'", "\\'")}'\n`;
/** JSON whose quotes are JSON escapes, so that no backslash stands before a quote. */
const json = (value: unknown) => JSON.stringify(value).replaceAll("'", '\\u0027');
/** Writes in place, so that a file that a container has mounted is the one that changes. */
function write(root: string, file: string, text: string, mode: number): void {
  writeFileSync(join(root, '.parallax', file), text, { mode });
  chmodSync(join(root, '.parallax', file), mode);
}

/**
 * The `backend` subnet, which only the site's `compose.yml` states (docs/design/site.md §9). Its
 * `pg_hba.conf` rule admits the cluster's superuser on a published port (§11), so it is taken
 * only inside a private range (RFC 1918), where Docker places its networks.
 */
function backendSubnet(root: string): string | undefined {
  try {
    const { subnet } = parse(readText(join(root, 'compose.yml'))).networks.backend.ipam.config[0];
    const [address = '', bits = ''] = String(subnet).split('/');
    const [a, b = 0] = address.split('.').map(Number);
    const n = /^\d{1,2}$/.test(bits) && Number(bits) <= 32 ? Number(bits) : -1;
    const least = a === 10 ? 8 : a === 172 && b >> 4 === 1 ? 12 : a === 192 && b === 168 ? 16 : 33;
    return isIPv4(address) && n >= least ? subnet : undefined;
  } catch {}
}

/** The values that the server, Compose or PostgreSQL would refuse or misread. */
function problems({ config }: Site, subnet: string | undefined): string[] {
  const { origins, signIn, runner } = config;
  const lines: string[] = [];
  const fields = ['app', 'content', ...origins.shiny.map((_, i) => `shiny[${i}]`)];
  for (const [i, origin] of [origins.app, origins.content, ...origins.shiny].entries()) {
    const host = new URL(origin).hostname;
    if (!HOST.test(host)) lines.push(`origins.${fields[i]}: the host ${host} is not a host name`);
  }
  if (/\\('|$)/.test(signIn?.email?.from ?? ''))
    lines.push(`signIn.email.from: \\ before ' or at the end`);
  if (config.level === 2 && runner) {
    for (const key of ['host', 'databaseHost'] as const) {
      const first = Number(runner[key].split('.')[0]);
      const one = first !== 0 && first !== 127 && first < 224;
      if (!one) lines.push(`runner.${key}: ${runner[key]} is 0.0.0.0, loopback or broadcast`);
    }
    for (const [i, { id, language }] of runner.runtimes.entries()) {
      if (!id.startsWith(`${language}-`)) lines.push(`runner.runtimes[${i}].language: not ${id}'s`);
    }
  }
  const none = config.level === 2 && !subnet;
  const at = lines.map((line) => `${CONFIG}: ${line}`);
  const range = 'not an IPv4 subnet inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16';
  return none ? [...at, `compose.yml: networks.backend.ipam.config[0].subnet: ${range}`] : at;
}

/**
 * `parallax env` (docs/design/site.md §9, §11): completes `.env`, then writes `.parallax/site.env`,
 * which holds no secret, from the configuration and the installed version, and at level 2
 * `pg_hba.conf` and `runner/runner.env`. A value that cannot be used stops it before it writes
 * anything. Returns the names added to `.env` and the pull commands for the runner host.
 */
export function writeSiteEnv(site: Site) {
  const { root, config } = site;
  const { level, origins, signIn, runner } = config;
  const subnet = level === 2 ? backendSubnet(root) : undefined;
  const refused = problems(site, subnet);
  if (refused.length > 0) throw new SiteProblems(refused);
  const { env, added } = completeEnv(root, level);
  const bundled = !env.get('DATABASE_URL')?.value;
  const { version, parallax } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const image = (name: string) => `${parallax.registry}/parallax-${name}:${version}`;
  const emails = new Set(site.instructors.map(({ meta }) => meta.email.toLowerCase()));
  const values = [
    ['APP_ORIGIN', origins.app],
    ['APP_HOST', new URL(origins.app).hostname],
    ['CONTENT_ORIGIN', origins.content],
    ['CONTENT_HOST', new URL(origins.content).hostname],
    ['MAIL_TRANSPORT', signIn?.email ? 'smtp' : 'none'],
    ...(signIn?.email ? [['MAIL_FROM', signIn.email.from]] : []),
    // Only the listed providers, without their client secrets, which stay in `.env`.
    ['OIDC_PROVIDERS', json(signIn?.providers ?? [])],
    ['INSTRUCTOR_EMAILS', [...emails].join(',')],
    ['SHINY_ORIGINS', origins.shiny.join(',')],
    ['PARALLAX_SERVER_IMAGE', image('server')],
    ['PARALLAX_RUNNER_IMAGE', image('runner')],
    ['COMPOSE_PROFILES', bundled ? 'bundled' : ''],
    ...(level === 2 && runner ? [['RUNNER_RUNTIMES', json(runner.runtimes)]] : []),
    // Where `compose.level2.yml` publishes PostgreSQL's port.
    ...(level === 2 && runner ? [['RUNNER_DATABASE_HOST', runner.databaseHost]] : []),
  ];
  mkdirSync(join(root, level === 2 ? '.parallax/runner' : '.parallax'), { recursive: true });
  const header = `# Written by parallax env from ${CONFIG}; a change here is overwritten.\n`;
  write(root, 'site.env', [header, ...values.map(quoted)].join(''), 0o600);
  if (level !== 2 || !runner) return { added, pulls: [] };
  const from = (role: string, address: string) =>
    `host parallax ${role} ${address} scram-sha-256\n`;
  const hba = [from('parallax', `${subnet}`), from('parallax_runner', `${runner.host}/32`)];
  write(root, 'pg_hba.conf', ['local all all trust\n', ...hba].join(''), 0o644);
  const password = encodeURIComponent(env.get('RUNNER_DB_PASSWORD')?.value ?? '');
  const ours = `postgres://parallax_runner:${password}@${runner.databaseHost}:5432/parallax`;
  // With an existing PostgreSQL the operator types the URL into runner.env, where it is kept;
  // the one `env` wrote for the bundled database is not.
  const typed = readEnv(readText(join(root, '.parallax/runner/runner.env'))).get(
    'RUNNER_DATABASE_URL',
  )?.value;
  const url = bundled ? ours : typed === ours ? undefined : typed;
  const refs = runner.runtimes.map(({ image, digest }) => `${image}@${digest}`);
  const images = json(Object.fromEntries(runner.runtimes.map(({ id }, i) => [id, [refs[i]]])));
  // `compose.runner.yml` names its image from this file, the only one copied to the runner host.
  const link = url ? [['RUNNER_DATABASE_URL', url]] : [];
  const lines = [['PARALLAX_RUNNER_IMAGE', image('runner')], ...link, ['RUNNER_IMAGES', images]];
  write(root, 'runner/runner.env', lines.map(quoted).join(''), 0o600);
  return { added, pulls: [image('runner'), ...refs].map((ref) => `docker pull ${ref}`) };
}
