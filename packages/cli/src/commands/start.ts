import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compose, noServer } from '../host/compose';
import { type EnvValue, readEnv, readText } from '../host/secrets';
import type { Command } from '../main';
import type { Site } from '../site/load';
import { run as build } from './build';
import { run as env } from './env';

/** The runner role's connections: RUNNER_SLOTS (4 by default) and 4 (docs/operations.md). */
const RUNNER_CONNECTIONS = 8;
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {}
};

/**
 * Why what the operator typed into `.env` would stop the server or reach it changed (§9). The
 * lines name keys and provider ids, never a value.
 */
function typedProblems({ config }: Site, dotenv: Map<string, EnvValue>): string[] {
  const { email, providers = [] } = config.signIn ?? {};
  const lines = ['SMTP_URL', 'OIDC_CLIENT_SECRETS', 'DATABASE_URL']
    .filter((key) => dotenv.get(key)?.changed)
    .map((key) => `${key} holds $ or \\ that Compose would change: write it ${key}='…'`);
  const smtp = "SMTP_URL='smtp://user:password@host:587'";
  if (email && !dotenv.get('SMTP_URL')?.value)
    lines.push(`signIn.email is set and SMTP_URL is empty: ${smtp}`);
  const secrets = parsed(dotenv.get('OIDC_CLIENT_SECRETS')?.value || '{}');
  const object = typeof secrets === 'object' && secrets !== null && !Array.isArray(secrets);
  const ids = object ? Object.keys(secrets) : [];
  if (!object || Object.values(secrets).some((secret) => typeof secret !== 'string' || !secret)) {
    return [
      ...lines,
      `OIDC_CLIENT_SECRETS is not a JSON object of non-empty secrets: '{"<id>":"…"}'`,
    ];
  }
  const listed = providers.map(({ id }) => id);
  for (const id of listed.filter((id) => !ids.includes(id))) {
    lines.push(`OIDC_CLIENT_SECRETS has no secret for the provider ${id}, which signIn lists`);
  }
  for (const id of ids.filter((id) => !listed.includes(id))) {
    lines.push(
      `OIDC_CLIENT_SECRETS has a secret for ${JSON.stringify(id)}, which signIn does not list`,
    );
  }
  return lines;
}

/**
 * Caddy has only the capability to bind its ports and the server runs as `node` with none
 * (compose.yml), so neither reads a file by a capability: the Caddyfile and `dist/`, which hold
 * no secret, are made readable to all, whatever the operator's umask left.
 */
export function readable(root: string): void {
  const dist = join(root, 'dist');
  const share = (path: string, folder: boolean) => {
    if (existsSync(path)) chmodSync(path, folder ? 0o755 : 0o644);
  };
  share(join(root, 'Caddyfile'), false);
  share(dist, true);
  const tree = existsSync(dist) ? readdirSync(dist, { recursive: true, withFileTypes: true }) : [];
  for (const entry of tree) share(join(entry.parentPath, entry.name), entry.isDirectory());
}

/**
 * `parallax start` (docs/design/site.md §5, §9, §11): `env`, the check of what the operator
 * typed into `.env`, `build`, then `docker compose pull` and `up -d --wait`, in which `migrate`
 * runs before the services. Run again it changes no generated secret and stops no service. At
 * level 2 with the bundled PostgreSQL it then sets the runner role's login with one `ALTER ROLE`
 * on the standard input of `psql` in the `postgres` container, which reloads `pg_hba.conf`.
 */
export const run: Command['run'] = async ({ site }) => {
  if (site.config.level === 0) return noServer('start');
  const written = await env({ site, args: [] });
  if (written !== 0) return written;
  const dotenv = readEnv(readText(join(site.root, '.env')));
  const problems = typedProblems(site, dotenv);
  for (const line of problems) console.error(`parallax start: .env: ${line}`);
  if (problems.length > 0) return 1;
  const built = await build({ site, args: [] });
  if (built !== 0) return built;
  readable(site.root);
  const steps: [string[], string?][] = [[['pull']], [['up', '-d', '--wait']]];
  if (site.config.level === 2 && !dotenv.get('DATABASE_URL')?.value) {
    const password = dotenv.get('RUNNER_DB_PASSWORD')?.value.replaceAll("'", "''");
    const login = `LOGIN PASSWORD '${password}' CONNECTION LIMIT ${RUNNER_CONNECTIONS}`;
    const sql = `ALTER ROLE parallax_runner ${login};\nSELECT pg_reload_conf();\n`;
    const psql = ['psql', '-U', 'parallax', '-d', 'parallax', '-v', 'ON_ERROR_STOP=1'];
    steps.push([['exec', '-T', 'postgres', ...psql], sql]);
  }
  for (const [args, input] of steps) {
    const code = await compose(site, args, input);
    if (code === 0) continue;
    console.error(
      `parallax start: docker compose ${args.slice(0, 3).join(' ')} ended with ${code}.`,
    );
    return code;
  }
  console.error('parallax start: the services are up.');
  return 0;
};
