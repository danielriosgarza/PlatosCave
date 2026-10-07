#!/usr/bin/env bash
# Backs up the database and the storage root into a new directory (spec §13, P4-07).
#
#   DATABASE_URL=… STORAGE_DIR=… scripts/backup.sh <backup-dir>
#   DATABASE_URL=… STORAGE_DRIVER=s3 S3_BUCKET=… S3_…=… scripts/backup.sh <backup-dir>
#
# <backup-dir> must not exist. It holds:
#   database.dump     pg_dump custom format of the whole database (every schema)
#   storage/<key>     every object of the storage root or bucket, at its content-addressed key
#   storage.manifest  one line per object: <sha256> TAB <size> TAB <key>, sorted by key
#   backup.info       format, time, pg_dump version, database dump digest, object count
#
# The dump is taken first and the storage root (or bucket) copied after it: objects are immutable and
# written before any row names them, so every key the dump refers to is already in the root.
# Each copied object is hashed and must match the digest its key names, so a corrupt object
# fails the backup instead of being preserved. The directory is written as <backup-dir>.partial
# and renamed when complete. With STORAGE_DRIVER=s3 the objects are downloaded from S3_BUCKET by
# apps/server/src/scripts/s3-backup.ts, which reads the server's S3_* variables; the bucket must
# hold only content-addressed objects (and the adapter's in-flight tmp/ uploads, which are
# skipped). See docs/backup-restore.md.
# PG_BIN overrides the directory of pg_dump (default: the newest /usr/lib/postgresql/*/bin).
set -euo pipefail

die() { echo "backup: $*" >&2; exit 1; }

[ $# -eq 1 ] || { echo "usage: $0 <backup-dir>" >&2; exit 2; }
OUT="${1%/}"
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is required"
DRIVER="${STORAGE_DRIVER:-fs}"
case "$DRIVER" in
  fs)
    STORAGE="${STORAGE_DIR:-.local/storage}"
    [ -d "$STORAGE" ] || die "storage root $STORAGE does not exist"
    ;;
  s3)
    [ -n "${S3_BUCKET:-}" ] || die "S3_BUCKET is required"
    SERVER="$(cd "$(dirname "$0")/../apps/server" && pwd)"
    [ -x "$SERVER/node_modules/.bin/tsx" ] || die "run pnpm install first (apps/server needs tsx)"
    ;;
  *) die "STORAGE_DRIVER=$DRIVER is not supported; only fs and s3" ;;
esac
[ ! -e "$OUT" ] || die "$OUT already exists"

BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)}"
if [ -n "$BIN" ]; then PATH="$BIN:$PATH"; fi
command -v pg_dump >/dev/null || die "pg_dump not found"

# A content-addressed key: safe path segments, then objects/<sha256> (apps/server/src/storage).
KEY_PATTERN='^[A-Za-z0-9][A-Za-z0-9_-]*(/[A-Za-z0-9][A-Za-z0-9_-]*)*/objects/[0-9a-f]{64}$'

WORK="$OUT.partial"
rm -rf "$WORK"
mkdir -p "$WORK/storage"
trap 'rm -rf "$WORK"' EXIT

pg_dump --format=custom --file="$WORK/database.dump" "$DATABASE_URL"

if [ "$DRIVER" = s3 ]; then
  # Into the backup directly; the keys are checked below like those of a storage root.
  dest="$(cd "$WORK/storage" && pwd)"
  (cd "$SERVER" && node_modules/.bin/tsx src/scripts/s3-backup.ts download "$dest") >/dev/null \
    || die "cannot download the objects of bucket $S3_BUCKET"
  STORAGE_ABS="$dest"
else
  STORAGE_ABS="$(cd "$STORAGE" && pwd)"
fi

# Every regular file outside .tmp (the adapter's in-flight uploads) must be an object.
(cd "$STORAGE_ABS" && find . -path ./.tmp -prune -o \( -type f -printf '%P\n' \) -o \
  \( ! -type d -printf 'not a regular file: %P\n' \) ) | LC_ALL=C sort > "$WORK/keys"
if grep -q '^not a regular file: ' "$WORK/keys"; then
  grep '^not a regular file: ' "$WORK/keys" >&2
  die "the storage root holds entries that are not objects"
fi
if grep -Ev "$KEY_PATTERN" "$WORK/keys" >&2; then
  die "the storage root holds files whose names are not content-addressed keys"
fi

if [ "$DRIVER" = fs ]; then
  while IFS= read -r key; do
    mkdir -p "$WORK/storage/$(dirname "$key")"
    cp "$STORAGE_ABS/$key" "$WORK/storage/$key"
  done < "$WORK/keys"
fi

# Hash the copies, which is what the backup holds, and check each against its key.
: > "$WORK/storage.manifest"
if [ -s "$WORK/keys" ]; then
  (cd "$WORK/storage" && tr '\n' '\0' < ../keys | xargs -0 sha256sum --) > "$WORK/digests"
  (cd "$WORK/storage" && tr '\n' '\0' < ../keys | xargs -0 stat -c '%s') > "$WORK/sizes"
  paste "$WORK/digests" "$WORK/sizes" | awk -F'\t' '
    {
      split($1, d, "  ")
      hash = d[1]; key = substr($1, length(hash) + 3); n = split(key, parts, "/")
      if (parts[n] != hash) { print "digest of " key " is " hash > "/dev/stderr"; bad = 1 }
      printf "%s\t%s\t%s\n", hash, $2, key
    }
    END { exit bad }' > "$WORK/storage.manifest" || die "objects whose bytes do not match their key"
  rm "$WORK/digests" "$WORK/sizes"
fi
rm "$WORK/keys"

{
  echo "format=parallax-backup/1"
  echo "storage_driver=$DRIVER"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "pg_dump=$(pg_dump --version)"
  echo "database_sha256=$(sha256sum "$WORK/database.dump" | cut -d' ' -f1)"
  echo "objects=$(wc -l < "$WORK/storage.manifest" | tr -d ' ')"
} > "$WORK/backup.info"

mv "$WORK" "$OUT"
trap - EXIT
echo "backup: wrote $OUT ($(grep '^objects=' "$OUT/backup.info" | cut -d= -f2) objects)"
