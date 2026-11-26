import os
import time

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from tools.common import SHARD_KEYS, admin_conninfo, load_doc, print_table, resolve

REGISTRY_DB = os.getenv("SHARD_REGISTRY_DB", "shard_registry")
PUBLICATION = "shard_registry_pub"

TABLE_DDL = """
CREATE TABLE IF NOT EXISTS shard_map (
    shard CHAR(1) PRIMARY KEY,
    node TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    dbname TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""


def registry_hosts() -> list[str]:
    return [h.strip() for h in os.getenv("SHARD_REGISTRY", "").split(",") if h.strip()]


def _address(address: str) -> tuple[str, int]:
    host, _, port = address.partition(":")
    return host, int(port or 5432)


def _connect(address: str, dbname: str = REGISTRY_DB, autocommit: bool = True) -> psycopg.Connection:
    host, port = _address(address)
    return psycopg.connect(admin_conninfo(host, port, dbname), autocommit=autocommit, row_factory=dict_row)


def _read(address: str) -> dict:
    with _connect(address) as conn:
        rows = conn.execute("SELECT shard, node, dbname, version FROM shard_map ORDER BY shard").fetchall()
    return {r["shard"]: r for r in rows}


class RegistryStore:
    def __init__(self, hosts: list[str]):
        self.hosts = hosts
        self.primary = hosts[0]
        self.replicas = hosts[1:]
        self.name = f"shard registry ({REGISTRY_DB}.shard_map on {self.primary}, replicated to {len(self.replicas)} nodes)"

    def load(self) -> dict:
        doc = load_doc()
        errors = []
        for address in self.hosts:
            try:
                rows = _read(address)
            except psycopg.Error as exc:
                errors.append(f"{address}: {exc}")
                continue
            if len(rows) != len(SHARD_KEYS):
                errors.append(f"{address}: {len(rows)} rows in shard_map")
                continue
            doc["shards"] = {k: {"node": rows[k]["node"], "dbname": rows[k]["dbname"]} for k in SHARD_KEYS}
            doc["version"] = max(r["version"] for r in rows.values())
            return doc
        raise RuntimeError("shard registry is not available: " + "; ".join(errors))

    def move_shard(self, key: str, node: str) -> int:
        info = load_doc()["nodes"][node]
        with _connect(self.primary) as conn:
            version = conn.execute(
                "UPDATE shard_map SET node = %s, host = %s, port = %s, version = version + 1, updated_at = now() "
                "WHERE shard = %s RETURNING version",
                (node, info["host"], int(info["port"]), key),
            ).fetchone()["version"]
        self.wait_replicas(key, version)
        return version

    def wait_replicas(self, key: str, version: int, timeout: float = 30) -> None:
        started = time.perf_counter()
        deadline = time.monotonic() + timeout
        pending = list(self.replicas)
        while pending:
            for address in list(pending):
                try:
                    with _connect(address) as conn:
                        row = conn.execute("SELECT version FROM shard_map WHERE shard = %s", (key,)).fetchone()
                    if row and row["version"] >= version:
                        pending.remove(address)
                except psycopg.Error:
                    pass
            if pending and time.monotonic() > deadline:
                raise TimeoutError("registry replicas did not receive the change: " + ", ".join(pending))
            if pending:
                time.sleep(0.1)
        print(f"      registry replicated to {len(self.replicas)} nodes in "
              f"{(time.perf_counter() - started) * 1000:.0f} ms", flush=True)


def init(hosts: list[str]) -> int:
    if len(hosts) < 2:
        print("Set SHARD_REGISTRY to at least two nodes, e.g. postgres_00,postgres_01,postgres_02,postgres_03")
        return 2
    app_user = os.environ.get("APP_DB_USER", "traveler_app")
    doc = load_doc()
    mapping = resolve(doc)
    primary, replicas = hosts[0], hosts[1:]

    for address in hosts:
        with _connect(address, "postgres") as conn:
            if conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (REGISTRY_DB,)).fetchone() is None:
                conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(REGISTRY_DB)))
                print(f"{address}: created database {REGISTRY_DB}")
        with _connect(address) as conn:
            conn.execute(TABLE_DDL)
            conn.execute(sql.SQL("GRANT SELECT ON shard_map TO {}").format(sql.Identifier(app_user)))

    with _connect(primary) as conn:
        with conn.transaction():
            for key in SHARD_KEYS:
                t = mapping[key]
                conn.execute(
                    "INSERT INTO shard_map (shard, node, host, port, dbname, version) VALUES (%s, %s, %s, %s, %s, %s) "
                    "ON CONFLICT (shard) DO NOTHING",
                    (key, t["node"], t["host"], t["port"], t["dbname"], int(doc.get("version", 1))),
                )
        if conn.execute("SELECT 1 FROM pg_publication WHERE pubname = %s", (PUBLICATION,)).fetchone() is None:
            conn.execute(sql.SQL("CREATE PUBLICATION {} FOR TABLE shard_map").format(sql.Identifier(PUBLICATION)))
        print(f"{primary}: registry primary, seeded from {os.getenv('SHARD_MAPPING', 'shards/mapping.json')}, "
              f"publication {PUBLICATION}")

    host, port = _address(primary)
    primary_conninfo = make_conninfo(host=host, port=port, dbname=REGISTRY_DB,
                                     user=os.environ["POSTGRES_USER"], password=os.environ["POSTGRES_PASSWORD"])
    for index, address in enumerate(replicas, start=1):
        name = f"shard_registry_sub_{index}"
        with _connect(address) as conn:
            if conn.execute("SELECT 1 FROM pg_subscription WHERE subname = %s", (name,)).fetchone() is None:
                conn.execute("TRUNCATE shard_map")
                conn.execute(
                    sql.SQL("CREATE SUBSCRIPTION {} CONNECTION {} PUBLICATION {} WITH (copy_data = true)").format(
                        sql.Identifier(name), sql.Literal(primary_conninfo), sql.Identifier(PUBLICATION)
                    )
                )
                print(f"{address}: registry replica, subscription {name}")
            else:
                print(f"{address}: registry replica, subscription {name} already exists")

    deadline = time.monotonic() + 60
    expected = _read(primary)
    while time.monotonic() < deadline:
        try:
            if all(_read(a) == expected for a in replicas):
                break
        except psycopg.Error:
            pass
        time.sleep(0.5)
    print()
    return show(hosts)


def show(hosts: list[str]) -> int:
    if not hosts:
        print("SHARD_REGISTRY is not set: the API reads shards/mapping.json.")
        return 2
    data = {}
    for address in hosts:
        try:
            data[address] = _read(address)
        except psycopg.Error as exc:
            data[address] = None
            print(f"{address}: unavailable ({str(exc).strip().splitlines()[0]})")
    rows = []
    for key in SHARD_KEYS:
        row = [key]
        for address in hosts:
            entry = (data[address] or {}).get(key)
            row.append(f"{entry['node']}/{entry['dbname']} v{entry['version']}" if entry else "-")
        rows.append(row)
    headers = ["shard"] + [f"{a}{' (primary)' if i == 0 else ''}" for i, a in enumerate(hosts)]
    print_table(headers, rows)
    available = [d for d in data.values() if d is not None]
    same = len(available) == len(hosts) and all(d == available[0] for d in available)
    print(f"Registry copies identical on all {len(hosts)} nodes: {'yes' if same else 'NO'}")
    return 0 if same else 1
