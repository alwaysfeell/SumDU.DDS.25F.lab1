import time
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.shards import SHARD_KEYS, shards

router = APIRouter(tags=["Health"])
STARTED_AT = time.monotonic()


def _probe(conn) -> None:
    conn.execute("SELECT 1 FROM travel_plans LIMIT 1")


def _check_shard(key: str) -> dict:
    started = time.perf_counter()
    try:
        shards.run(key, _probe, timeout=2)
        status = "healthy"
    except Exception:
        status = "unhealthy"
    return {
        "location": shards.describe(key),
        "status": status,
        "responseTime": round((time.perf_counter() - started) * 1000, 2),
    }


@router.get("/health")
def health():
    started = time.perf_counter()
    futures = {key: shards.submit(_check_shard, key) for key in SHARD_KEYS}
    checks = {key: future.result() for key, future in futures.items()}
    healthy = sum(1 for c in checks.values() if c["status"] == "healthy")
    db_status = "healthy" if healthy == len(SHARD_KEYS) else "unhealthy"

    body = {
        "status": db_status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "uptime": round((time.monotonic() - STARTED_AT) * 1000),
        "database": {
            "status": db_status,
            "responseTime": round((time.perf_counter() - started) * 1000, 2),
            "healthyShards": f"{healthy}/{len(SHARD_KEYS)}",
        },
        "shards": checks,
    }
    return JSONResponse(status_code=200 if db_status == "healthy" else 503, content=body)
