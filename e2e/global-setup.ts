import { execFileSync } from 'node:child_process';

export const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://parallax:parallax@127.0.0.1:54329/parallax_e2e';

/** Recreates the e2e database and migrates it, so every run starts from the same state. */
export default function globalSetup(): void {
  execFileSync('pnpm', ['--filter', '@parallax/server', 'db:reset'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl },
  });
}
