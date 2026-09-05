#!/usr/bin/env bash
# Nightly backup of one site (FIX-16, audit "No backup/restore path"):
#   1. pg_dump --format=custom of the UNPOOLED database URL → dated file,
#      uploaded to <dst>/<site>/db/, kept BACKUP_DB_RETENTION_DAYS (30);
#   2. rclone sync of the media bucket → <dst>/<site>/media, with deleted or
#      overwritten objects parked under media-deleted/<date> for
#      BACKUP_MEDIA_RETENTION_DAYS (90);
#   3. rclone sync of the fiscal bucket → <dst>/<site>/fiscal, parked copies
#      under fiscal-deleted/<date> — and NOTHING is ever deleted there: the
#      invoices/XMLs the law requires be retained have no expiry.
# Restore: docs/RESTORE.md. Runs from .github/workflows/backup.yml or a VPS
# cron (`23 2 * * * … bash scripts/backup.sh`). `--dry-run` prints the exact
# commands and touches nothing. Secrets travel as environment variables only
# (rclone reads RCLONE_CONFIG_*; pg_dump reads the URL from the env) — they
# never appear on a command line or in the log.
#
# Environment:
#   BACKUP_SITE                 site id (deploy/sites.json) — the prefix on the destination
#   DIRECT_DATABASE_URL         unpooled database URL (Neon: the non-pooler host)
#   BACKUP_MEDIA_BUCKET         live media bucket name
#   BACKUP_FISCAL_BUCKET        live fiscal bucket name
#   BACKUP_SRC_ENDPOINT / BACKUP_SRC_ACCESS_KEY / BACKUP_SRC_SECRET_KEY
#                               the live bucket account (R2) — a READ-ONLY token
#   BACKUP_SRC_PROVIDER         rclone S3 provider name of the source (default Cloudflare)
#   BACKUP_DST_ENDPOINT / BACKUP_DST_ACCESS_KEY / BACKUP_DST_SECRET_KEY
#                               the SECOND provider (never the same account)
#   BACKUP_DST_PROVIDER         rclone S3 provider name of the destination (default Other)
#   BACKUP_DST_BUCKET           destination bucket; holds <site>/db, <site>/media, <site>/fiscal
#   BACKUP_DB_RETENTION_DAYS    default 30
#   BACKUP_MEDIA_RETENTION_DAYS default 90 (parked media copies only)
#   BACKUP_DATE                 override the timestamp (tests); default now, UTC
#   BACKUP_WORKDIR              where the dump is written before upload (default $TMPDIR)
set -euo pipefail

dry=false
for arg in "$@"; do
	case "$arg" in
		--dry-run) dry=true ;;
		*)
			echo "backup.sh: unknown argument '$arg' (usage: backup.sh [--dry-run])" >&2
			exit 2
			;;
	esac
done

for name in BACKUP_SITE DIRECT_DATABASE_URL BACKUP_MEDIA_BUCKET BACKUP_FISCAL_BUCKET \
	BACKUP_SRC_ENDPOINT BACKUP_SRC_ACCESS_KEY BACKUP_SRC_SECRET_KEY \
	BACKUP_DST_ENDPOINT BACKUP_DST_ACCESS_KEY BACKUP_DST_SECRET_KEY BACKUP_DST_BUCKET; do
	if [ -z "${!name:-}" ]; then
		echo "backup.sh: $name is not set — refusing to back up to nowhere (see the header of this script)" >&2
		exit 2
	fi
done

site="$BACKUP_SITE"
date="${BACKUP_DATE:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
db_keep="${BACKUP_DB_RETENTION_DAYS:-30}"
media_keep="${BACKUP_MEDIA_RETENTION_DAYS:-90}"
workdir="${BACKUP_WORKDIR:-${TMPDIR:-/tmp}}/better-backup"
dump_file="$workdir/$site-$date.dump"
dst="dst:$BACKUP_DST_BUCKET/$site"

# rclone remotes from the environment — no config file, no secrets in argv.
export RCLONE_CONFIG_SRC_TYPE=s3
export RCLONE_CONFIG_SRC_PROVIDER="${BACKUP_SRC_PROVIDER:-Cloudflare}"
export RCLONE_CONFIG_SRC_ENDPOINT="$BACKUP_SRC_ENDPOINT"
export RCLONE_CONFIG_SRC_ACCESS_KEY_ID="$BACKUP_SRC_ACCESS_KEY"
export RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$BACKUP_SRC_SECRET_KEY"
export RCLONE_CONFIG_DST_TYPE=s3
export RCLONE_CONFIG_DST_PROVIDER="${BACKUP_DST_PROVIDER:-Other}"
export RCLONE_CONFIG_DST_ENDPOINT="$BACKUP_DST_ENDPOINT"
export RCLONE_CONFIG_DST_ACCESS_KEY_ID="$BACKUP_DST_ACCESS_KEY"
export RCLONE_CONFIG_DST_SECRET_ACCESS_KEY="$BACKUP_DST_SECRET_KEY"

if ! $dry; then
	for tool in pg_dump rclone; do
		command -v "$tool" >/dev/null || {
			echo "backup.sh: $tool is not installed" >&2
			exit 1
		}
	done
	mkdir -p "$workdir"
fi

# Print, then run (unless --dry-run). The database URL is shown as the
# variable, never its value.
run() {
	printf '%s\n' "$1"
	shift
	$dry || "$@"
}

# 1. Database ---------------------------------------------------------------
run "pg_dump --format=custom --no-owner --no-privileges --file=$dump_file \"\$DIRECT_DATABASE_URL\"" \
	pg_dump --format=custom --no-owner --no-privileges --file="$dump_file" "$DIRECT_DATABASE_URL"
run "rclone copyto $dump_file $dst/db/$site-$date.dump" \
	rclone copyto "$dump_file" "$dst/db/$site-$date.dump"
run "rclone delete --min-age ${db_keep}d $dst/db" \
	rclone delete --min-age "${db_keep}d" "$dst/db"
$dry || rm -f "$dump_file"

# 2. Media bucket -----------------------------------------------------------
run "rclone sync src:$BACKUP_MEDIA_BUCKET $dst/media --backup-dir $dst/media-deleted/$date" \
	rclone sync "src:$BACKUP_MEDIA_BUCKET" "$dst/media" --backup-dir "$dst/media-deleted/$date"
run "rclone delete --min-age ${media_keep}d $dst/media-deleted" \
	rclone delete --min-age "${media_keep}d" "$dst/media-deleted"

# 3. Fiscal bucket — synced, parked copies kept forever, never deleted -------
run "rclone sync src:$BACKUP_FISCAL_BUCKET $dst/fiscal --backup-dir $dst/fiscal-deleted/$date" \
	rclone sync "src:$BACKUP_FISCAL_BUCKET" "$dst/fiscal" --backup-dir "$dst/fiscal-deleted/$date"

echo "backup — site $site @ $date: db dump + media + fiscal → $dst (retention: db ${db_keep}d, media-deleted ${media_keep}d, fiscal never)$($dry && echo ' [dry run]')"
