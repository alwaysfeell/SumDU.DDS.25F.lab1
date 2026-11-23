#!/usr/bin/env bash
set -euo pipefail

: "${REPLICATION_USER:?REPLICATION_USER is not set}"

echo "host replication ${REPLICATION_USER} 0.0.0.0/0 md5" >> "${PGDATA}/pg_hba.conf"
