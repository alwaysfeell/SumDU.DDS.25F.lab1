#!/usr/bin/env bash
set -euo pipefail

: "${REPLICATION_USER:?REPLICATION_USER is not set}"

HBA="${PGDATA}/pg_hba.conf"

sed -i -E '/^host[[:space:]]+all[[:space:]]+all[[:space:]]+all[[:space:]]/d' "$HBA"

cat >> "$HBA" <<HBA_RULES
host all all samenet scram-sha-256
host replication ${REPLICATION_USER} samenet scram-sha-256
HBA_RULES
