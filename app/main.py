import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request

from app.database import pool
from app.errors import register_error_handlers
from app.routers import health, locations, travel_plans

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    pool.open()
    yield
    pool.close()


app = FastAPI(
    title="TravelerAPI",
    description="REST API для колаборативного планування подорожей (PostgreSQL, optimistic locking)",
    version="1.0.0",
    lifespan=lifespan,
)

register_error_handlers(app)
app.include_router(travel_plans.router)
app.include_router(locations.router)
app.include_router(health.router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    if not request.url.path.startswith(("/docs", "/redoc", "/openapi.json")):
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    return response
