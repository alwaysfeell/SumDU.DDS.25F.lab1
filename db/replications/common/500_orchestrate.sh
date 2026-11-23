#!/usr/bin/env bash
set -euo pipefail

run_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -type f \( -name "*.sql" -o -name "*.sh" \) | sort | while read -r f; do
    case "$f" in
      *.sql)
        echo "Applying SQL: $f"
        psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$f"
        ;;
      *.sh)
        echo "Running SH: $f"
        bash "$f"
        ;;
    esac
  done
}

run_dir "/docker-entrypoint-migrations"
run_dir "/docker-entrypoint-replications"
