import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  addLocation,
  updateTravelPlan,
  deleteTravelPlan,
  testValidation,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
  generateInvalidData,
} from '../utils/data-generator.js';
import { ENDPOINTS } from '../config/endpoints.js';

const validationErrors = new Rate('validation_errors');
const validationResponseTime = new Trend('validation_response_time');

export const options = {
  scenarios: {
    travel_plan_validation: {
      executor: 'constant-vus',
      exec: 'testTravelPlanValidation',
      vus: 20,
      duration: '10m',
    },

    location_validation: {
      executor: 'constant-vus',
      exec: 'testLocationValidation',
      vus: 20,
      duration: '10m',
      startTime: '5s',
    },

    valid_baseline: {
      executor: 'constant-vus',
      exec: 'testValidBaseline',
      vus: 10,
      duration: '10m',
      startTime: '10s',
    },
  },

  thresholds: {
    ...DEFAULT_THRESHOLDS,

    'validation_response_time': [
      'p(95)<200',
      'p(99)<500',
    ],

    'validation_errors': ['rate>0.5'],

    'checks': ['rate>0.90'],
  },

  userAgent: 'K6-Validation-LoadTest/1.0',
};

export function testTravelPlanValidation() {
  const validationTests = [
    {
      name: 'missing_title',
      data: generateInvalidData('missing_title'),
    },

    {
      name: 'empty_title',
      data: generateInvalidData('empty_title'),
    },

    {
      name: 'long_title',
      data: generateInvalidData('long_title'),
    },

    {
      name: 'invalid_dates',
      data: generateInvalidData('invalid_dates'),
    },

    {
      name: 'negative_budget',
      data: generateInvalidData('negative_budget'),
    },

    {
      name: 'invalid_currency',
      data: generateInvalidData('invalid_currency'),
    },
  ];

  const testIndex = Math.floor(Math.random() * validationTests.length);
  const test = validationTests[testIndex];

  const startTime = Date.now();
  const success = testValidation('POST', ENDPOINTS.TRAVEL_PLANS, test.data);
  const duration = Date.now() - startTime;

  validationResponseTime.add(duration);
  validationErrors.add(success ? 1 : 0);

  check(success, {
    [`validation test '${test.name}' passed`]: (s) => s === true,
  });

  sleep(0.5);
}

export function testLocationValidation() {
  const plan = createTravelPlan(generateTravelPlan());

  if (!plan) {
    sleep(1);
    return;
  }

  const planId = plan.id;

  const locationValidationTests = [
    {
      name: 'missing_name',
      data: { address: 'Test Address', budget: 100 },
    },

    {
      name: 'empty_name',
      data: { name: '', budget: 100 },
    },

    {
      name: 'long_name',
      data: { name: 'A'.repeat(250), budget: 100 },
    },

    {
      name: 'invalid_latitude',
      data: { name: 'Test Location', latitude: 91.0, longitude: 2.0 },
    },

    {
      name: 'invalid_longitude',
      data: { name: 'Test Location', latitude: 48.0, longitude: 181.0 },
    },

    {
      name: 'invalid_time_range',
      data: {
        name: 'Test Location',
        arrival_date: '2025-06-02T15:00:00Z',
        departure_date: '2025-06-02T09:00:00Z',
      },
    },

    {
      name: 'negative_budget',
      data: { name: 'Test Location', budget: -50.0 },
    },
  ];

  const testIndex = Math.floor(Math.random() * locationValidationTests.length);
  const test = locationValidationTests[testIndex];

  const startTime = Date.now();
  const success = testValidation(
    'POST',
    ENDPOINTS.LOCATIONS_FOR_PLAN(planId),
    test.data
  );
  const duration = Date.now() - startTime;

  validationResponseTime.add(duration);
  validationErrors.add(success ? 1 : 0);

  check(success, {
    [`location validation test '${test.name}' passed`]: (s) => s === true,
  });

  deleteTravelPlan(planId);

  sleep(0.5);
}

export function testValidBaseline() {
  const planData = generateTravelPlan();
  const plan = createTravelPlan(planData);

  if (!plan) {
    sleep(1);
    return;
  }

  const planId = plan.id;

  check(plan, {
    'valid plan created successfully': (p) => p.id !== undefined,
    'valid plan has version': (p) => p.version === 1,
  });

  sleep(0.3);

  const locationData = generateLocation();
  const location = addLocation(planId, locationData);

  if (location) {
    check(location, {
      'valid location created successfully': (loc) => loc.id !== undefined,
      'valid location has visit_order': (loc) => loc.visit_order >= 1,
    });
  }

  sleep(0.3);

  const updateData = {
    ...planData,
    title: 'Updated Valid Plan',
    version: plan.version,
  };

  const updated = updateTravelPlan(planId, updateData);

  if (updated && !updated.conflict) {
    check(updated, {
      'valid plan updated successfully': (p) => p.version === 2,
    });
  }

  sleep(0.3);

  deleteTravelPlan(planId);

  sleep(0.5);
}

export function testEdgeCases() {
  const maxValues = {
    title: 'A'.repeat(200),
    budget: 99999999.99,
    currency: 'USD',
  };

  const plan1 = createTravelPlan(maxValues);

  if (plan1) {
    check(plan1, {
      'max title length accepted': (p) => p.title.length === 200,
      'large budget accepted': (p) => p.budget === 99999999.99,
    });
    deleteTravelPlan(plan1.id);
  }

  sleep(0.3);

  const plan2 = createTravelPlan(generateTravelPlan());

  if (plan2) {
    const boundaryLocation = {
      name: 'Boundary Location',
      latitude: -90.0,
      longitude: 180.0,
    };

    const loc = addLocation(plan2.id, boundaryLocation);

    if (loc) {
      check(loc, {
        'min latitude accepted': (l) => l.latitude === -90.0,
        'max longitude accepted': (l) => l.longitude === 180.0,
      });
    }

    deleteTravelPlan(plan2.id);
  }

  sleep(0.5);
}

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting Validation & Error Handling Load Test');
  console.log('Scenario 1: Travel Plan Validation (20 VUs)');
  console.log('Scenario 2: Location Validation (20 VUs)');
  console.log('Scenario 3: Valid Baseline (10 VUs)');
  console.log('Duration: 10 minutes');
  console.log('Focus: Validation speed, error handling, edge cases');
  console.log('Expected: High error rate is normal (testing validation)');
  console.log('='.repeat(80));
}

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('Validation Load Test completed');
  console.log('Check metrics: validation_response_time and validation_errors rate');
  console.log('='.repeat(80));
}
