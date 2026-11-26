# System Overview



Build a Travel Planner REST API with PostgreSQL that handles concurrent editing of travel plans. Focus on ACID transactions and optimistic locking to prevent data conflicts.



## Core Entities

```

typescriptTravelPlan {
  id: UUID
  title: string
  description?: string
  start_date?: date
  end_date?: date
  budget?: decimal
  currency: string = 'USD'
  is_public: boolean = false
  version: integer = 1  // Optimistic locking
  created_at: timestamp
  updated_at: timestamp
}


Location {
  id: UUID
  travel_plan_id: UUID (FK)
  name: string
  address?: string
  latitude?: decimal
  longitude?: decimal
  visit_order: integer     // Auto-increment on insert
  arrival_date?: timestamp
  departure_date?: timestamp
  budget?: decimal
  notes?: text
  created_at: timestamp
}

```

## Critical API Endpoints

```

# Travel Plans
GET    /api/travel-plans                 # List with pagination
POST   /api/travel-plans                 # Create new plan
GET    /api/travel-plans/{id}            # Get plan with locations
PUT    /api/travel-plans/{id}            # Update with version check
DELETE /api/travel-plans/{id}            # Cascade delete

# Locations (always scoped to plan)
POST   /api/travel-plans/{id}/locations     # Add location (auto-order)
PUT    /api/locations/{id}                 # Update single location
DELETE /api/locations/{id}                 # Delete location

```

## Concurrency Patterns to Implement

* Optimistic Locking for travel\_plans using version field
* Auto-incrementing visit\_order for new locations
* Transaction Isolation for location updates
* Cascade Operations with proper foreign key constraints

## Database Design Requirements

* Use UUIDs for all primary keys
* Auto-assign visit\_order = MAX(visit\_order) + 1 for new locations
* Add proper indexes for query performance
* Implement check constraints for data validity
* Create triggers for auto-updating timestamp fields
* Foreign key constraints with CASCADE deletes

## Success Criteria
* Handle concurrent edits without lost updates
* Location addition works with auto-ordering
* Location updates are atomic and consistent
* All operations complete in <200ms
* Comprehensive test coverage with race condition scenarios



# Testing

```cmd

   hurl --test .\tests\ --variables-file .\tests\variables.properties
```



# Реалізація (Python + FastAPI + PostgreSQL)

## Стек
* **Python 3.11+**, **FastAPI** — веб-фреймворк, автоматична документація на `/docs`
* **Uvicorn** — ASGI-сервер
* **psycopg 3** (+ `psycopg_pool`) — драйвер PostgreSQL, «чистий» SQL з параметрами (без ORM)
* **Pydantic** — валідація вхідних даних
* **PostgreSQL 16/17**, **Hurl** — тести

## Структура
```
app/
  main.py             — створення FastAPI, підключення роутерів, заголовки безпеки
  config.py           — налаштування з .env
  shards.py           — маршрутизація запитів по 16 шардах, окремий пул з'єднань для кожного
  schemas.py          — Pydantic-моделі (валідація запитів)
  errors.py           — єдиний формат помилок, коди 400/404/409/500
  utils.py            — перетворення рядків БД у JSON, безпечна побудова SET
  routers/
    travel_plans.py   — /api/travel-plans (optimistic locking)
    locations.py      — локації (автонумерація з блокуванням плану)
    health.py         — /health
docs/                 — схема БД, Swagger
db/                   — міграції (db/migrations) і ініціалізація вузлів-шардів (db/shards)
shards/mapping.json   — шард → вузол і база даних
tests/                — Hurl-тести + concurrency_test.py (справжні паралельні запити)
run.py                — запуск сервера
```

## Запуск (Windows)
```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env        (і вписати пароль від PostgreSQL)
python run.py
```
Тести (в іншому терміналі):
```
hurl --test .\tests\ --variables-file .\tests\variables.properties
python tests\concurrency_test.py
```

## Виправлення в шаблоні
* `docs/schema.sql`: у функції `assign_location_order` було `$` замість `$$` — скрипт не виконувався.
* `docs/schema.sql`: `visit_order` отримав `NOT NULL` (як у `schema.mermeid`).
* Swagger: `ConflictResponse.required` містив `currentVersion`, а тести перевіряють `current_version`; адреса сервера 3000, а тести — 4567.

## Optimistic locking для локацій («І в раю муха сяде»)
Обрано варіант **(а)** — власна `version` у кожної локації.
* `docs/schema.sql` — у `locations` додано `version` та `updated_at` (+ тригер);
  для вже створеної бази — `docs/migrations/001_location_versioning.sql`.
* `PUT /api/locations/{id}` тепер вимагає `version`; застаріла версія → **409 Conflict** з `current_version`.
* При зміні `visit_order` (обмін місцями) версія підвищується в обох локацій.
* Тести: `management.hurl`, `validation.hurl` (поле `version`, нові тести 24a/24b),
  `race-conditions.hurl` (Strategy 4 — конфлікт оновлень локації, Strategy 5 — перестановка).
* Swagger: `version`/`updated_at` у `Location`, `version`/`visit_order` в `UpdateLocationRequest`,
  відповідь 409 для `PUT /api/locations/{id}`, виправлено `currentVersion` → `current_version`
  та адресу сервера (4567).

## Запуск у Docker
Потрібен Docker Desktop (Windows/macOS) або Docker Engine (Linux).
```
copy .env.example .env          (Linux/macOS: cp .env.example .env) і вписати POSTGRES_PASSWORD
docker compose up --build       API: http://localhost:4567/health, документація: http://localhost:4567/docs
```
Файли:
* `Dockerfile` — двоетапна збірка образу API (python:3.15-slim, користувач без root, read-only).
* `docker-compose.yml` — сервіси `web` (API) і `db` (PostgreSQL 18), мережа `backend`, том `pgdata`,
  healthcheck, обмеження ресурсів. Схема БД (`db/migrations/001_schema.sql`) виконується при першому запуску.
* `docker-compose.dev.yml` — для розробки: автоперезапуск при зміні коду, БД на `127.0.0.1:5433`:
  `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`.
* `.env.example` — зразок змінних оточення (`.env` з паролями — у `.gitignore`).
* `.dockerignore` — у образ потрапляють лише `app/`, `run.py`, `requirements.txt`.

Корисні команди:
```
docker compose ps               стан контейнерів
docker compose logs -f web      логи API
docker stats                    CPU / пам'ять контейнерів
docker compose down             зупинити (дані БД зберігаються)
docker compose down -v          зупинити і видалити дані БД
```
Тести продуктивності k6 проти контейнерів (з папки `tests/performance-tests`):
```
powershell -ExecutionPolicy Bypass -File .\run-docker.ps1 -Test load     (smoke | load | stress | spike | endurance)
```
Результати — у `tests/performance-tests/reports/docker` (baseline лаб. 2 — у `reports`).

## Шардування (лаб. 6)
Замість одного сервера PostgreSQL працюють 4 вузли, на кожному по 4 бази даних:

| Вузол | Контейнер | Бази даних |
|---|---|---|
| `postgres_00` | `traveler_postgres_00` | `db_0` … `db_3` |
| `postgres_01` | `traveler_postgres_01` | `db_4` … `db_7` |
| `postgres_02` | `traveler_postgres_02` | `db_8` … `db_b` |
| `postgres_03` | `traveler_postgres_03` | `db_c` … `db_f` |

* Шард визначається останнім символом UUID: план `…7` зберігається в `db_7`.
* `shards/mapping.json` — для кожного з 16 шардів вузол і назва БД; адреси вузлів — у розділі `nodes`.
  Логін і пароль однакові для всіх 16 БД і задаються лише в `.env` (`APP_DB_USER`, `APP_DB_PASSWORD`).
* UUID нового плану генерує застосунок (`uuid4`), а не БД, бо шард треба знати до INSERT.
* UUID локації генерується з тим самим останнім символом, що й у плану, тому локація лежить в одній БД
  з планом, а `PUT/DELETE /api/locations/{id}` маршрутизуються за id самої локації.
* `GET /api/travel-plans` опитує всі 16 БД паралельно і об'єднує результат за `updated_at`.
* `db/shards/010_init_shards.sh` при першому запуску вузла створює користувача застосунку (без SUPERUSER),
  бази зі змінної `SHARD_DATABASES`, права за замовчуванням і застосовує `db/migrations/*.sql` до кожної БД;
  `020_pg_hba.sh` дозволяє мережеві підключення лише з `samenet` через `scram-sha-256`.

Перший запуск (скрипти ініціалізації виконуються лише на порожніх томах):
```
docker compose down -v
docker compose up -d --build
docker compose ps
curl.exe http://127.0.0.1:4567/health
```
k6 з окремою папкою результатів: `.\run-docker.ps1 -Test load -ReportDir reports\sharding`.

### shardctl: SQL на всіх 16 БД
CLI-інструмент запускається в окремому контейнері `tools` (образ на основі `postgres:18-alpine` з Python, psycopg, `psql` і `pg_dump`),
який бачить вузли через мережу `backend` і читає `shards/mapping.json`:
```
docker compose run --rm tools apply tests/sharding/tool-check-ok.sql     DDL/DML на всіх 16 БД
docker compose run --rm tools query "SELECT count(*) FROM travel_plans"  read-only запит на всіх 16 БД
docker compose run --rm tools status                                     мапінг і кількість рядків у кожному шарді
docker compose run --rm tools pending                                    незавершені prepared-транзакції
```
`apply` відкриває з'єднання з кожною з 16 БД, починає транзакцію і виконує весь файл. Якщо хоч на одній БД сталася помилка,
транзакції відкочуються на всіх. Якщо файл виконався на всіх 16, застосовується двофазний commit:
спочатку `PREPARE TRANSACTION` на кожній БД, і лише після успіху на всіх — `COMMIT PREPARED`.
Для цього вузли запускаються з `max_prepared_transactions=32`. Файли з `BEGIN`/`COMMIT` інструмент не приймає,
а команди, які не можна виконувати в транзакції (`CREATE INDEX CONCURRENTLY`, `VACUUM`), завершаться помилкою і відкатом.
