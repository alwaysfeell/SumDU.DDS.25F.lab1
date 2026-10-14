import sys
from pathlib import Path

import psycopg

from app.config import DATABASE_URL

SCHEMA = Path(__file__).parent / "docs" / "schema.sql"


def main() -> None:
    reset = "--reset" in sys.argv
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        exists = conn.execute("SELECT to_regclass('public.travel_plans') IS NOT NULL").fetchone()[0]
        if exists and not reset:
            print("Таблиці вже існують. Щоб створити їх заново, запустіть: python init_db.py --reset")
            return
        if reset:
            conn.execute("DROP TABLE IF EXISTS locations, travel_plans CASCADE")
            print("Старі таблиці видалено.")
        conn.execute(SCHEMA.read_text(encoding="utf-8"))
        print("Готово: таблиці travel_plans і locations створено.")


if __name__ == "__main__":
    main()
