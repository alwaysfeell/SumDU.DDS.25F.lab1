from tools.common import SHARD_KEYS, connect, label, print_table


def query_all(text: str, mapping: dict) -> int:
    headers, rows = None, []
    for key in SHARD_KEYS:
        with connect(mapping[key]) as conn:
            conn.read_only = True
            cur = conn.execute(text)
            if cur.description is None:
                continue
            headers = [d.name for d in cur.description]
            for record in cur.fetchall():
                rows.append([key, label(mapping[key]), *record.values()])
    if headers is None:
        print("The query returned no result set.")
        return 0
    print_table(["shard", "location", *headers], rows)
    print(f"({len(rows)} rows from {len(SHARD_KEYS)} databases)")
    return 0


def status(mapping: dict, version, source: str) -> int:
    rows, total_plans, total_locations = [], 0, 0
    for key in SHARD_KEYS:
        target = mapping[key]
        try:
            with connect(target) as conn:
                counts = conn.execute(
                    "SELECT (SELECT count(*) FROM travel_plans) AS plans, "
                    "(SELECT count(*) FROM locations) AS locations"
                ).fetchone()
            total_plans += counts["plans"]
            total_locations += counts["locations"]
            rows.append([key, target["node"], target["dbname"], f"{target['host']}:{target['port']}",
                         counts["plans"], counts["locations"], "ok"])
        except Exception as exc:
            rows.append([key, target["node"], target["dbname"], f"{target['host']}:{target['port']}",
                         "-", "-", "ERROR: " + str(exc).strip().splitlines()[0]])
    print(f"Mapping: {source}, version {version}")
    print_table(["shard", "node", "database", "address", "plans", "locations", "state"], rows)
    print(f"Total: {total_plans} plans, {total_locations} locations")
    return 0
