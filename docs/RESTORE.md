# Restore runbook

What to do when the database or a bucket is lost, corrupted, or must be
rolled back. Pairs with `scripts/backup.sh` / `.github/workflows/backup.yml`
(FIX-16). Rehearsed against the local compose stack on 2026-09-05 — every
command below was run; outputs are quoted.

**Where the backups are** (per site, `deploy/sites.json` id = `<site>`):

| Path on the second provider (`BACKUP_DST_BUCKET`) | Content | Retention |
| --- | --- | --- |
| `<site>/db/<site>-<date>.dump` | `pg_dump --format=custom` of the whole database | 30 days |
| `<site>/media/` | mirror of the live media bucket | current mirror |
| `<site>/media-deleted/<date>/` | objects deleted/overwritten on that night | 90 days |
| `<site>/fiscal/` | mirror of the live fiscal bucket (invoice PDFs/XMLs) | **never expires** |
| `<site>/fiscal-deleted/<date>/` | fiscal objects deleted/overwritten on that night | **never expires** |

Neon's own point-in-time restore (a rolling window sized by the plan) is the
first thing to try for a "we just broke it" incident: Neon console → project →
Branches → *Restore* from a timestamp into a NEW branch. The dump below is for
what PITR cannot do: a window older than the plan keeps, a lost project, or
moving off Neon.

## A. Database from a dump into a fresh Neon branch

Tools: `pg_restore` of the SAME major as the server (Neon runs 16; a 15
client refuses — `pg_restore: error: unsupported version`), `rclone`, and the
repo checked out at the commit that was deployed when the dump was taken (or
later — migrations are additive, so `db:migrate` brings an older dump up).

```bash
# 1. Fetch the dump you want (list, then copy).
rclone ls dst:$BACKUP_DST_BUCKET/sleep/db
rclone copyto dst:$BACKUP_DST_BUCKET/sleep/db/sleep-2026-09-05T02-23-00Z.dump /tmp/sleep.dump

# 2. A FRESH target: Neon console → Branches → New branch from the parent
#    (or an empty project) → copy its UNPOOLED connection string. Never
#    restore over the live database; you cut over by switching env, below.
export RESTORE_URL='postgres://…@ep-xxx.eu-central-1.aws.neon.tech/better_sleep?sslmode=require'

# 3. Restore. --no-owner/--no-privileges: the dump was taken that way and the
#    Neon role differs from whatever owned the source. --clean is NOT used —
#    the target is empty by construction.
pg_restore --no-owner --no-privileges -d "$RESTORE_URL" /tmp/sleep.dump

# 4. Prove the schema is current for the code you are about to run.
DIRECT_DATABASE_URL="$RESTORE_URL" pnpm db:status
#    "db:status — up to date (N migrations applied)". If it prints PENDING
#    (the dump predates a deploy), apply them:
DIRECT_DATABASE_URL="$RESTORE_URL" pnpm db:migrate
DIRECT_DATABASE_URL="$RESTORE_URL" pnpm db:role-timeout
```

Rehearsal (local stack; the compose `db` container carries pg_dump/pg_restore 16):

```
$ docker compose exec -T db pg_dump --format=custom --no-owner --no-privileges -U better better_sleep > /tmp/sleep.dump
$ docker compose exec -T db psql -U better -d postgres -c "create database better_restore_rehearsal owner better"
$ docker compose exec -T db pg_restore --no-owner --no-privileges -U better -d better_restore_rehearsal < /tmp/sleep.dump
pg_restore exit=0
$ DATABASE_URL=postgres://better:better@localhost:5433/better_restore_rehearsal pnpm db:status
db:status — up to date (28 migrations applied)
$ DATABASE_URL=…/better_restore_rehearsal pnpm launch:check --dev --no-probe
launch:check — target node, SITE_ID sleep, --dev: OK (…)
```

## B. Buckets

`rclone copy` (never `sync` in this direction — a sync would DELETE live
objects that the backup does not have, e.g. everything uploaded since the
last night):

```bash
# media: everything, or one prefix
rclone copy dst:$BACKUP_DST_BUCKET/sleep/media src:bettersleep-media
# a single object that was deleted last Tuesday
rclone copy dst:$BACKUP_DST_BUCKET/sleep/media-deleted/2026-09-02T02-23-00Z/uploads/abc.jpg src:bettersleep-media/uploads/

# fiscal documents: the same, from the mirror or the dated parked copies
rclone copy dst:$BACKUP_DST_BUCKET/sleep/fiscal src:bettersleep-fiscal
```

The `src` remote in the backup workflow is a READ-ONLY token; for a restore
use a token with write access (an ad-hoc `RCLONE_CONFIG_SRC_*` set in your
shell — see the header of `scripts/backup.sh` for the variable names).

## C. Cut over and verify

1. Point the deployment at the restored database: Vercel → project →
   Settings → Environment Variables → `DATABASE_URL` (pooled URL of the new
   branch) and `DIRECT_DATABASE_URL` (unpooled); update the GitHub secret
   `DIRECT_DATABASE_URL_<SITE>` (`deploy/sites.json`) so CI migrates the
   right database from now on. Redeploy (Actions → ci → Run workflow).
2. Preflight from a checkout with the new env exported:
   `pnpm launch:check --target=vercel` — clean, no warnings you did not
   expect.
3. `curl https://<site>/api/health/ready` → `200 {"status":"ok",…}`.
4. Download one invoice: `/admin/orders` → a paid order → *Descarcă
   factura* — the PDF opens, its number matches the order, and the file the
   bucket serves is byte-identical to `<site>/fiscal/…` in the backup
   (`rclone check src:bettersleep-fiscal dst:$BACKUP_DST_BUCKET/sleep/fiscal`
   reports 0 differences).
5. `LAUNCH-CHECKLIST.md`: tick "one verified restore" with today's date and
   the dump file name.

## R2 lifecycle rules — what to set on the LIVE buckets

- **Media bucket**: optional — expire `pending/` (upload quarantine) after
  1 day; never expire `uploads/`.
- **Fiscal bucket**: NO expiry rule, no "delete after N days", ever. Add
  object versioning if the provider offers it. The backup mirror above is the
  second copy the law effectively requires; the parked `fiscal-deleted/`
  copies are the third.
- **Backup bucket** (second provider): no lifecycle rules — retention is the
  script's job (`rclone delete --min-age`), and it deliberately never touches
  `<site>/fiscal*`.
