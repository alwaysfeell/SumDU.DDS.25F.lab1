import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate, Counter } from 'k6/metrics';
import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  getTravelPlan,
  listTravelPlans,
  addLocation,
  updateTravelPlan,
  deleteTravelPlan,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
} from '../utils/data-generator.js';

const readOperations = new Counter('read_operations');
const writeOperations = new Counter('write_operations');
const cacheHitRate = new Rate('cache_hit_simulation');

const testPlans = new SharedArray('test_plans', function() {
  return [];
});

export const options = {
  scenarios: {
    readers: {
      executor: 'ramping-vus',
      exec: 'readHeavyPath',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 60 },
        { duration: '8m', target: 60 },
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },

    writers: {
      executor: 'ramping-vus',
      exec: 'writeHeavyPath',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 15 },
        { duration: '8m', target: 15 },
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
      startTime: '30s',
    },
  },

  thresholds: {
    ...DEFAULT_THRESHOLDS,

    'http_req_duration{type:read}': [
      'p(95)<300',
      'p(99)<600',
    ],

    'http_req_duration{type:write}': [
      'p(95)<1000',
    ],

    'read_operations': ['count>0'],
    'write_operations': ['count>0'],

    'checks': ['rate>0.95'],
  },

  userAgent: 'K6-ReadHeavy-LoadTest/1.0',
};

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting Read-Heavy Load Test Setup');
  console.log('Creating 20 travel plans with locations for testing...');
  console.log('='.repeat(80));

  const createdPlans = [];

  for (let i = 0; i < 20; i++) {
    const planData = generateTravelPlan();
    planData.title = `Read Test Plan ${i + 1}`;
    planData.is_public = true;

    const plan = createTravelPlan(planData);

    if (plan) {
      const locationCount = Math.floor(Math.random() * 3) + 2;
      for (let j = 0; j < locationCount; j++) {
        const locationData = generateLocation();
        addLocation(plan.id, locationData);
      }

      createdPlans.push(plan.id);
      console.log(`✓ Created plan ${i + 1}/20: ${plan.id}`);
    }

    sleep(0.2);
  }

  console.log(`\nSetup completed: ${createdPlans.length} plans created`);
  console.log('='.repeat(80));

  return { planIds: createdPlans };
}

export function readHeavyPath(data) {
  if (!data || !data.planIds || data.planIds.length === 0) {
    console.warn('No test plans available for reading');
    sleep(5);
    return;
  }

  readOperations.add(1);

  const plansList = listTravelPlans();

  if (plansList && plansList.length > 0) {
    check(plansList, {
      'plans list not empty': (list) => list.length > 0,
      'plans list contains test data': (list) => list.length >= 10,
    });
  }

  thinkTime(1, 2);

  const randomPlanId = data.planIds[Math.floor(Math.random() * data.planIds.length)];
  const planDetails = getTravelPlan(randomPlanId);

  if (planDetails) {
    check(planDetails, {
      'plan has locations': (p) => p.locations && p.locations.length > 0,
      'plan is public': (p) => p.is_public === true,
    });

    const isSamePlanAsLastTime = Math.random() < 0.3;
    cacheHitRate.add(isSamePlanAsLastTime ? 1 : 0);
  }

  thinkTime(2, 4);

  const additionalReads = Math.floor(Math.random() * 3) + 1;

  for (let i = 0; i < additionalReads; i++) {
    const anotherPlanId = data.planIds[Math.floor(Math.random() * data.planIds.length)];
    getTravelPlan(anotherPlanId);
    readOperations.add(1);

    thinkTime(1, 3);
  }

  if (Math.random() < 0.3) {
    listTravelPlans();
    readOperations.add(1);
  }

  sleep(1);
}

export function writeHeavyPath(data) {
  writeOperations.add(1);

  const planData = generateTravelPlan();
  planData.title = `User Created Plan ${Date.now()}`;

  const plan = createTravelPlan(planData);

  if (!plan) {
    sleep(2);
    return;
  }

  const planId = plan.id;

  thinkTime(1, 2);

  const locationCount = Math.random() < 0.5 ? 1 : 2;

  for (let i = 0; i < locationCount; i++) {
    const locationData = generateLocation();
    addLocation(planId, locationData);
    writeOperations.add(1);

    thinkTime(0.5, 1.5);
  }

  getTravelPlan(planId);
  readOperations.add(1);

  thinkTime(1, 2);

  if (Math.random() < 0.5) {
    const updateData = {
      ...planData,
      title: `Updated: ${planData.title}`,
      budget: plan.budget ? plan.budget + 100 : 1000,
      version: plan.version,
    };

    updateTravelPlan(planId, updateData);
    writeOperations.add(1);

    thinkTime(1, 2);
  }

  if (Math.random() < 0.3) {
    deleteTravelPlan(planId);
    writeOperations.add(1);
  }

  sleep(1);
}

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('Read-Heavy Load Test Cleanup');
  console.log('Deleting test plans...');
  console.log('='.repeat(80));

  if (data && data.planIds) {
    let deleted = 0;
    for (const planId of data.planIds) {
      const success = deleteTravelPlan(planId);
      if (success) {
        deleted++;
      }
      sleep(0.1);
    }
    console.log(`\nCleanup completed: ${deleted}/${data.planIds.length} plans deleted`);
  }

  console.log('='.repeat(80));
  console.log('Read-Heavy Load Test completed');
  console.log('Check metrics:');
  console.log('  - read_operations (should be ~4x write_operations)');
  console.log('  - http_req_duration{type:read} (should be fast)');
  console.log('  - cache_hit_simulation (shows repeated reads)');
  console.log('='.repeat(80));
}
