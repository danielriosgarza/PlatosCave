import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { parse } from 'yaml';
import { sourceRoot } from '../paths';
import type { Site } from '../site/load';
import { backup } from './backup';
import { processes } from './compose';

const root = mkdtempSync(join(tmpdir(), 'parallax-backup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('the backup runs backup.sh in a one-shot container on backend and egress, which reads the storage volume and writes only into backups/', async () => {
  const calls: string[] = [];
  processes.run = async (args, cwd) => {
    calls.push(`${cwd}: ${args.join(' ')}`);
    return 5;
  };
  const site = { root, config: { level: 2 } } as Site;
  const { code, dir } = await backup(site, new Date('2027-03-04T05:06:07.890Z'));
  expect([code, dir]).toEqual([5, 'backups/2027-03-04T05-06-07Z']);
  const files = '-f compose.yml -f compose.level2.yml -f .parallax/compose.backup.yml';
  const run = `run --rm --no-deps backup /${dir}`;
  expect(calls).toEqual([
    `${root}: compose --env-file .env --env-file .parallax/site.env ${files} ${run}`,
  ]);
  // The target's parent exists, so Docker does not create it for root.
  expect(existsSync(join(root, 'backups'))).toBe(true);
  const { services } = parse(readFileSync(join(root, '.parallax/compose.backup.yml'), 'utf8'));
  const { backup: service, ...others } = services;
  expect(others).toEqual({});
  expect(service).toMatchObject({
    entrypoint: ['bash', '/parallax/backup.sh'],
    networks: ['backend', 'egress'],
    environment: {
      PGPASSWORD: `\${POSTGRES_PASSWORD:?run parallax env}`,
      STORAGE_DRIVER: 'fs',
      STORAGE_DIR: '/storage',
      PG_BIN: '/usr/lib/postgresql/16/bin',
    },
    volumes: [
      { type: 'bind', source: join(sourceRoot('deploy'), 'backup.sh'), read_only: true },
      { type: 'volume', source: 'storage', target: '/storage', read_only: true },
      { type: 'bind', source: './backups', target: '/backups' },
    ],
  });
  // On a POSIX host it runs as the operator, whose backup it is.
  const uid = process.getuid?.();
  expect(service.user).toBe(uid === undefined ? undefined : `${uid}:${process.getgid?.()}`);
});
