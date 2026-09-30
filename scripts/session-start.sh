#!/usr/bin/env bash
# SessionStart hook: in remote sessions, make the workspace ready to run checks.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "$(dirname "$0")/.."
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile --silent >&2

# Local Postgres so every session can run integration tests (no Docker in cloud sessions).
# `pg-local.sh start` is a no-op when the server is already running.
if pg_out="$(bash scripts/pg-local.sh start 2>&1)"; then
  db_url="$(printf '%s\n' "$pg_out" | sed -n 's/^DATABASE_URL=//p' | tail -1)"
  if [ -n "$db_url" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export DATABASE_URL='$db_url'" >> "$CLAUDE_ENV_FILE"
  fi
else
  echo "session-start: local Postgres did not start; integration tests will need DATABASE_URL" >&2
  printf '%s\n' "$pg_out" >&2
fi
