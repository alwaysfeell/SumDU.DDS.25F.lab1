import os
import subprocess
import time

from psycopg import sql
from psycopg.conninfo import make_conninfo

from tools.common import connect, label, print_table, resolve

STEPS = 7


def _step(number: int, text: str) -> None:
    print(f"[{number}/{STEPS}] {text}", flush=True)


def _app_user() -> str:
    return os.environ.get("APP_DB_USER", "traveler_app")


def _target(doc: dict, node: str, dbname: str) -> dict:
    info = doc["nodes"][node]
    return {"node": node, "host": info["host"], "port": int(info["port"]), "dbname": dbname}


def _database_exists(target: dict) -> bool:
    with connect(target, "postgres", autocommit=True) as conn:
        return conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (target["dbname"],)
        ).fetchone() is not None


def _copy_schema(src: dict, dst: dict) -> None:
    env = {**os.environ, "PGPASSWORD": os.environ["POSTGRES_PASSWORD"]}
    user = os.environ["POSTGRES_USER"]
    dump = subprocess.run(
        ["pg_dump", "--schema-only", "--no-publications", "--no-subscriptions",
         "-h", src["host"], "-p", str(src["port"]), "-U", user, "-d", src["dbname"]],
        env=env, capture_output=True, text=True,
    )
    if dump.returncode != 0:
        raise RuntimeError("pg_dump failed: " + dump.stderr.strip())
    restore = subprocess.run(
        ["psql", "-v", "ON_ERROR_STOP=1", "-q",
         "-h", dst["host"], "-p", str(dst["port"]), "-U", user, "-d", dst["dbname"]],
        input=dump.stdout, env=env, capture_output=True, text=True,
    )
    if restore.returncode != 0:
        raise RuntimeError("schema restore failed: " + restore.stderr.strip())


def _wait_sync(dst: dict, name: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last = None
    with connect(dst, autocommit=True) as conn:
        while True:
            row = conn.execute(
                "SELECT count(*) AS total, count(*) FILTER (WHERE r.srsubstate = 'r') AS ready "
                "FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid = r.srsubid "
                "WHERE s.subname = %s",
                (name,),
            ).fetchone()
            state = (row["ready"], row["total"])
            if state != last:
                print(f"      tables ready: {row['ready']}/{row['total']}", flush=True)
                last = state
            if row["total"] > 0 and row["ready"] == row["total"]:
                return
            if time.monotonic() > deadline:
                raise TimeoutError(f"initial synchronization did not finish in {timeout:.0f} s")
            time.sleep(0.5)


def _wait_lsn(src: dict, name: str, lsn: str, timeout: float = 60) -> None:
    deadline = time.monotonic() + timeout
    with connect(src, autocommit=True) as conn:
        while True:
            row = conn.execute(
                "SELECT confirmed_flush_lsn, confirmed_flush_lsn >= %s::pg_lsn AS done "
                "FROM pg_replication_slots WHERE slot_name = %s",
                (lsn, name),
            ).fetchone()
            if row and row["done"]:
                print(f"      source WAL position {lsn}, replica confirmed {row['confirmed_flush_lsn']}", flush=True)
                return
            if time.monotonic() > deadline:
                raise TimeoutError(f"replica did not reach {lsn} in {timeout:.0f} s")
            time.sleep(0.1)


def _checksum(conn, table: sql.Composable) -> dict:
    return conn.execute(
        sql.SQL(
            "SELECT count(*) AS rows, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS md5 "
            "FROM {} t"
        ).format(table)
    ).fetchone()


def _verify(lock_conn, dst: dict, tables: list[tuple[str, str]]) -> None:
    rows, ok = [], True
    with connect(dst, autocommit=True) as conn:
        conn.execute("SET TIME ZONE 'UTC'")
        for schema, table in tables:
            ident = sql.Identifier(schema, table)
            a = _checksum(lock_conn, ident)
            b = _checksum(conn, ident)
            same = a["rows"] == b["rows"] and a["md5"] == b["md5"]
            ok = ok and same
            rows.append([f"{schema}.{table}", a["rows"], b["rows"], a["md5"][:12], "yes" if same else "NO"])
    print_table(["table", "rows on source", "rows on target", "md5", "match"], rows)
    if not ok:
        raise RuntimeError("data on the target differs from the source")


def _cleanup(src: dict, dst: dict, name: str, created: bool) -> None:
    print("Cleaning up after the failed move...", flush=True)
    if created:
        try:
            with connect(dst, autocommit=True) as conn:
                if conn.execute("SELECT 1 FROM pg_subscription WHERE subname = %s", (name,)).fetchone():
                    conn.execute(sql.SQL("DROP SUBSCRIPTION {}").format(sql.Identifier(name)))
        except Exception as exc:
            print(f"  could not drop subscription: {exc}")
    try:
        with connect(src, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP PUBLICATION IF EXISTS {}").format(sql.Identifier(name)))
            if conn.execute("SELECT 1 FROM pg_replication_slots WHERE slot_name = %s", (name,)).fetchone():
                conn.execute("SELECT pg_drop_replication_slot(%s)", (name,))
    except Exception as exc:
        print(f"  could not drop publication/slot: {exc}")
    if created:
        try:
            with connect(dst, "postgres", autocommit=True) as conn:
                conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(dst["dbname"])))
        except Exception as exc:
            print(f"  could not drop {label(dst)}: {exc}")
    print("The shard stays on the source, the mapping was not changed.")


def move(key: str, target_node: str, store, sync_timeout: float = 300, lock_timeout: int = 10) -> int:
    doc = store.load()
    if target_node not in doc["nodes"]:
        print(f"Unknown node '{target_node}'. Nodes: {', '.join(doc['nodes'])}")
        return 2
    src = resolve(doc)[key]
    if src["node"] == target_node:
        print(f"Shard {key} is already on {target_node}.")
        return 2
    dst = _target(doc, target_node, src["dbname"])
    if _database_exists(dst):
        print(f"Database {label(dst)} already exists (left from an earlier move?).")
        print(f"Remove it first: shardctl drop-old {src['dbname']} --node {target_node}")
        return 2

    name = f"shardctl_move_{src['dbname']}"
    print(f"Moving shard {key}: {label(src)} -> {label(dst)}")
    started = time.perf_counter()
    created = switched = False
    lock_conn = None
    try:
        _step(1, f"create {label(dst)}, copy the schema, start logical replication")
        with connect(dst, "postgres", autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dst["dbname"])))
        created = True
        _copy_schema(src, dst)
        with connect(src, autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE PUBLICATION {} FOR ALL TABLES").format(sql.Identifier(name)))
        source_conninfo = make_conninfo(
            host=src["host"], port=src["port"], dbname=src["dbname"],
            user=os.environ["POSTGRES_USER"], password=os.environ["POSTGRES_PASSWORD"],
        )
        with connect(dst, autocommit=True) as conn:
            conn.execute(
                sql.SQL("CREATE SUBSCRIPTION {} CONNECTION {} PUBLICATION {} WITH (copy_data = true)").format(
                    sql.Identifier(name), sql.Literal(source_conninfo), sql.Identifier(name)
                )
            )

        _step(2, "wait until the initial copy is finished")
        _wait_sync(dst, name, sync_timeout)

        _step(3, "LOCK TABLE ... IN EXCLUSIVE MODE on the source, wait for the replica to catch up")
        lock_conn = connect(src)
        lock_conn.execute(sql.SQL("SET lock_timeout = {}").format(sql.Literal(f"{lock_timeout}s")))
        lock_conn.execute("SET TIME ZONE 'UTC'")
        tables = [
            (r["schemaname"], r["tablename"])
            for r in lock_conn.execute(
                "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = %s ORDER BY 1, 2",
                (name,),
            ).fetchall()
        ]
        lock_conn.execute(
            sql.SQL("LOCK TABLE {} IN EXCLUSIVE MODE").format(
                sql.SQL(", ").join(sql.Identifier(s, t) for s, t in tables)
            )
        )
        locked_at = time.perf_counter()
        lsn = lock_conn.execute("SELECT pg_current_wal_lsn() AS lsn").fetchone()["lsn"]
        _wait_lsn(src, name, lsn)
        _verify(lock_conn, dst, tables)

        _step(4, "promote the copy to master: DROP SUBSCRIPTION")
        with connect(dst, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP SUBSCRIPTION {}").format(sql.Identifier(name)))

        _step(5, f"update the {store.name}: shard {key} -> {target_node}")
        version = store.move_shard(key, target_node)
        switched = True
        print(f"      mapping version {version}", flush=True)

        _step(6, f"REVOKE ALL ON ALL TABLES FROM {_app_user()} in the old database, release the lock")
        lock_conn.execute(
            sql.SQL("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {}").format(sql.Identifier(_app_user()))
        )
        lock_conn.commit()
        blocked_ms = (time.perf_counter() - locked_at) * 1000
        lock_conn.close()
        lock_conn = None
        with connect(src, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP PUBLICATION IF EXISTS {}").format(sql.Identifier(name)))

        _step(7, "applications get 'permission denied' (42501) on the old database and reload the mapping")
        print()
        print(f"Done in {time.perf_counter() - started:.1f} s, writes to shard {key} were blocked for {blocked_ms:.0f} ms.")
        print(f"Shard {key} is now served by {label(dst)}.")
        print(f"The old copy {label(src)} is kept read-protected. Remove it later with:")
        print(f"  shardctl drop-old {src['dbname']} --node {src['node']}")
        return 0
    except Exception as exc:
        print(f"ERROR: {str(exc).strip()}", flush=True)
        if lock_conn is not None:
            lock_conn.rollback()
            lock_conn.close()
        if switched:
            print("The mapping already points to the new database. Finish manually:")
            print(f"  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {_app_user()};  -- in {label(src)}")
        else:
            _cleanup(src, dst, name, created)
        return 1


def drop_old(key: str, node: str, store, force: bool) -> int:
    doc = store.load()
    current = resolve(doc)[key]
    if node not in doc["nodes"]:
        print(f"Unknown node '{node}'.")
        return 2
    if current["node"] == node:
        print(f"Shard {key} is served by {label(current)}: refusing to drop it.")
        return 2
    old = _target(doc, node, current["dbname"])
    if not _database_exists(old):
        print(f"{label(old)} does not exist, nothing to drop.")
        return 0
    with connect(old, "postgres", autocommit=True) as conn:
        sessions = conn.execute(
            "SELECT usename AS user, application_name, count(*) AS connections FROM pg_stat_activity "
            "WHERE datname = %s GROUP BY 1, 2 ORDER BY 1, 2",
            (old["dbname"],),
        ).fetchall()
        if sessions and not force:
            print(f"{label(old)} still has open connections:")
            print_table(["user", "application", "connections"],
                        [[s["user"], s["application_name"], s["connections"]] for s in sessions])
            print("An API instance has not reloaded the mapping yet: send any request to this shard,")
            print("wait for the next /health check (30 s) or use --force.")
            return 1
        conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(old["dbname"])))
    print(f"Dropped {label(old)}.")
    return 0
