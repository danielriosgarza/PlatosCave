-- The runner's database role (docs/design/runner.md §10.3): privileges in schema pgboss_exec
-- only, so a compromised runner can neither read application tables nor read or enqueue the
-- actor-bearing scoped jobs in schema pgboss.
--
--   psql -v app_role=<role that runs pg-boss> -f scripts/runner-role.sql
--
-- Production operators run it under a role that may create roles, before `pnpm db:migrate`;
-- P3-16's migration repeats these statements with :app_role taken from DATABASE_URL. The
-- default-privilege statements must run as :app_role or a member of it: pg-boss, running as
-- that role, creates the queue tables later. Nothing here touches schema public or pgboss: the
-- role gets no grant there, and USAGE on public through PUBLIC reaches no application table
-- because those carry no PUBLIC grants (asserted by apps/runner/test/a13-runner-role.itest.ts).
-- Give the role LOGIN, a password and a CONNECTION LIMIT out of band.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parallax_runner') THEN
    CREATE ROLE parallax_runner NOLOGIN;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS pgboss_exec;
GRANT USAGE ON SCHEMA pgboss_exec TO parallax_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss_exec TO parallax_runner;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA pgboss_exec TO parallax_runner;
ALTER DEFAULT PRIVILEGES FOR ROLE :app_role IN SCHEMA pgboss_exec
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO parallax_runner;
ALTER DEFAULT PRIVILEGES FOR ROLE :app_role IN SCHEMA pgboss_exec GRANT USAGE ON SEQUENCES TO parallax_runner;
ALTER ROLE parallax_runner SET statement_timeout = '30s';
