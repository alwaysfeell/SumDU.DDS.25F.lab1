#!/usr/bin/env bash
set -euo pipefail

HBA="${PGDATA}/pg_hba.conf"

sed -i -E '/^host[[:space:]]+all[[:space:]]+all[[:space:]]+all[[:space:]]/d' "$HBA"

cat >> "$HBA" <<'HBA_RULES'
host all all samenet scram-sha-256
HBA_RULES
