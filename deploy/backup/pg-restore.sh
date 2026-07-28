#!/bin/sh
# Restores a verified backup produced by pg-backup.sh.
#
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
#     run --rm --entrypoint /usr/local/bin/pg-restore.sh postgres-backup \
#     /backups/airchive-20260422T000000Z.dump
#
# Deliberately refuses to run unless RESTORE_CONFIRM=yes is set, because a
# restore overwrites live telemetry that cannot be regenerated: the on-chain
# records survive, but the local index of them does not.
set -eu

archive="${1:-}"
if [ -z "$archive" ]; then
  echo "usage: pg-restore.sh <archive.dump>" >&2
  exit 2
fi
if [ ! -r "$archive" ]; then
  echo "pg-restore: ${archive} is not readable" >&2
  exit 1
fi
if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  echo "pg-restore: refusing to overwrite the live database." >&2
  echo "            Re-run with RESTORE_CONFIRM=yes once you are certain." >&2
  exit 3
fi

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:=airchive}"
: "${POSTGRES_USER:=airchive}"

if [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then
  POSTGRES_PASSWORD=$(cat "$POSTGRES_PASSWORD_FILE")
fi
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

echo "pg-restore: verifying ${archive}"
pg_restore --list "$archive" > /dev/null

echo "pg-restore: restoring into ${POSTGRES_DB} on ${POSTGRES_HOST}:${POSTGRES_PORT}"
pg_restore \
  --host="$POSTGRES_HOST" \
  --port="$POSTGRES_PORT" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner \
  --single-transaction \
  "$archive"

echo "pg-restore: complete. Restart the application services so they reconnect."
