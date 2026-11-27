import threading
import time

from prometheus_client import Counter, Gauge, Histogram, disable_created_metrics
from prometheus_client.core import REGISTRY, GaugeMetricFamily

HTTP_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0)
SHARD_BUCKETS = (0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0)
EXCLUDED_PATHS = {"/metrics"}

disable_created_metrics()

HTTP_REQUESTS = Counter(
    "traveler_http_requests_total",
    "HTTP requests handled by the API",
    ["method", "route", "status"],
)
HTTP_DURATION = Histogram(
    "traveler_http_request_duration_seconds",
    "HTTP request duration",
    ["method", "route"],
    buckets=HTTP_BUCKETS,
)
HTTP_IN_PROGRESS = Gauge(
    "traveler_http_requests_in_progress",
    "HTTP requests being processed right now",
)
SHARD_QUERIES = Counter(
    "traveler_shard_queries_total",
    "Transactions executed in shard databases",
    ["shard", "outcome"],
)
SHARD_DURATION = Histogram(
    "traveler_shard_query_duration_seconds",
    "Time from taking a pooled connection to the end of the transaction",
    ["shard"],
    buckets=SHARD_BUCKETS,
)
MAPPING_RELOADS = Counter(
    "traveler_shard_mapping_reloads_total",
    "Shard mapping reloads caused by moved databases",
)
PROCESS_THREADS = Gauge(
    "traveler_process_threads",
    "Python threads in the API process",
)
PROCESS_THREADS.set_function(threading.active_count)


SHARD_OUTCOMES = ("ok", "aborted", "db_error")


def init_shard_series(shard_keys) -> None:
    for shard in shard_keys:
        SHARD_DURATION.labels(shard)
        for outcome in SHARD_OUTCOMES:
            SHARD_QUERIES.labels(shard, outcome)


def observe_shard(shard: str, outcome: str, seconds: float) -> None:
    SHARD_QUERIES.labels(shard, outcome).inc()
    SHARD_DURATION.labels(shard).observe(seconds)


def route_template(request) -> str:
    route = request.scope.get("route")
    return getattr(route, "path", None) or "unmatched"


async def track_request(request, call_next):
    if request.url.path in EXCLUDED_PATHS:
        return await call_next(request)
    method = request.method
    status = 500
    HTTP_IN_PROGRESS.inc()
    started = time.perf_counter()
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        HTTP_IN_PROGRESS.dec()
        route = route_template(request)
        HTTP_DURATION.labels(method, route).observe(time.perf_counter() - started)
        HTTP_REQUESTS.labels(method, route, str(status)).inc()


class ShardPoolCollector:
    def __init__(self, router):
        self._router = router

    def describe(self):
        return []

    def collect(self):
        labels = ["shard", "node"]
        size = GaugeMetricFamily(
            "traveler_shard_pool_connections", "Open connections in the shard pool", labels=labels)
        idle = GaugeMetricFamily(
            "traveler_shard_pool_idle_connections", "Idle connections in the shard pool", labels=labels)
        waiting = GaugeMetricFamily(
            "traveler_shard_pool_requests_waiting", "Requests waiting for a connection", labels=labels)
        limit = GaugeMetricFamily(
            "traveler_shard_pool_max_connections", "Maximum size of the shard pool", labels=labels)
        for shard, node, stats in self._router.pool_stats():
            values = [shard, node]
            size.add_metric(values, stats.get("pool_size", 0))
            idle.add_metric(values, stats.get("pool_available", 0))
            waiting.add_metric(values, stats.get("requests_waiting", 0))
            limit.add_metric(values, stats.get("pool_max", 0))
        yield size
        yield idle
        yield waiting
        yield limit


_registered = False


def register_pool_collector(router) -> None:
    global _registered
    if not _registered:
        REGISTRY.register(ShardPoolCollector(router))
        _registered = True
