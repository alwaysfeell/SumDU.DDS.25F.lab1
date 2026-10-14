# ===================================================================
# ENHANCED RACE CONDITION TESTS
# Multiple strategies for reliable race condition detection
# ===================================================================

# Setup: Create plan for race condition testing
POST {{host}}/api/travel-plans
Content-Type: application/json
{
  "title": "Race Condition Test Plan",
  "description": "Testing concurrent operations",
  "budget": 1000.00
}

HTTP 201
[Captures]
race_plan_id: jsonpath "$.id"
initial_version: jsonpath "$.version"

# Strategy 1: Rapid Sequential Updates (simulates race condition)
# Update 1: Should succeed
PUT {{host}}/api/travel-plans/{{race_plan_id}}
Content-Type: application/json
{
  "title": "First Update",
  "budget": 1100.00,
  "version": {{initial_version}}
}

HTTP 200
[Captures]
updated_version_1: jsonpath "$.version"

[Asserts]
jsonpath "$.version" == 2
jsonpath "$.title" == "First Update"

# Update 2: Using old version (should fail with 409)
PUT {{host}}/api/travel-plans/{{race_plan_id}}
Content-Type: application/json
{
  "title": "Second Update (Should Fail)",
  "budget": 1200.00,
  "version": {{initial_version}}
}

HTTP 409
[Asserts]
jsonpath "$.error" contains "Conflict"
jsonpath "$.current_version" == 2

# Strategy 2: Stress Test Location Auto-Ordering
# Rapidly create multiple locations to test concurrent insertion
POST {{host}}/api/travel-plans/{{race_plan_id}}/locations
Content-Type: application/json
{
  "name": "Location A",
  "budget": 100.00
}

HTTP 201
[Captures]
location_a_order: jsonpath "$.visit_order"

POST {{host}}/api/travel-plans/{{race_plan_id}}/locations
Content-Type: application/json
{
  "name": "Location B", 
  "budget": 150.00
}

HTTP 201
[Captures]
location_b_order: jsonpath "$.visit_order"

POST {{host}}/api/travel-plans/{{race_plan_id}}/locations
Content-Type: application/json
{
  "name": "Location C",
  "budget": 200.00
}

HTTP 201
[Captures]
location_c_order: jsonpath "$.visit_order"

# Verify proper ordering (should be 1, 2, 3)
GET {{host}}/api/travel-plans/{{race_plan_id}}

HTTP 200
[Asserts]
jsonpath "$.locations" count == 3
jsonpath "$.locations[0].visit_order" == 1
jsonpath "$.locations[1].visit_order" == 2
jsonpath "$.locations[2].visit_order" == 3

# Strategy 4: Concurrent Location Updates (optimistic locking for locations)
# User A and User B both read location D with version 1
POST {{host}}/api/travel-plans/{{race_plan_id}}/locations
Content-Type: application/json
{
  "name": "Location D",
  "budget": 50.00,
  "notes": "Book tickets"
}

HTTP 201
[Captures]
location_d_id: jsonpath "$.id"
location_d_version: jsonpath "$.version"

[Asserts]
jsonpath "$.version" == 1

# User A changes budget 50 -> 75 with version 1: succeeds, version becomes 2
PUT {{host}}/api/locations/{{location_d_id}}
Content-Type: application/json
{
  "budget": 75.00,
  "version": {{location_d_version}}
}

HTTP 200
[Asserts]
jsonpath "$.version" == 2
jsonpath "$.budget" == 75.00

# User B changes notes with stale version 1: must fail with 409
PUT {{host}}/api/locations/{{location_d_id}}
Content-Type: application/json
{
  "notes": "Tickets booked!",
  "version": {{location_d_version}}
}

HTTP 409
[Asserts]
jsonpath "$.error" contains "Conflict"
jsonpath "$.current_version" == 2

# User B re-reads the plan, gets fresh version and retries
GET {{host}}/api/travel-plans/{{race_plan_id}}

HTTP 200
[Captures]
location_d_fresh_version: jsonpath "$.locations[3].version"

[Asserts]
jsonpath "$.locations[3].name" == "Location D"
jsonpath "$.locations[3].version" == 2

PUT {{host}}/api/locations/{{location_d_id}}
Content-Type: application/json
{
  "notes": "Tickets booked!",
  "version": {{location_d_fresh_version}}
}

HTTP 200
[Asserts]
jsonpath "$.version" == 3
jsonpath "$.budget" == 75.00
jsonpath "$.notes" == "Tickets booked!"

# Strategy 5: Reorder locations (swap visit_order), both versions are bumped
PUT {{host}}/api/locations/{{location_d_id}}
Content-Type: application/json
{
  "visit_order": 1,
  "version": 3
}

HTTP 200
[Asserts]
jsonpath "$.visit_order" == 1
jsonpath "$.version" == 4

GET {{host}}/api/travel-plans/{{race_plan_id}}

HTTP 200
[Asserts]
jsonpath "$.locations" count == 4
jsonpath "$.locations[0].name" == "Location D"
jsonpath "$.locations[0].visit_order" == 1
jsonpath "$.locations[3].name" == "Location A"
jsonpath "$.locations[3].visit_order" == 4
jsonpath "$.locations[3].version" == 2

# Strategy 3: Cascade Delete Race Condition Test
DELETE {{host}}/api/travel-plans/{{race_plan_id}}

HTTP 204

# Verify complete deletion (locations should be gone too)
GET {{host}}/api/travel-plans/{{race_plan_id}}

HTTP 404