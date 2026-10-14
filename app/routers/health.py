import time
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.database import pool

router = APIRouter(tags=["Health"])
STARTED_AT = time.monotonic()


@router.get("/health")
def health():
    started = time.perf_counter()
    try:
        with pool.connection(timeout=2) as conn:
            conn.execute("SELECT 1")
        db_status = "healthy"
    except Exception:
        db_status = "unhealthy"
    db_ms = round((time.perf_counter() - started) * 1000, 2)

    body = {
        "status": db_status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "uptime": round((time.monotonic() - STARTED_AT) * 1000),
        "database": {"status": db_status, "responseTime": db_ms},
    }
    return JSONResponse(status_code=200 if db_status == "healthy" else 503, content=body)
