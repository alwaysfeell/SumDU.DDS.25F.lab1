GET {{host}}/health
HTTP 200

POST {{host}}/api/travel-plans
Content-Type: application/json
{
  "title": "Metrics Test Plan"
}
HTTP 201
[Captures]
metrics_plan_id: jsonpath "$.id"

GET {{host}}/api/travel-plans/{{metrics_plan_id}}
HTTP 200

GET {{host}}/api/travel-plans/00000000-0000-4000-8000-000000000000
HTTP 404

GET {{host}}/metrics
HTTP 200
[Asserts]
header "Content-Type" contains "text/plain"
body contains "traveler_http_requests_total{method=\"POST\",route=\"/api/travel-plans\",status=\"201\"}"
body contains "traveler_http_requests_total{method=\"GET\",route=\"/api/travel-plans/{plan_id}\",status=\"200\"}"
body contains "traveler_http_requests_total{method=\"GET\",route=\"/api/travel-plans/{plan_id}\",status=\"404\"}"
body contains "traveler_http_request_duration_seconds_bucket"
body contains "traveler_shard_queries_total"
body contains "traveler_shard_pool_connections{node=\"postgres_00\",shard=\"0\"}"
body contains "traveler_shard_pool_max_connections"
body contains "traveler_process_threads"
body not contains "route=\"/metrics\""

DELETE {{host}}/api/travel-plans/{{metrics_plan_id}}
HTTP 204
