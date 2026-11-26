import json
import logging
import random
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
from psycopg import errors as pg_errors
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolClosed

from app.config import (
    APP_DB_PASSWORD,
    APP_DB_USER,
    SHARD_MAPPING,
    SHARD_POOL_MAX,
    SHARD_POOL_MIN,
    SHARD_REGISTRY,
    SHARD_REGISTRY_DB,
)

log = logging.getLogger("traveler.shards")

SHARD_KEYS = tuple("0123456789abcdef")
RELOAD_ERRORS = (pg_errors.InsufficientPrivilege, PoolClosed)


def shard_key(entity_id) -> str:
    return str(entity_id)[-1].lower()


def new_plan_id() -> UUID:
    return uuid4()


def new_location_id(plan_id) -> UUID:
    return UUID(uuid4().hex[:-1] + shard_key(plan_id))


def load_mapping_file(path: str = SHARD_MAPPING) -> dict:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    nodes = doc["nodes"]
    shards = doc["shards"]
    missing = [key for key in SHARD_KEYS if key not in shards]
    if missing:
        raise ValueError(f"{path}: no entries for shards {', '.join(missing)}")
    mapping = {}
    for key in SHARD_KEYS:
        node = shards[key]["node"]
        mapping[key] = {
            "node": node,
            "host": nodes[node]["host"],
            "port": int(nodes[node]["port"]),
            "dbname": shards[key]["dbname"],
        }
    return mapping


def _split_address(address: str) -> tuple[str, int]:
    host, _, port = address.partition(":")
    return host, int(port or 5432)


def load_mapping_registry(hosts: list[str] = SHARD_REGISTRY) -> dict:
    errors = []
    for address in random.sample(hosts, len(hosts)):
        host, port = _split_address(address)
        try:
            with psycopg.connect(host=host, port=port, dbname=SHARD_REGISTRY_DB, user=APP_DB_USER,
                                 password=APP_DB_PASSWORD, connect_timeout=3,
                                 application_name="traveler-api-registry", row_factory=dict_row) as conn:
                rows = conn.execute("SELECT shard, node, host, port, dbname FROM shard_map").fetchall()
        except psycopg.Error as exc:
            errors.append(f"{address}: {str(exc).strip().splitlines()[0]}")
            continue
        mapping = {r["shard"]: {"node": r["node"], "host": r["host"], "port": int(r["port"]),
                                "dbname": r["dbname"]} for r in rows}
        missing = [key for key in SHARD_KEYS if key not in mapping]
        if missing:
            errors.append(f"{address}: no entries for shards {', '.join(missing)}")
            continue
        log.info("Shard mapping read from registry %s", address)
        return {key: mapping[key] for key in SHARD_KEYS}
    raise RuntimeError("Shard registry is not available: " + "; ".join(errors))


class ShardRouter:
    def __init__(self, loader):
        self._loader = loader
        self._lock = threading.Lock()
        self._targets: dict[str, dict] = {}
        self._pools: dict[str, ConnectionPool] = {}
        self._executor = ThreadPoolExecutor(max_workers=len(SHARD_KEYS) * 2, thread_name_prefix="shard")

    def open(self) -> None:
        self.reload()
        source = f"registry {','.join(SHARD_REGISTRY)}" if SHARD_REGISTRY else SHARD_MAPPING
        log.info("Shard mapping loaded from %s: %s", source,
                 ", ".join(f"{k}={self.describe(k)}" for k in SHARD_KEYS))

    def close(self) -> None:
        with self._lock:
            pools = list(self._pools.values())
            self._pools = {}
        for pool in pools:
            pool.close()
        self._executor.shutdown(wait=False)

    def reload(self) -> None:
        mapping = self._loader()
        stale = []
        with self._lock:
            pools = {}
            for key, target in mapping.items():
                current = self._pools.get(key)
                if current is not None and self._targets.get(key) == target:
                    pools[key] = current
                    continue
                pools[key] = self._new_pool(key, target)
                if current is not None:
                    stale.append(current)
                    log.warning("Shard %s moved: %s -> %s", key,
                                self._label(self._targets[key]), self._label(target))
            self._pools = pools
            self._targets = dict(mapping)
        for pool in stale:
            pool.close(timeout=1)

    @staticmethod
    def _label(target: dict) -> str:
        return f"{target['node']}/{target['dbname']}"

    @staticmethod
    def _new_pool(key: str, target: dict) -> ConnectionPool:
        conninfo = make_conninfo(
            host=target["host"],
            port=target["port"],
            dbname=target["dbname"],
            user=APP_DB_USER,
            password=APP_DB_PASSWORD,
            application_name=f"traveler-api-shard-{key}",
        )
        return ConnectionPool(
            conninfo=conninfo,
            min_size=SHARD_POOL_MIN,
            max_size=SHARD_POOL_MAX,
            kwargs={"row_factory": dict_row},
            name=f"shard-{key}",
            open=True,
        )

    def describe(self, key: str) -> str:
        with self._lock:
            return self._label(self._targets[key])

    def pool(self, key: str) -> ConnectionPool:
        with self._lock:
            return self._pools[key]

    def run(self, key: str, work, timeout: float | None = None):
        try:
            return self._run_once(key, work, timeout)
        except RELOAD_ERRORS as exc:
            log.warning("Shard %s (%s): %s, reloading shard mapping",
                        key, self.describe(key), str(exc).strip().splitlines()[0])
            self.reload()
            return self._run_once(key, work, timeout)

    def _run_once(self, key: str, work, timeout: float | None):
        with self.pool(key).connection(timeout=timeout) as conn:
            return work(conn)

    def submit(self, fn, *args):
        return self._executor.submit(fn, *args)

    def run_all(self, work) -> dict:
        futures = {key: self.submit(self.run, key, work) for key in SHARD_KEYS}
        return {key: future.result() for key, future in futures.items()}


shards = ShardRouter(load_mapping_registry if SHARD_REGISTRY else load_mapping_file)
