import json
import os
import tempfile
from pathlib import Path

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

SHARD_KEYS = tuple("0123456789abcdef")


def mapping_path() -> Path:
    return Path(os.getenv("SHARD_MAPPING", "shards/mapping.json"))


def load_doc(path: Path | None = None) -> dict:
    return json.loads((path or mapping_path()).read_text(encoding="utf-8"))


def save_doc(doc: dict, path: Path | None = None) -> None:
    path = path or mapping_path()
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".mapping-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(doc, indent=2) + "\n")
    try:
        os.chmod(tmp, 0o644)
    except OSError:
        pass
    os.replace(tmp, path)


def resolve(doc: dict) -> dict:
    nodes = doc["nodes"]
    result = {}
    for key in SHARD_KEYS:
        entry = doc["shards"][key]
        node = nodes[entry["node"]]
        result[key] = {
            "node": entry["node"],
            "host": node["host"],
            "port": int(node["port"]),
            "dbname": entry["dbname"],
        }
    return result


def load_mapping() -> dict:
    return resolve(load_doc())


def shard_arg(value: str) -> str:
    key = value.lower().removeprefix("db_")
    if key not in SHARD_KEYS:
        raise ValueError(f"unknown shard '{value}', expected 0..f or db_0..db_f")
    return key


def admin_conninfo(host: str, port: int, dbname: str) -> str:
    return make_conninfo(
        host=host,
        port=port,
        dbname=dbname,
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        application_name="shardctl",
        connect_timeout=5,
    )


def connect(target: dict, dbname: str | None = None, autocommit: bool = False) -> psycopg.Connection:
    return psycopg.connect(
        admin_conninfo(target["host"], target["port"], dbname or target["dbname"]),
        autocommit=autocommit,
        row_factory=dict_row,
    )


def label(target: dict) -> str:
    return f"{target['node']}/{target['dbname']}"


def print_table(headers: list[str], rows: list[list]) -> None:
    cells = [[str(h) for h in headers]] + [[("" if v is None else str(v)) for v in row] for row in rows]
    widths = [max(len(r[i]) for r in cells) for i in range(len(headers))]
    line = "  ".join("-" * w for w in widths)
    print("  ".join(h.ljust(w) for h, w in zip(cells[0], widths)))
    print(line)
    for row in cells[1:]:
        print("  ".join(v.ljust(w) for v, w in zip(row, widths)))


class FileStore:
    name = "mapping file"

    def __init__(self):
        self.name = f"mapping file {mapping_path()}"

    def load(self) -> dict:
        return load_doc()

    def move_shard(self, key: str, node: str) -> int:
        doc = load_doc()
        doc["shards"][key]["node"] = node
        doc["version"] = int(doc.get("version", 0)) + 1
        save_doc(doc)
        return doc["version"]
