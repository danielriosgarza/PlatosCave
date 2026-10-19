import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceRoot } from '../paths';
import type { Site } from '../site/load';
import { compose } from './compose';

const FILE = '.parallax/compose.backup.yml';
/** A reference that Compose fills from the two environment files. */
const ref = (body: string) => `\${${body}}`;

/**
 * The one service of `.parallax/compose.backup.yml` (docs/design/site.md §10): the package's
 * `backup.sh` in a one-shot container of the bundled database's image, which has pg_dump 16,
 * bash and the GNU tools the script needs. Like `server` it reaches the bundled database on
 * `backend` and an existing one on `egress`, with the same `DATABASE_URL` and `PGPASSWORD`; it
 * reads the `storage` volume and writes only into `backups/`. On a POSIX host it runs as the
 * operator, whose backup it is. JSON, which Compose reads as YAML.
 */
export function backupService(uid = process.getuid?.(), gid = process.getgid?.()) {
  const script = join(sourceRoot('deploy'), 'backup.sh');
  const backup = {
    image: 'postgres:16.15',
    entrypoint: ['bash', '/parallax/backup.sh'],
    ...(uid === undefined ? {} : { user: `${uid}:${gid}` }),
    environment: {
      DATABASE_URL: ref('DATABASE_URL:-postgres://parallax@postgres:5432/parallax'),
      PGPASSWORD: ref('POSTGRES_PASSWORD:?run parallax env'),
      STORAGE_DRIVER: 'fs',
      STORAGE_DIR: '/storage',
      PG_BIN: '/usr/lib/postgresql/16/bin',
    },
    volumes: [
      { type: 'bind', source: script, target: '/parallax/backup.sh', read_only: true },
      { type: 'volume', source: 'storage', target: '/storage', read_only: true },
      { type: 'bind', source: './backups', target: '/backups' },
    ],
    networks: ['backend', 'egress'],
  };
  return { services: { backup } };
}

/** The backup of §10 into `backups/<UTC time>`, which must not exist; its exit code and folder. */
export async function backup(site: Site, at = new Date()) {
  const dir = `backups/${at.toISOString().slice(0, 19).replaceAll(':', '-')}Z`;
  // `backups/` is made here, so that Docker does not make it for root.
  for (const made of ['backups', '.parallax'])
    mkdirSync(join(site.root, made), { recursive: true });
  writeFileSync(join(site.root, FILE), `${JSON.stringify(backupService(), null, 2)}\n`);
  const code = await compose(site, ['-f', FILE, 'run', '--rm', '--no-deps', 'backup', `/${dir}`]);
  return { code, dir };
}
