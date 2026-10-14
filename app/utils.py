from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from psycopg import sql


def to_json(row: dict | None) -> dict | None:
    if row is None:
        return None
    out = {}
    for key, value in row.items():
        if isinstance(value, Decimal):
            out[key] = float(value)
        elif isinstance(value, (datetime, date)):
            out[key] = value.isoformat()
        elif isinstance(value, UUID):
            out[key] = str(value)
        else:
            out[key] = value
    return out


def set_clause(data: dict) -> list[sql.Composable]:
    return [
        sql.SQL("{} = {}").format(sql.Identifier(column), sql.Placeholder(column))
        for column in data
    ]
