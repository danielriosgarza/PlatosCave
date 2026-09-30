#!/usr/bin/env bash
# Local Postgres without Docker: pg-local.sh start | stop | status
set -euo pipefail

PGDIR="${PARALLAX_PG_DIR:-/tmp/parallax-pg}"
PORT=54329
USER_NAME=parallax
URL="postgres://${USER_NAME}:${USER_NAME}@127.0.0.1:${PORT}/parallax"

BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$BIN" ]; then PATH="$BIN:$PATH"; fi
command -v initdb >/dev/null || { echo "Postgres binaries not found" >&2; exit 1; }

# initdb refuses to run as root: in cloud sessions run everything as the postgres user.
run() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

running() { run pg_ctl -D "$PGDIR" status >/dev/null 2>&1; }

case "${1:-}" in
  start)
    if ! running; then
      if [ ! -f "$PGDIR/PG_VERSION" ]; then
        mkdir -p "$PGDIR"
        if [ "$(id -u)" = "0" ]; then chown postgres "$PGDIR"; fi
        run initdb -D "$PGDIR" -U "$USER_NAME" --auth=trust >/dev/null
      fi
      if ! run pg_ctl -D "$PGDIR" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" \
        -l "$PGDIR/postgres.log" -w start >/dev/null; then
        echo "pg_ctl start failed; last lines of $PGDIR/postgres.log:" >&2
        tail -20 "$PGDIR/postgres.log" >&2 || true
        exit 1
      fi
    fi
    run psql -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" -d postgres -Atc \
      "select 1 from pg_database where datname='parallax'" | grep -q 1 \
      || run createdb -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" parallax
    echo "DATABASE_URL=$URL"
    ;;
  stop)
    if running; then run pg_ctl -D "$PGDIR" -m fast -w stop >/dev/null; fi
    ;;
  status)
    if running; then echo "running"; echo "DATABASE_URL=$URL"; else echo "stopped"; exit 1; fi
    ;;
  *)
    echo "usage: $0 start|stop|status" >&2
    exit 2
    ;;
esac
