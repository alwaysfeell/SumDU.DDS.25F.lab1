import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request

from app import metrics
from app.errors import register_error_handlers
from app.routers import health, locations, travel_plans
from app.routers import metrics as metrics_router
from app.shards import SHARD_KEYS, shards

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    shards.open()
    metrics.init_shard_series(SHARD_KEYS)
    metrics.register_pool_collector(shards)
    yield
    shards.close()


app = FastAPI(
    title="TravelerAPI",
    description="REST API для колаборативного планування подорожей (PostgreSQL, 16 шардів, optimistic locking)",
    version="1.0.0",
    lifespan=lifespan,
)

register_error_handlers(app)
app.include_router(travel_plans.router)
app.include_router(locations.router)
app.include_router(health.router)
app.include_router(metrics_router.router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    if not request.url.path.startswith(("/docs", "/redoc", "/openapi.json")):
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    return response


@app.middleware("http")
async def prometheus_metrics(request: Request, call_next):
    return await metrics.track_request(request, call_next)
