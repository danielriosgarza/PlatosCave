#!/usr/bin/env bash
# Restores a backup written by scripts/backup.sh into an empty database and a new storage root
# (spec §13, P4-07).
#
#   DATABASE_URL=… STORAGE_DIR=… scripts/restore.sh <backup-dir>
#
# Nothing is overwritten: the database in DATABASE_URL must hold no tables, views, sequences,
# functions, types, extensions or schemas of its own (create it first, for example with
# createdb), and STORAGE_DIR must not exist or be an empty directory (a mount point is fine). Before touching either, every object in the backup is hashed
# and checked against storage.manifest and its own key, and the dump against backup.info. The
# objects are then copied into a staging directory beside STORAGE_DIR and checked again; the
# database is restored in one transaction; the staging directory is renamed to STORAGE_DIR last
# (mode 0755), or, when STORAGE_DIR already exists, its objects are copied into it and its mode
# is kept.
# Roles are cluster-wide and not in the dump: the restoring role owns the restored objects, and
# grants to other roles (parallax_runner, scripts/runner-role.sql) need those roles to exist.
# Only STORAGE_DRIVER=fs is supported; see docs/backup-restore.md.
# PG_BIN overrides the directory of pg_restore and psql (default: newest /usr/lib/postgresql/*/bin).
set -euo pipefail

die() { echo "restore: $*" >&2; exit 1; }

[ $# -eq 1 ] || { echo "usage: $0 <backup-dir>" >&2; exit 2; }
[ -d "$1" ] || die "$1 is not a directory"
IN="$(cd "$1" && pwd)"
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is required"
[ "${STORAGE_DRIVER:-fs}" = fs ] || die "STORAGE_DRIVER=${STORAGE_DRIVER} is not supported; only fs"
STORAGE="${STORAGE_DIR:-.local/storage}"
STORAGE="${STORAGE%/}"

BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)}"
if [ -n "$BIN" ]; then PATH="$BIN:$PATH"; fi
command -v pg_restore >/dev/null || die "pg_restore not found"
command -v psql >/dev/null || die "psql not found"

# 1. The backup is complete and intact.
for f in backup.info database.dump storage.manifest; do
  [ -f "$IN/$f" ] || die "$IN/$f is missing"
done
grep -qx 'format=parallax-backup/1' "$IN/backup.info" || die "$IN is not a parallax-backup/1 backup"
expected="$(sed -n 's/^database_sha256=//p' "$IN/backup.info")"
[ "$(sha256sum "$IN/database.dump" | cut -d' ' -f1)" = "$expected" ] \
  || die "database.dump does not match the digest in backup.info"
[ "$(wc -l < "$IN/storage.manifest" | tr -d ' ')" = "$(sed -n 's/^objects=//p' "$IN/backup.info")" ] \
  || die "storage.manifest does not list the number of objects in backup.info"

# Checks that the objects under $1 are exactly those of the manifest, byte for byte.
verify_objects() {
  local root="$1" listed found
  listed="$(cut -f3 "$IN/storage.manifest")"
  found="$(cd "$root" && find . -type f -printf '%P\n' | LC_ALL=C sort)"
  [ "$listed" = "$found" ] || die "objects in $root differ from storage.manifest"
  [ -s "$IN/storage.manifest" ] || return 0
  awk -F'\t' '{
      n = split($3, parts, "/")
      if (parts[n] != $1) { print "manifest entry " $3 " names digest " $1 > "/dev/stderr"; exit 1 }
      printf "%s  %s\n", $1, $3
    }' "$IN/storage.manifest" | (cd "$root" && sha256sum --quiet --strict -c -) \
    || die "objects in $root do not match their digests"
  [ "$(cd "$root" && cut -f3 "$IN/storage.manifest" | tr '\n' '\0' | xargs -0 stat -c '%s	%n')" \
    = "$(cut -f2,3 "$IN/storage.manifest")" ] || die "object sizes in $root differ from storage.manifest"
}
[ -d "$IN/storage" ] || die "$IN/storage is missing"
verify_objects "$IN/storage"

# 2. The targets are empty.
if [ -e "$STORAGE" ]; then
  [ -d "$STORAGE" ] && [ -z "$(ls -A "$STORAGE")" ] || die "storage root $STORAGE is not empty"
  [ -w "$STORAGE" ] && [ -x "$STORAGE" ] || die "storage root $STORAGE is not writable"
fi
own="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "
  select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
     and n.nspname not like 'pg_temp%'
  " )"
procs="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "
  select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public')
       + (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public' and t.typrelid = 0 and t.typcategory <> 'A')
       + (select count(*) from pg_extension where extname <> 'plpgsql')
  ")" || die "cannot query the target database"
schemas="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "
  select count(*) from pg_namespace
   where nspname not in ('pg_catalog', 'information_schema', 'public')
     and nspname not like 'pg_toast%' and nspname not like 'pg_temp%'
  ")"
[ "$own" = 0 ] && [ "$schemas" = 0 ] && [ "$procs" = 0 ] || die "the target database is not empty"

# 3. Objects into a staging directory beside the storage root, checked again.
parent="$(dirname "$STORAGE")"
mkdir -p "$parent"
STAGE="$(mktemp -d "$parent/.restore-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$IN/storage/." "$STAGE/"
verify_objects "$STAGE"

# 4. The database, all or nothing.
pg_restore --exit-on-error --single-transaction --no-owner --dbname="$DATABASE_URL" "$IN/database.dump"

# 5. The storage root.
if [ -d "$STORAGE" ]; then
  cp -R "$STAGE/." "$STORAGE/"
  verify_objects "$STORAGE"
else
  chmod 0755 "$STAGE"
  mv "$STAGE" "$STORAGE"
  trap - EXIT
fi
echo "restore: restored $IN ($(wc -l < "$IN/storage.manifest" | tr -d ' ') objects) into $STORAGE"
