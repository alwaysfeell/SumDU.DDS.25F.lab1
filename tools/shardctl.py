import argparse
import sys

from tools.apply import apply_file, pending
from tools.common import FileStore, load_doc, resolve, shard_arg
from tools.overview import query_all, status
from tools.rebalance import drop_old, move


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="shardctl", description="TravelerAPI shard management")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("apply", help="run a DDL/DML file on all 16 databases in one two-phase transaction")
    p.add_argument("file")

    p = sub.add_parser("query", help="run a read-only query on all 16 databases")
    p.add_argument("sql")

    sub.add_parser("status", help="show the mapping and row counts of every shard")

    p = sub.add_parser("pending", help="list prepared transactions left by shardctl apply")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--commit", action="store_true")
    group.add_argument("--rollback", action="store_true")

    p = sub.add_parser("move", help="move a shard database to another node with logical replication")
    p.add_argument("shard", type=shard_arg, help="0..f or db_0..db_f")
    p.add_argument("--to", required=True, dest="node", help="target node, e.g. postgres_00")
    p.add_argument("--sync-timeout", type=float, default=300)
    p.add_argument("--lock-timeout", type=int, default=10)

    p = sub.add_parser("drop-old", help="drop the old copy of a moved shard")
    p.add_argument("shard", type=shard_arg)
    p.add_argument("--node", required=True)
    p.add_argument("--force", action="store_true")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    store = FileStore()
    if args.command == "move":
        return move(args.shard, args.node, store, args.sync_timeout, args.lock_timeout)
    if args.command == "drop-old":
        return drop_old(args.shard, args.node, store, args.force)
    doc = load_doc()
    mapping = resolve(doc)
    if args.command == "apply":
        return apply_file(args.file, mapping)
    if args.command == "query":
        return query_all(args.sql, mapping)
    if args.command == "status":
        return status(mapping, doc.get("version"))
    if args.command == "pending":
        action = "commit" if args.commit else "rollback" if args.rollback else None
        return pending(mapping, action)
    return 2


if __name__ == "__main__":
    sys.exit(main())
