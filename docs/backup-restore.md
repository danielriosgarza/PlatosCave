# Backup and restore

Spec §13 asks for restoration to be tested, attachment and version references included, before backups are relied on. `scripts/backup.sh` and `scripts/restore.sh` do the backing up and restoring; `apps/server/test/integration/a22-backup-restore.itest.ts` (scenario A22) runs them on every pull request and every week (`.github/workflows/backup-restore.yml`).

## What a backup holds

```
<backup-dir>/
  database.dump      pg_dump custom format: every schema (application, drizzle, pg-boss queues)
  storage/<key>      every object of the storage root at its content-addressed key
  storage.manifest   <sha256> TAB <size> TAB <key>, one line per object, sorted by key
  backup.info        format=parallax-backup/1, created_at, pg_dump version,
                     database_sha256, objects
```

Storage keys are content-addressed (`<prefix>/objects/<sha256>`, `apps/server/src/storage/storage.ts`) and objects are never changed or deleted once written. Every row that names an object is written after the object. The database is therefore dumped first and the storage root copied afterwards: every key the dump names is already in the root. Objects written after the dump are copied too and are harmless. Every copied object is hashed, and the backup fails if an object's bytes do not match its key. The backup is written to `<backup-dir>.partial` and renamed only when it is complete.

## Running

```bash
DATABASE_URL=postgres://… STORAGE_DIR=/var/lib/parallax/storage scripts/backup.sh /backups/2026-10-06
```

```bash
createdb parallax_restored
DATABASE_URL=postgres://…/parallax_restored STORAGE_DIR=/var/lib/parallax/storage-restored \
  scripts/restore.sh /backups/2026-10-06
```

`restore.sh` never overwrites anything. The target database must have no relations, functions, types or extensions of its own (`plpgsql` aside) and no schemas other than `public`, and the storage root must not exist or must be an empty directory (a volume root or mount point is fine). Before it touches either target, it checks the dump against `backup.info` and every object against `storage.manifest` and its own key. It copies the objects into a staging directory beside the storage root and checks them again. It then restores the database in one transaction (`pg_restore --single-transaction --exit-on-error --no-owner`). The staging directory is renamed into place last with mode 0755, so an API running as another user can read it; when the storage root already exists, the objects are copied into it and its mode and ownership are kept. If any step before the database restore fails, the database stays empty and the storage root is not created.

Roles are cluster-wide and are not in the dump. The restoring role owns the restored objects. Create `parallax_runner` (`scripts/runner-role.sql`) before restoring, so that the grants on `pgboss_exec` are restored too; without it, the restore stops and leaves the database empty.

`pg_dump` must be the same major version as the server or newer. `PG_BIN` selects the directory of the PostgreSQL binaries; the default is the newest `/usr/lib/postgresql/*/bin`, then `PATH`.

## Limits

- Only `STORAGE_DRIVER=fs` is supported. With `s3`, both scripts refuse to run; a bucket snapshot is follow-up work (P4-07a, #335).
- Queued pg-boss jobs are restored with the database and run again when workers start against it.
- The schedule, retention and off-site copies of backups are deployment decisions (§13, §17) and are not made here.
