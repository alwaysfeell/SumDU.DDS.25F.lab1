export const BASE_URL = __ENV.API_URL || 'http://127.0.0.1:4567';

export const ENDPOINTS = {
  TRAVEL_PLANS: `${BASE_URL}/api/travel-plans`,
  TRAVEL_PLAN_BY_ID: (id) => `${BASE_URL}/api/travel-plans/${id}`,
  LOCATIONS_FOR_PLAN: (planId) => `${BASE_URL}/api/travel-plans/${planId}/locations`,
  LOCATION_BY_ID: (id) => `${BASE_URL}/api/locations/${id}`,
  HEALTH: `${BASE_URL}/health`,
};

export const DEFAULT_THRESHOLDS = {
  'http_req_duration{type:read}': ['p(95)<500'],
  'http_req_duration{type:write}': ['p(95)<1000'],
  'http_req_duration': ['p(99)<2000'],
  'http_req_failed': ['rate<0.01'],
  'checks': ['rate>0.95'],
};

export const SMOKE_THRESHOLDS = {
  'http_req_duration': ['p(95)<1000'],
  'http_req_failed': ['rate<0.05'],
  'checks': ['rate>0.90'],
};

export const STRESS_THRESHOLDS = {
  'http_req_duration': ['p(95)<2000'],
  'http_req_failed': ['rate<0.05'],
  'checks': ['rate>0.85'],
};

export const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
};

export const THINK_TIME = {
  MIN: 1,
  MAX: 3,
};

export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 100,
};

export const REQUEST_TIMEOUT = __ENV.REQ_TIMEOUT || '10s';
