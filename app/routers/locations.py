from uuid import UUID

from fastapi import APIRouter, Response
from psycopg import sql

from app.database import pool
from app.errors import not_found, version_conflict
from app.schemas import LocationCreate, LocationUpdate
from app.utils import set_clause, to_json

router = APIRouter(tags=["Locations"])

LOCATION_COLUMNS = (
    "id, travel_plan_id, name, address, latitude, longitude, visit_order, "
    "arrival_date, departure_date, budget, notes, version, created_at, updated_at"
)


@router.post("/api/travel-plans/{plan_id}/locations", status_code=201)
def add_location(plan_id: UUID, body: LocationCreate):
    with pool.connection() as conn:
        plan = conn.execute(
            "SELECT id FROM travel_plans WHERE id = %s FOR UPDATE", (plan_id,)
        ).fetchone()
        if plan is None:
            raise not_found("Travel plan")

        row = conn.execute(
            f"""
            INSERT INTO locations (travel_plan_id, name, address, latitude, longitude,
                                   arrival_date, departure_date, budget, notes)
            VALUES (%(plan_id)s, %(name)s, %(address)s, %(latitude)s, %(longitude)s,
                    %(arrival_date)s, %(departure_date)s, %(budget)s, %(notes)s)
            RETURNING {LOCATION_COLUMNS}
            """,
            {**body.model_dump(), "plan_id": plan_id},
        ).fetchone()
    return to_json(row)


def _move_location(conn, location_id: UUID, plan_id: UUID, new_order: int, expected_version: int) -> None:
    conn.execute("SELECT 1 FROM travel_plans WHERE id = %s FOR UPDATE", (plan_id,))
    current = conn.execute(
        "SELECT visit_order, version FROM locations WHERE id = %s FOR UPDATE", (location_id,)
    ).fetchone()
    if current is None:
        raise not_found("Location")
    if current["version"] != expected_version:
        raise version_conflict("location", current["version"])

    old_order = current["visit_order"]
    if old_order == new_order:
        return
    occupant = conn.execute(
        "SELECT id FROM locations WHERE travel_plan_id = %s AND visit_order = %s",
        (plan_id, new_order),
    ).fetchone()
    if occupant is not None:
        conn.execute(
            """UPDATE locations SET visit_order =
                   (SELECT MAX(visit_order) + 1 FROM locations WHERE travel_plan_id = %s)
               WHERE id = %s""",
            (plan_id, location_id),
        )
        conn.execute(
            "UPDATE locations SET visit_order = %s, version = version + 1 WHERE id = %s",
            (old_order, occupant["id"]),
        )


@router.put("/api/locations/{location_id}")
def update_location(location_id: UUID, body: LocationUpdate):
    data = body.model_dump(exclude_unset=True, exclude={"version"})

    with pool.connection() as conn:
        location = conn.execute(
            "SELECT id, travel_plan_id FROM locations WHERE id = %s", (location_id,)
        ).fetchone()
        if location is None:
            raise not_found("Location")

        if "visit_order" in data:
            _move_location(conn, location_id, location["travel_plan_id"],
                           data["visit_order"], body.version)

        assignments = set_clause(data) + [sql.SQL("version = version + 1")]
        query = sql.SQL(
            "UPDATE locations SET {assignments} "
            "WHERE id = %(id)s AND version = %(expected_version)s "
            "RETURNING " + LOCATION_COLUMNS
        ).format(assignments=sql.SQL(", ").join(assignments))
        row = conn.execute(
            query, {**data, "id": location_id, "expected_version": body.version}
        ).fetchone()

        if row is None:
            current = conn.execute(
                "SELECT version FROM locations WHERE id = %s", (location_id,)
            ).fetchone()
            if current is None:
                raise not_found("Location")
            raise version_conflict("location", current["version"])
    return to_json(row)


@router.delete("/api/locations/{location_id}", status_code=204)
def delete_location(location_id: UUID):
    with pool.connection() as conn:
        deleted = conn.execute("DELETE FROM locations WHERE id = %s", (location_id,)).rowcount
    if deleted == 0:
        raise not_found("Location")
    return Response(status_code=204)
