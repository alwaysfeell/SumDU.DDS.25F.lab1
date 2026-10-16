import { sleep } from 'k6';
import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  getTravelPlan,
  updateTravelPlan,
  deleteTravelPlan,
  verifyPlanDeleted,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateTravelPlanUpdate,
} from '../utils/data-generator.js';

export const options = {
  stages: [
    { duration: '2m', target: 50 },
    { duration: '5m', target: 50 },
    { duration: '2m', target: 0 },
  ],

  thresholds: {
    ...DEFAULT_THRESHOLDS,

    'http_req_duration{type:write}': [
      'p(95)<1000',
      'p(99)<2000',
    ],
    'http_req_duration{type:read}': [
      'p(95)<500',
      'p(99)<1000',
    ],

    'optimistic_lock_conflicts': ['rate>0'],

    'checks': ['rate>0.95'],
  },

  noConnectionReuse: false,
  userAgent: 'K6-CRUD-LoadTest/1.0',
};

export default function () {
  const newPlan = generateTravelPlan();
  const createdPlan = createTravelPlan(newPlan);

  if (!createdPlan) {
    console.error('Failed to create travel plan');
    return;
  }

  const planId = createdPlan.id;
  const initialVersion = createdPlan.version;

  thinkTime(1, 2);

  const retrievedPlan = getTravelPlan(planId);

  if (!retrievedPlan) {
    console.error(`Failed to retrieve plan ${planId}`);
    deleteTravelPlan(planId);
    return;
  }

  thinkTime(1, 2);

  const updateData = generateTravelPlanUpdate(initialVersion);
  const updatedPlan = updateTravelPlan(planId, updateData);

  if (!updatedPlan || updatedPlan.conflict) {
    console.error(`Failed to update plan ${planId}`);
    deleteTravelPlan(planId);
    return;
  }

  thinkTime(0.5, 1);

  const conflictUpdate = generateTravelPlanUpdate(initialVersion);
  const conflictResult = updateTravelPlan(planId, conflictUpdate);

  if (conflictResult && conflictResult.conflict) {
  }

  thinkTime(0.5, 1);

  const deleted = deleteTravelPlan(planId);

  if (!deleted) {
    console.error(`Failed to delete plan ${planId}`);
    return;
  }

  thinkTime(0.5, 1);

  verifyPlanDeleted(planId);

  sleep(1);
}

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting CRUD Load Test');
  console.log('Target: 50 concurrent users');
  console.log('Duration: 9 minutes (2m ramp-up + 5m steady + 2m ramp-down)');
  console.log('='.repeat(80));
}

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('CRUD Load Test completed');
  console.log('='.repeat(80));
}
