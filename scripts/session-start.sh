#!/usr/bin/env bash
# SessionStart hook: in remote sessions, make the workspace ready to run checks.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "$(dirname "$0")/.."
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile --silent >&2
