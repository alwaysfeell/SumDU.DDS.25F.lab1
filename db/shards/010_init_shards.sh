#!/usr/bin/env bash
set -euo pipefail

: "${SHARD_DATABASES:?SHARD_DATABASES is not set}"
: "${APP_DB_USER:?APP_DB_USER is not set}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is not set}"

shard_psql() {
  psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" "$@"
}

shard_psql -d postgres -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE :"app_user" WITH LOGIN PASSWORD :'app_password';
SQL

for shard_db in $SHARD_DATABASES; do
  echo "Creating shard database: $shard_db"
  shard_psql -d postgres -v db="$shard_db" <<'SQL'
CREATE DATABASE :"db";
SQL

  shard_psql -d "$shard_db" -v app_user="$APP_DB_USER" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
SQL

  for migration in /docker-entrypoint-migrations/*.sql; do
    echo "  applying $(basename "$migration")"
    shard_psql -d "$shard_db" -f "$migration"
  done
done
