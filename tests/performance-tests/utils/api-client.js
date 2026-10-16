import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { ENDPOINTS, DEFAULT_HEADERS, REQUEST_TIMEOUT, RETRY_CONFIG } from '../config/endpoints.js';

export const errorRate = new Rate('api_errors');
export const conflictRate = new Rate('optimistic_lock_conflicts');
export const lockRetries = new Counter('optimistic_lock_retries');
export const lockGaveUp = new Counter('optimistic_lock_gave_up');

const MAX_ERROR_LOGS = 3;
let errorLogs = 0;
function logError(...args) {
  if (__ENV.VERBOSE || errorLogs < MAX_ERROR_LOGS) {
    errorLogs++;
    console.error(...args);
  }
}

let requestHook = null;
export function setRequestHook(fn) {
  requestHook = fn;
}

function makeRequest(method, url, body = null, expectedStatuses = [200], operationType = 'read') {
  if (requestHook) {
    requestHook();
  }

  const statuses = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];

  const endpoint = url.replace(/\/[0-9a-f-]{36}/g, '/:id');
  const params = {
    headers: DEFAULT_HEADERS,
    timeout: REQUEST_TIMEOUT,
    tags: {
      type: operationType,
      endpoint: endpoint,
      name: `${method} ${endpoint.replace(/^https?:\/\/[^/]+/, '')}`,
    },
    responseCallback: http.expectedStatuses(...statuses),
  };

  let response;
  if (body) {
    response = http.request(method, url, JSON.stringify(body), params);
  } else {
    response = http.request(method, url, null, params);
  }

  const statusCheck = check(response, {
    [`status is one of [${statuses.join(',')}]`]: (r) => statuses.includes(r.status),
  });

  if (!statusCheck) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }

  if (method === 'PUT') {
    conflictRate.add(response.status === 409 ? 1 : 0);
  }

  return response;
}

export function createTravelPlan(planData) {
  const response = makeRequest(
    'POST',
    ENDPOINTS.TRAVEL_PLANS,
    planData,
    201,
    'write'
  );

  const success = check(response, {
    'plan created successfully': (r) => r.status === 201,
    'plan has valid UUID': (r) => {
      if (r.status !== 201) return false;
      try {
        const body = JSON.parse(r.body);
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.id);
      } catch (e) {
        logError(`❌ Failed to parse response body for plan creation:`, e.message);
        logError(`   Response body: ${r.body}`);
        return false;
      }
    },
    'plan has version 1': (r) => {
      if (r.status !== 201) return false;
      try {
        const body = JSON.parse(r.body);
        return body.version === 1;
      } catch (e) {
        logError(`❌ Failed to parse response body for version check:`, e.message);
        logError(`   Response body: ${r.body}`);
        return false;
      }
    },
  });

  if (response.status !== 201) {
    logError(`❌ POST /api/travel-plans failed with status ${response.status}`);
    logError(`   Request data: ${JSON.stringify(planData)}`);
    logError(`   Response body: ${response.body}`);
    return null;
  }

  if (!success) {
    logError(`❌ Checks failed for plan creation`);
    logError(`   Status: ${response.status}`);
    logError(`   Response body: ${response.body}`);
    return null;
  }

  try {
    const plan = JSON.parse(response.body);
    console.debug(`✓ Successfully created plan: ${plan.id}, title="${plan.title}", version=${plan.version}`);
    return plan;
  } catch (e) {
    logError(`❌ Failed to parse JSON for created plan:`, e.message);
    logError(`   Response body: ${response.body}`);
    return null;
  }
}

export function getTravelPlan(planId) {
  const response = makeRequest(
    'GET',
    ENDPOINTS.TRAVEL_PLAN_BY_ID(planId),
    null,
    200,
    'read'
  );

  const checksPassed = check(response, {
    'plan retrieved successfully': (r) => r.status === 200,
    'plan has locations array': (r) => {
      if (r.status !== 200) return false;
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.locations);
      } catch (e) {
        logError(`❌ Failed to parse response body for plan ${planId}:`, e.message);
        logError(`   Response body: ${r.body}`);
        return false;
      }
    },
  });

  if (response.status !== 200) {
    logError(`❌ GET /api/travel-plans/${planId} failed with status ${response.status}`);
    logError(`   Response body: ${response.body}`);
    return null;
  }

  if (!checksPassed) {
    logError(`❌ Checks failed for plan ${planId}`);
    logError(`   Status: ${response.status}`);
    logError(`   Response body: ${response.body}`);
    return null;
  }

  try {
    const plan = JSON.parse(response.body);
    console.debug(`✓ Successfully retrieved plan ${planId}: title="${plan.title}", locations=${plan.locations?.length || 0}`);
    return plan;
  } catch (e) {
    logError(`❌ Failed to parse JSON for plan ${planId}:`, e.message);
    logError(`   Response body: ${response.body}`);
    return null;
  }
}

export function verifyPlanDeleted(planId) {
  const response = makeRequest(
    'GET',
    ENDPOINTS.TRAVEL_PLAN_BY_ID(planId),
    null,
    404,
    'read'
  );

  const isDeleted = check(response, {
    'plan is deleted (404)': (r) => r.status === 404,
  });

  if (isDeleted) {
    console.debug(`✓ Verified plan ${planId} is deleted (404)`);
  } else {
    logError(`❌ Plan ${planId} should be deleted but returned status ${response.status}`);
    logError(`   Response body: ${response.body}`);
  }

  return isDeleted;
}

export function updateTravelPlan(planId, updateData) {
  const response = makeRequest(
    'PUT',
    ENDPOINTS.TRAVEL_PLAN_BY_ID(planId),
    updateData,
    [200, 409],
    'write'
  );

  if (response.status === 200) {
    const plan = JSON.parse(response.body);
    check(plan, {
      'plan updated successfully': () => true,
      'version incremented': (p) => p.version === updateData.version + 1,
    });
    return plan;
  }

  if (response.status === 409) {
    const body = JSON.parse(response.body);
    check(body, {
      'plan conflict returns current_version': (b) => Number.isInteger(b.current_version),
    });
    return { conflict: true, currentVersion: body.current_version, body: body };
  }

  logError(`❌ PUT /api/travel-plans/${planId} failed with status ${response.status}`);
  logError(`   Response body: ${response.body}`);
  return null;
}

export function deleteTravelPlan(planId) {
  const response = makeRequest(
    'DELETE',
    ENDPOINTS.TRAVEL_PLAN_BY_ID(planId),
    null,
    204,
    'write'
  );

  return check(response, {
    'plan deleted successfully': (r) => r.status === 204,
  });
}

export function addLocation(planId, locationData) {
  const response = makeRequest(
    'POST',
    ENDPOINTS.LOCATIONS_FOR_PLAN(planId),
    locationData,
    201,
    'write'
  );

  const success = check(response, {
    'location created successfully': (r) => r.status === 201,
    'location has visit_order': (r) => {
      if (r.status !== 201) return false;
      try {
        const body = JSON.parse(r.body);
        return body.visit_order >= 1;
      } catch (e) {
        logError(`❌ Failed to parse response body for location visit_order check:`, e.message);
        logError(`   Response body: ${r.body}`);
        return false;
      }
    },
    'location linked to plan': (r) => {
      if (r.status !== 201) return false;
      try {
        const body = JSON.parse(r.body);
        return body.travel_plan_id === planId;
      } catch (e) {
        logError(`❌ Failed to parse response body for location plan link check:`, e.message);
        logError(`   Response body: ${r.body}`);
        return false;
      }
    },
  });

  if (response.status !== 201) {
    logError(`❌ POST /api/travel-plans/${planId}/locations failed with status ${response.status}`);
    logError(`   Request data: ${JSON.stringify(locationData)}`);
    logError(`   Response body: ${response.body}`);
    return null;
  }

  if (!success) {
    logError(`❌ Checks failed for location creation`);
    logError(`   Status: ${response.status}`);
    logError(`   Response body: ${response.body}`);
    return null;
  }

  try {
    const location = JSON.parse(response.body);
    console.debug(`✓ Successfully added location: ${location.id}, name="${location.name}", visit_order=${location.visit_order}`);
    return location;
  } catch (e) {
    logError(`❌ Failed to parse JSON for created location:`, e.message);
    logError(`   Response body: ${response.body}`);
    return null;
  }
}

export function updateLocation(locationId, updateData) {
  if (updateData.version === undefined) {
    logError(`❌ updateLocation(${locationId}) без version — TravelerAPI поверне 400`);
  }

  const response = makeRequest(
    'PUT',
    ENDPOINTS.LOCATION_BY_ID(locationId),
    updateData,
    [200, 409],
    'write'
  );

  if (response.status === 200) {
    const location = JSON.parse(response.body);
    check(location, {
      'location updated successfully': () => true,
      'location version incremented': (loc) => loc.version === updateData.version + 1,
    });
    return location;
  }

  if (response.status === 409) {
    const body = JSON.parse(response.body);
    check(body, {
      'location conflict returns current_version': (b) => Number.isInteger(b.current_version),
    });
    return { conflict: true, currentVersion: body.current_version, body: body };
  }

  logError(`❌ PUT /api/locations/${locationId} failed with status ${response.status}`);
  logError(`   Response body: ${response.body}`);
  return null;
}

export function updateLocationWithRetry(planId, locationId, changes, knownVersion) {
  let version = knownVersion;
  for (let attempt = 0; attempt <= RETRY_CONFIG.MAX_RETRIES; attempt++) {
    const result = updateLocation(locationId, { ...changes, version: version });
    if (!result || !result.conflict) {
      return result;
    }
    if (attempt === RETRY_CONFIG.MAX_RETRIES) {
      break;
    }
    lockRetries.add(1, { entity: 'location' });
    sleep(RETRY_CONFIG.RETRY_DELAY / 1000);

    const plan = getTravelPlan(planId);
    const fresh = plan && plan.locations ? plan.locations.find((l) => l.id === locationId) : null;
    if (!fresh) {
      return null;
    }
    version = fresh.version;
  }
  lockGaveUp.add(1, { entity: 'location' });
  return { conflict: true };
}

export function updateTravelPlanWithRetry(planId, changes, knownVersion) {
  let version = knownVersion;
  for (let attempt = 0; attempt <= RETRY_CONFIG.MAX_RETRIES; attempt++) {
    const result = updateTravelPlan(planId, { ...changes, version: version });
    if (!result || !result.conflict) {
      return result;
    }
    if (attempt === RETRY_CONFIG.MAX_RETRIES) {
      break;
    }
    lockRetries.add(1, { entity: 'plan' });
    sleep(RETRY_CONFIG.RETRY_DELAY / 1000);

    const plan = getTravelPlan(planId);
    if (!plan) {
      return null;
    }
    version = plan.version;
  }
  lockGaveUp.add(1, { entity: 'plan' });
  return { conflict: true };
}

export function deleteLocation(locationId) {
  const response = makeRequest(
    'DELETE',
    ENDPOINTS.LOCATION_BY_ID(locationId),
    null,
    204,
    'write'
  );

  return check(response, {
    'location deleted successfully': (r) => r.status === 204,
  });
}

export function listTravelPlans() {
  const response = makeRequest(
    'GET',
    ENDPOINTS.TRAVEL_PLANS,
    null,
    200,
    'read'
  );

  check(response, {
    'plans list retrieved': (r) => r.status === 200,
    'response is array': (r) => {
      if (r.status !== 200) return false;
      const body = JSON.parse(r.body);
      return Array.isArray(body);
    },
  });

  if (response.status === 200) {
    return JSON.parse(response.body);
  }
  return null;
}

export function checkHealth() {
  const response = makeRequest(
    'GET',
    ENDPOINTS.HEALTH,
    null,
    200,
    'read'
  );

  return check(response, {
    'API is healthy': (r) => r.status === 200,
    'status is healthy': (r) => {
      if (r.status !== 200) return false;
      const body = JSON.parse(r.body);
      return body.status === 'healthy';
    },
  });
}

export function testValidation(method, url, invalidData) {
  const response = makeRequest(
    method,
    url,
    invalidData,
    400,
    'write'
  );

  return check(response, {
    'validation error returned': (r) => r.status === 400,
    'error message present': (r) => {
      if (r.status !== 400) return false;
      const body = JSON.parse(r.body);
      return body.error && body.error.includes('Validation');
    },
  });
}

export function thinkTime(min = 1, max = 3) {
  const duration = Math.random() * (max - min) + min;
  sleep(duration);
}
