import logging
from datetime import datetime, timezone

import psycopg.errors as pg_errors
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("traveler")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class APIError(Exception):

    def __init__(self, status_code: int, error: str, **extra):
        self.status_code = status_code
        self.error = error
        self.extra = extra


def not_found(what: str) -> APIError:
    return APIError(404, f"{what} not found")


def version_conflict(what: str, current_version: int) -> APIError:
    return APIError(
        409,
        f"Conflict: {what} was modified by another user",
        current_version=current_version,
        message=(
            "Resource has been modified since you read it. "
            "Reload it (GET), apply your changes again and send the new version."
        ),
    )


def _body(error: str, **extra) -> dict:
    return {"error": error, **extra, "timestamp": _now()}


def _format_validation_errors(exc: RequestValidationError) -> list[str]:
    details = []
    for err in exc.errors():
        if err.get("type") == "json_invalid":
            details.append("Malformed JSON in request body")
            continue
        loc = ".".join(str(p) for p in err.get("loc", []) if p not in ("body", "path", "query"))
        msg = err.get("msg", "invalid value").removeprefix("Value error, ")
        details.append(f"{loc}: {msg}" if loc else msg)
    return details


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(APIError)
    async def api_error_handler(_: Request, exc: APIError):
        return JSONResponse(status_code=exc.status_code, content=_body(exc.error, **exc.extra))

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError):
        details = _format_validation_errors(exc)
        return JSONResponse(
            status_code=400,
            content=_body("Validation error: " + "; ".join(details), details=details),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(_: Request, exc: StarletteHTTPException):
        messages = {404: "Resource not found", 405: "Method not allowed"}
        return JSONResponse(
            status_code=exc.status_code,
            content=_body(messages.get(exc.status_code, str(exc.detail))),
        )

    @app.exception_handler(pg_errors.IntegrityError)
    async def integrity_handler(_: Request, exc: pg_errors.IntegrityError):
        if isinstance(exc, pg_errors.UniqueViolation):
            return JSONResponse(
                status_code=409,
                content=_body("Conflict: unique constraint violated", details=[exc.diag.constraint_name or ""]),
            )
        if isinstance(exc, pg_errors.ForeignKeyViolation):
            return JSONResponse(status_code=404, content=_body("Travel plan not found"))
        return JSONResponse(
            status_code=400,
            content=_body("Validation error: database constraint violated",
                          details=[exc.diag.constraint_name or exc.diag.message_primary or ""]),
        )

    @app.exception_handler(pg_errors.DataError)
    async def data_error_handler(_: Request, exc: pg_errors.DataError):
        return JSONResponse(
            status_code=400,
            content=_body("Validation error: invalid data", details=[exc.diag.message_primary or ""]),
        )

    @app.exception_handler(Exception)
    async def unhandled_handler(_: Request, exc: Exception):
        log.exception("Unhandled error: %s", exc)
        return JSONResponse(status_code=500, content=_body("Internal server error"))
