# Backup and restore

Spec §13 asks for restoration to be tested, attachment and version references included, before backups are relied on. `scripts/backup.sh` and `scripts/restore.sh` do the backing up and restoring; `apps/server/test/integration/a22-backup-restore.itest.ts` (scenario A22) runs them on every pull request and every week (`.github/workflows/backup-restore.yml`). Both storage drivers are supported: `a22-backup-restore-s3.itest.ts` runs the same check with `STORAGE_DRIVER=s3` against Garage in the `integration` CI job.

## What a backup holds

```
<backup-dir>/
  database.dump      pg_dump custom format: every schema (application, drizzle, pg-boss queues)
  storage/<key>      every object of the storage root or bucket at its content-addressed key
  storage.manifest   <sha256> TAB <size> TAB <key>, one line per object, sorted by key
  backup.info        format=parallax-backup/1, storage_driver, created_at,
                     pg_dump version, database_sha256, objects
```

Storage keys are content-addressed (`<prefix>/objects/<sha256>`, `apps/server/src/storage/storage.ts`) and objects are never changed or deleted once written. Every row that names an object is written after the object. The database is therefore dumped first and the storage root (or bucket) copied afterwards: every key the dump names is already in the root. Objects written after the dump are copied too and are harmless. Every copied object is hashed, and the backup fails if an object's bytes do not match its key. The backup is written to `<backup-dir>.partial` and renamed only when it is complete.

The layout is the same for both drivers, so a backup of either restores into either (`storage_driver` records where it came from and is informational).

## What a backup keeps of the lifecycle actions

Archived classes and courses are ordinary rows with their archive state, so a restore brings them back archived (and restorable by the owners and membership managers who could restore them before). Results exports (CSV) are temporary files, removed by the daily object sweep (`docs/operations.md`), so a backup may hold one that the sweep has since removed; a student's annotation download is generated on request and is never stored.

## Handling backups

A backup is as sensitive as the live system: `database.dump` holds all personal data, sessions and grades, and `storage/` holds every uploaded file and dataset.

- **Permissions.** `backup.sh` writes the backup private to the user running it: directories 0700, files 0600, whatever the umask and whatever the modes of the source objects. The parents of `<backup-dir>` are left as they are, so put the backup under a directory only that user (and the backup operator) can enter. Restore it as the same user, or copy it with `cp -a` and keep the modes. `restore.sh` itself writes the restored storage root as the application expects (directories 0755, objects 0644).
- **Encrypt off-host.** Copy backups off the host only encrypted (for example `tar -C /backups -c 2026-10-06 | age -r <recipient> > 2026-10-06.tar.age`, or the encryption of the backup store), keep the key apart from the backup, and restrict who can read the destination. The scripts do not encrypt; choosing the tool, the key holders and the destination is a deployment decision (§13, §17).
- **A restore brings back deleted data.** A backup keeps everything that existed when it was taken, including accounts, submissions and files that have since been deleted or anonymised (self-service deletion, retention rules, `docs/operations.md`). After restoring, re-apply every deletion and anonymisation made since the backup was taken before the application is opened to users, and delete or expire old backups on the same schedule as the retention rules.

## Running

```bash
DATABASE_URL=postgres://… STORAGE_DIR=/var/lib/parallax/storage scripts/backup.sh /backups/2026-10-06
```

With `STORAGE_DRIVER=s3`, the scripts read the server's own `S3_*` variables (`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE` as in `apps/server/src/config.ts`) and reach the bucket through `apps/server/src/scripts/s3-backup.ts`, which uses the server's AWS SDK, so they need `pnpm install` in the checkout and no AWS CLI:

```bash
DATABASE_URL=postgres://… STORAGE_DRIVER=s3 S3_ENDPOINT=https://… S3_BUCKET=parallax \
  S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… scripts/backup.sh /backups/2026-10-06
```

The backup lists the whole bucket. Keys under `tmp/` are the adapter's uploads in flight and are skipped, like `.tmp` in a storage root; any other key that is not a content-addressed object fails the backup, as does an object whose bytes do not match its key.

```bash
createdb parallax_restored
DATABASE_URL=postgres://…/parallax_restored STORAGE_DIR=/var/lib/parallax/storage-restored \
  scripts/restore.sh /backups/2026-10-06
```

`restore.sh` never overwrites anything. The target database must have no relations, functions, types or extensions of its own (`plpgsql` aside) and no schemas other than `public`, and the storage root must not exist or must be an empty directory (a volume root or mount point is fine). Before it touches either target, it checks the dump against `backup.info` and every object against `storage.manifest` and its own key. It copies the objects into a staging directory beside the storage root and checks them again. It then restores the database in one transaction (`pg_restore --single-transaction --exit-on-error --no-owner`). The staging directory is renamed into place last with mode 0755, so an API running as another user can read it; when the storage root already exists, the objects are copied into it and its mode and ownership are kept. If any step before the database restore fails, the database stays empty and the storage root is not created.

With `STORAGE_DRIVER=s3`, the target is `S3_BUCKET`, which must already exist and hold no objects at all (the s3 adapter keeps its objects at the bucket root, so there is no prefix to restore into). After the same checks of the backup, every object is uploaded, each only after checking that its key does not exist, and the bucket is then listed and read back: it must hold exactly the manifest's objects with their digests and sizes. The database is restored after that. If the upload, the check or the database restore fails, the objects this run uploaded are deleted again, so the bucket is left empty and the database untouched.

Roles are cluster-wide and are not in the dump. The restoring role owns the restored objects. Create `parallax_runner` (`scripts/runner-role.sql`) before restoring, so that the grants on `pgboss_exec` are restored too; without it, the restore stops and leaves the database empty.

`pg_dump` must be the same major version as the server or newer. `PG_BIN` selects the directory of the PostgreSQL binaries; the default is the newest `/usr/lib/postgresql/*/bin`, then `PATH`.

## Limits

- A bucket restore cannot stop another writer between its emptiness check and its uploads; keep the application stopped (or pointed elsewhere) while restoring. The per-key check means such a writer's objects are never overwritten, and the final listing check fails the restore if any appear.
- The scripts copy each object through the machine running them, one at a time; there is no server-side bucket-to-bucket copy.
- Queued pg-boss jobs are restored with the database and run again when workers start against it.
- The schedule, retention and off-site copies of backups are deployment decisions (§13, §17) and are not made here.
