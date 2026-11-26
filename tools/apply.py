import re
import time
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.pq import TransactionStatus

from tools.common import SHARD_KEYS, connect, label, print_table

NOT_CODE = re.compile(r"\$(\w*)\$.*?\$\1\$|'(?:[^']|'')*'|--[^\n]*|/\*.*?\*/", re.S)
TX_CONTROL = re.compile(
    r"^\s*(?:"
    r"(?:begin|start\s+transaction)(?:\s+(?:work|transaction|isolation[^;]*|read[^;]*))?\s*;"
    r"|(?:commit|rollback|abort)(?:\s+(?:work|transaction|and\s+(?:no\s+)?chain))?\s*;"
    r"|prepare\s+transaction|commit\s+prepared|rollback\s+prepared"
    r")",
    re.I | re.M,
)


def find_tx_control(script: str) -> str | None:
    match = TX_CONTROL.search(NOT_CODE.sub(" ", script))
    return match.group(0).strip() if match else None


def _first_line(exc: Exception) -> str:
    return (str(exc).strip().splitlines() or [type(exc).__name__])[0]


def apply_file(path: str, mapping: dict) -> int:
    script = Path(path).read_text(encoding="utf-8-sig")
    statement = find_tx_control(script)
    if statement:
        print(f"Refusing to run {path}: it contains transaction control ({statement}).")
        print("shardctl wraps the whole file in one transaction per database, remove BEGIN/COMMIT/ROLLBACK.")
        return 2

    gid_prefix = "shardctl_" + datetime.now().strftime("%Y%m%d_%H%M%S")
    print(f"File: {path}")
    print(f"Transaction ids: {gid_prefix}_<database>")
    print()

    conns: dict[str, psycopg.Connection] = {}
    try:
        for key in SHARD_KEYS:
            conns[key] = connect(mapping[key])
    except psycopg.Error as exc:
        for conn in conns.values():
            conn.close()
        print(f"Cannot connect to {label(mapping[key])}: {_first_line(exc)}")
        print("Nothing was executed.")
        return 1

    result = {key: ["-", "skipped"] for key in SHARD_KEYS}
    begun, prepared = [], []
    failed = None
    try:
        for key in SHARD_KEYS:
            conn = conns[key]
            started = time.perf_counter()
            try:
                conn.tpc_begin(f"{gid_prefix}_{mapping[key]['dbname']}")
                begun.append(key)
                conn.execute(script)
                if conn.info.transaction_status != TransactionStatus.INTRANS:
                    raise RuntimeError("the script ended the transaction itself")
                result[key] = [f"ok, {(time.perf_counter() - started) * 1000:.1f} ms", "executed"]
            except Exception as exc:
                result[key] = ["FAILED", _first_line(exc)]
                failed = key
                break

        if failed is None:
            for key in SHARD_KEYS:
                try:
                    conns[key].tpc_prepare()
                    prepared.append(key)
                    result[key][1] = "prepared"
                except Exception as exc:
                    result[key] = [result[key][0], "PREPARE FAILED: " + _first_line(exc)]
                    failed = key
                    break

        if failed is not None:
            for key in begun:
                try:
                    conns[key].tpc_rollback()
                    if result[key][1] in ("executed", "prepared"):
                        result[key][1] = "rolled back"
                except Exception:
                    pass
            print_table(["shard", "location", "execute", "result"],
                        [[k, label(mapping[k]), *result[k]] for k in SHARD_KEYS])
            print()
            print(f"Error on shard {failed} ({label(mapping[failed])}).")
            print(f"ROLLBACK on all {len(begun)} started transactions: nothing was committed.")
            return 1

        print(f"Phase 1 PREPARE TRANSACTION: {len(prepared)}/{len(SHARD_KEYS)} ok")
        committed, pending = [], []
        for key in SHARD_KEYS:
            try:
                conns[key].tpc_commit()
                committed.append(key)
                result[key][1] = "committed"
            except Exception as exc:
                pending.append(key)
                result[key][1] = "COMMIT PREPARED FAILED: " + _first_line(exc)
        print(f"Phase 2 COMMIT PREPARED:     {len(committed)}/{len(SHARD_KEYS)} ok")
        print()
        print_table(["shard", "location", "execute", "result"],
                    [[k, label(mapping[k]), *result[k]] for k in SHARD_KEYS])
        print()
        if pending:
            print(f"{len(pending)} prepared transactions are still pending: {', '.join(pending)}.")
            print("They survive restarts. Finish them with: shardctl pending --commit")
            return 1
        print(f"Committed on all {len(SHARD_KEYS)} databases.")
        return 0
    finally:
        for conn in conns.values():
            conn.close()


def pending(mapping: dict, action: str | None) -> int:
    rows = []
    for key in SHARD_KEYS:
        with connect(mapping[key], autocommit=True) as conn:
            xacts = conn.execute(
                "SELECT gid, prepared FROM pg_prepared_xacts "
                "WHERE database = current_database() AND gid LIKE 'shardctl\\_%' ORDER BY gid"
            ).fetchall()
            for x in xacts:
                state = "pending"
                if action:
                    command = "COMMIT PREPARED {}" if action == "commit" else "ROLLBACK PREPARED {}"
                    conn.execute(sql.SQL(command).format(sql.Literal(x["gid"])))
                    state = "committed" if action == "commit" else "rolled back"
                rows.append([key, label(mapping[key]), x["gid"], x["prepared"].strftime("%Y-%m-%d %H:%M:%S"), state])
    if not rows:
        print("No pending shardctl transactions.")
        return 0
    print_table(["shard", "location", "gid", "prepared at", "state"], rows)
    return 0
