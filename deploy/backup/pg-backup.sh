#!/bin/sh
# Periodic Postgres backup with verification and retention.
#
# Runs as a long-lived container rather than a host cron job so backups are
# part of the same lifecycle as the database itself: `docker compose up` brings
# them back, and `docker compose down` stops them, with no separate host state
# to forget about when the VPS is rebuilt.
#
# Each cycle takes a custom-format dump (pg_restore can do selective restores
# from it and it compresses far better than plain SQL), verifies the archive is
# readable before it counts as a success, then prunes anything older than the
# retention window. A failed dump never deletes an older good one.
set -eu

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:=airchive}"
: "${POSTGRES_USER:=airchive}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_RETENTION_DAYS:=14}"

if [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then
  POSTGRES_PASSWORD=$(cat "$POSTGRES_PASSWORD_FILE")
fi
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

mkdir -p "$BACKUP_DIR"

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') pg-backup: $*"
}

run_backup() {
  stamp=$(date -u '+%Y%m%dT%H%M%SZ')
  target="${BACKUP_DIR}/airchive-${stamp}.dump"
  partial="${target}.partial"

  log "starting dump of ${POSTGRES_DB} to ${target}"
  if ! pg_dump \
    --host="$POSTGRES_HOST" \
    --port="$POSTGRES_PORT" \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --format=custom \
    --compress=9 \
    --no-owner \
    --file="$partial"; then
    log "ERROR dump failed; keeping previous backups untouched"
    rm -f "$partial"
    return 1
  fi

  # An unreadable archive is worse than no archive, because it looks like a
  # backup right up until the restore.
  if ! pg_restore --list "$partial" > /dev/null 2>&1; then
    log "ERROR dump is not readable by pg_restore; discarding"
    rm -f "$partial"
    return 1
  fi

  mv "$partial" "$target"
  size=$(wc -c < "$target" | tr -d ' ')
  log "dump complete (${size} bytes)"

  # Only prune after a verified success.
  removed=$(find "$BACKUP_DIR" -name 'airchive-*.dump' -type f \
    -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')
  if [ "$removed" -gt 0 ]; then
    log "pruned ${removed} backup(s) older than ${BACKUP_RETENTION_DAYS} days"
  fi
  return 0
}

log "backup loop starting (every ${BACKUP_INTERVAL_SECONDS}s, retaining ${BACKUP_RETENTION_DAYS} days)"

while true; do
  run_backup || log "cycle failed; retrying at the next interval"
  sleep "$BACKUP_INTERVAL_SECONDS"
done
