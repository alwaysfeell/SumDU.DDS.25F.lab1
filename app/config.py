import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "4567"))

SHARD_MAPPING = os.getenv(
    "SHARD_MAPPING", str(Path(__file__).resolve().parent.parent / "shards" / "mapping.json")
)
APP_DB_USER = os.getenv("APP_DB_USER", "traveler_app")
APP_DB_PASSWORD = os.getenv("APP_DB_PASSWORD", "")

SHARD_POOL_MIN = int(os.getenv("SHARD_POOL_MIN", "1"))
SHARD_POOL_MAX = int(os.getenv("SHARD_POOL_MAX", "10"))
