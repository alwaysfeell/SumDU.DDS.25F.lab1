#!/usr/bin/env bash
set -euo pipefail

: "${REPLICATION_USER:?REPLICATION_USER is not set}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD is not set}"

REPLICA_NAME="${REPLICA_NAME:-replica1}"
SLOT_NAME="${REPLICA_NAME}_slot"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  export PGPASSWORD="$REPLICATION_PASSWORD"

  echo "Waiting for primary..."
  until pg_isready -h db -p 5432 -U "$REPLICATION_USER" -d postgres; do
    sleep 2
  done

  psql -h db -p 5432 -U "$REPLICATION_USER" -d postgres -v ON_ERROR_STOP=1 -tAc \
    "SELECT pg_create_physical_replication_slot('${SLOT_NAME}') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${SLOT_NAME}')"

  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"

  echo "Copying data from primary (pg_basebackup)..."
  gosu postgres pg_basebackup \
    -d "host=db port=5432 user=${REPLICATION_USER} application_name=${REPLICA_NAME}" \
    -D "$PGDATA" -X stream -S "$SLOT_NAME" -R -P

  unset PGPASSWORD
fi

exec docker-entrypoint.sh "$@"
