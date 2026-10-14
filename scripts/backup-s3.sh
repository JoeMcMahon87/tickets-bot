#!/usr/bin/env bash
#
# Dump the database and ship it to S3.
#
# Intended to be run on the shared Discord-bots EC2 instance by a systemd
# timer (see DiscordBotInfrastructure/user_data.sh), as the `tickets-bot` user,
# with the instance role providing S3 credentials.
#
#   Usage: scripts/backup-s3.sh
#
# Reads from the app .env (or the ambient environment):
#   BACKUP_BUCKET   required — S3 bucket to upload dumps to
#   BACKUP_PREFIX   optional — key prefix, defaults to "db-dumps"
#   BACKUP_KEEP     optional — days of dumps to keep locally, defaults to 7
#
# Lifecycle rules on the bucket handle expiry/Glacier transition of the
# uploaded objects; this script only prunes the local copies.
#
# The dump is written by scripts/dump.mjs, which produces a JSON file that
# scripts/restore.mjs can read back. It is a logical dump, so it is portable
# across DB_PROVIDER values (sqlite/mysql/postgresql).

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
	# shellcheck disable=SC1091
	set -a && source .env && set +a
fi

: "${BACKUP_BUCKET:?BACKUP_BUCKET must be set}"
BACKUP_PREFIX="${BACKUP_PREFIX:-db-dumps}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"

DUMP_DIR="$(pwd)/user/dumps"

echo "[backup] dumping database (provider=${DB_PROVIDER:-unset})"
node scripts/dump.mjs

# dump.mjs names files <YYYY-MM-DD-HH-mm-ss>-db.json; take the one it just made
# rather than assuming a clock format we would have to keep in sync.
latest="$(find "$DUMP_DIR" -maxdepth 1 -name '*-db.json' -newermt '-5 minutes' -print | sort | tail -1)"

if [[ -z "$latest" ]]; then
	echo "[backup] ERROR: no dump produced in $DUMP_DIR" >&2
	exit 1
fi

echo "[backup] uploading $(basename "$latest") ($(du -h "$latest" | cut -f1))"
aws s3 cp "$latest" \
	"s3://${BACKUP_BUCKET}/${BACKUP_PREFIX}/$(basename "$latest")" \
	--only-show-errors

echo "[backup] pruning local dumps older than ${BACKUP_KEEP} days"
find "$DUMP_DIR" -maxdepth 1 -name '*-db.json' -mtime "+${BACKUP_KEEP}" -delete

echo "[backup] done"
