import argparse
import sys

from tools.apply import apply_file, pending
from tools.common import load_doc, resolve
from tools.overview import query_all, status


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
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
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
