from uuid import UUID

from fastapi import APIRouter, Response
from psycopg import sql

from app.errors import not_found, version_conflict
from app.routers.locations import LOCATION_COLUMNS
from app.schemas import TravelPlanCreate, TravelPlanUpdate
from app.shards import new_plan_id, shard_key, shards
from app.utils import set_clause, to_json

router = APIRouter(prefix="/api/travel-plans", tags=["Travel Plans"])

PLAN_COLUMNS = (
    "id, title, description, start_date, end_date, budget, currency, "
    "is_public, version, created_at, updated_at"
)


@router.get("")
def list_travel_plans():
    def work(conn):
        return conn.execute(
            f"""
            SELECT {PLAN_COLUMNS},
                   (SELECT COUNT(*) FROM locations l WHERE l.travel_plan_id = p.id) AS location_count
            FROM travel_plans p
            """
        ).fetchall()

    rows = [row for part in shards.run_all(work).values() for row in part]
    rows.sort(key=lambda r: r["updated_at"], reverse=True)
    return [to_json(r) for r in rows]


@router.post("", status_code=201)
def create_travel_plan(body: TravelPlanCreate):
    plan_id = new_plan_id()
    data = {**body.model_dump(), "id": plan_id}

    def work(conn):
        return conn.execute(
            f"""
            INSERT INTO travel_plans (id, title, description, start_date, end_date, budget, currency, is_public)
            VALUES (%(id)s, %(title)s, %(description)s, %(start_date)s, %(end_date)s, %(budget)s, %(currency)s, %(is_public)s)
            RETURNING {PLAN_COLUMNS}
            """,
            data,
        ).fetchone()

    return to_json(shards.run(shard_key(plan_id), work))


@router.get("/{plan_id}")
def get_travel_plan(plan_id: UUID):
    def work(conn):
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        plan = conn.execute(
            f"SELECT {PLAN_COLUMNS} FROM travel_plans WHERE id = %s", (plan_id,)
        ).fetchone()
        if plan is None:
            raise not_found("Travel plan")
        locations = conn.execute(
            f"SELECT {LOCATION_COLUMNS} FROM locations WHERE travel_plan_id = %s ORDER BY visit_order",
            (plan_id,),
        ).fetchall()
        return plan, locations

    plan, locations = shards.run(shard_key(plan_id), work)
    result = to_json(plan)
    result["locations"] = [to_json(loc) for loc in locations]
    return result


@router.put("/{plan_id}")
def update_travel_plan(plan_id: UUID, body: TravelPlanUpdate):
    data = body.model_dump(exclude_unset=True, exclude={"version"})
    assignments = set_clause(data) + [sql.SQL("version = version + 1")]

    query = sql.SQL(
        "UPDATE travel_plans SET {assignments} "
        "WHERE id = %(id)s AND version = %(expected_version)s "
        "RETURNING " + PLAN_COLUMNS
    ).format(assignments=sql.SQL(", ").join(assignments))

    def work(conn):
        row = conn.execute(
            query, {**data, "id": plan_id, "expected_version": body.version}
        ).fetchone()

        if row is None:
            current = conn.execute(
                "SELECT version FROM travel_plans WHERE id = %s", (plan_id,)
            ).fetchone()
            if current is None:
                raise not_found("Travel plan")
            raise version_conflict("travel plan", current["version"])
        return row

    return to_json(shards.run(shard_key(plan_id), work))


@router.delete("/{plan_id}", status_code=204)
def delete_travel_plan(plan_id: UUID):
    def work(conn):
        return conn.execute("DELETE FROM travel_plans WHERE id = %s", (plan_id,)).rowcount

    if shards.run(shard_key(plan_id), work) == 0:
        raise not_found("Travel plan")
    return Response(status_code=204)
