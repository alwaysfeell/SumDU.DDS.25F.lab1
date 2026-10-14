from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import DATABASE_URL, DB_POOL_MAX, DB_POOL_MIN

pool = ConnectionPool(
    conninfo=DATABASE_URL,
    min_size=DB_POOL_MIN,
    max_size=DB_POOL_MAX,
    kwargs={"row_factory": dict_row},
    open=False,
)
