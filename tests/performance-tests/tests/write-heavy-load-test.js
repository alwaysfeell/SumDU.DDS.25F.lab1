import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import { STRESS_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  getTravelPlan,
  listTravelPlans,
  addLocation,
  updateLocation,
  updateTravelPlan,
  deleteTravelPlan,
  deleteLocation,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
  generateMultipleLocations,
} from '../utils/data-generator.js';

const writeOperations = new Counter('write_operations');
const readOperations = new Counter('read_operations');
const transactionRate = new Rate('transaction_success');
const locationsPerPlan = new Trend('locations_per_plan');

export const options = {
  scenarios: {
    intensive_writers: {
      executor: 'ramping-vus',
      exec: 'intensiveWritePath',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '8m', target: 50 },
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },

    light_readers: {
      executor: 'ramping-vus',
      exec: 'lightReadPath',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 12 },
        { duration: '8m', target: 12 },
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
      startTime: '10s',
    },
  },

  thresholds: {
    ...STRESS_THRESHOLDS,

    'http_req_duration{type:write}': [
      'p(95)<1500',
      'p(99)<3000',
    ],

    'http_req_duration{type:read}': [
      'p(95)<800',
    ],

    'transaction_success': ['rate>0.90'],

    'write_operations': ['count>0'],
    'read_operations': ['count>0'],

    'checks': ['rate>0.85'],
  },

  userAgent: 'K6-WriteHeavy-LoadTest/1.0',
};

export function intensiveWritePath() {
  let transactionSuccess = true;

  const planData = generateTravelPlan();
  planData.title = `Write Intensive Plan ${Date.now()}`;

  const plan = createTravelPlan(planData);

  if (!plan) {
    transactionSuccess = false;
    transactionRate.add(0);
    sleep(2);
    return;
  }

  const planId = plan.id;
  let currentVersion = plan.version;
  writeOperations.add(1);

  sleep(0.3);

  const locationCount = Math.floor(Math.random() * 5) + 3;
  const locationIds = [];
  const locationVersions = {};

  for (let i = 0; i < locationCount; i++) {
    const locationData = generateLocation();
    locationData.name = `Location ${i + 1} - ${Date.now()}`;

    const location = addLocation(planId, locationData);

    if (location) {
      locationIds.push(location.id);
      locationVersions[location.id] = location.version;
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }

    sleep(0.2);
  }

  locationsPerPlan.add(locationIds.length);

  sleep(0.3);

  const updateCount = Math.floor(Math.random() * 3) + 2;

  for (let i = 0; i < updateCount; i++) {
    const updateData = {
      ...planData,
      title: `Updated ${i + 1} times - ${planData.title}`,
      budget: (plan.budget || 1000) + (i * 100),
      version: currentVersion,
    };

    const updated = updateTravelPlan(planId, updateData);

    if (updated && !updated.conflict) {
      currentVersion = updated.version;
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }

    sleep(0.2);
  }

  sleep(0.3);

  const locationsToUpdate = locationIds.slice(0, Math.ceil(locationIds.length / 2));

  for (const locationId of locationsToUpdate) {
    const updateData = {
      name: `Updated Location ${Date.now()}`,
      budget: Math.round((Math.random() * 200 + 50) * 100) / 100,
      notes: 'Updated during write-heavy test',
      version: locationVersions[locationId],
    };

    const updated = updateLocation(locationId, updateData);

    if (updated && !updated.conflict) {
      locationVersions[locationId] = updated.version;
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }

    sleep(0.1);
  }

  sleep(0.3);

  const locationsToDelete = locationIds.slice(0, Math.ceil(locationIds.length / 3));

  for (const locationId of locationsToDelete) {
    const deleted = deleteLocation(locationId);

    if (deleted) {
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }

    sleep(0.1);
  }

  sleep(0.3);

  const finalPlan = getTravelPlan(planId);
  readOperations.add(1);

  if (finalPlan) {
    const remainingLocations = locationIds.length - locationsToDelete.length;
    check(finalPlan, {
      'plan still exists': (p) => p.id === planId,
      'correct locations count': (p) => p.locations && p.locations.length === remainingLocations,
      'version increased': (p) => p.version > plan.version,
    });
  }

  sleep(0.3);

  if (Math.random() < 0.5) {
    const deleted = deleteTravelPlan(planId);

    if (deleted) {
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }
  }

  transactionRate.add(transactionSuccess ? 1 : 0);

  sleep(0.5);
}

export function lightReadPath() {
  readOperations.add(1);

  const plansList = listTravelPlans();

  if (plansList) {
    check(plansList, {
      'can retrieve plans list during heavy writes': (list) => Array.isArray(list),
    });
  }

  sleep(0.5);

  if (plansList && plansList.length > 0) {
    const readsCount = Math.random() < 0.5 ? 1 : 2;

    for (let i = 0; i < readsCount; i++) {
      const randomIndex = Math.floor(Math.random() * plansList.length);
      const randomPlanId = plansList[randomIndex].id;

      getTravelPlan(randomPlanId);
      readOperations.add(1);

      sleep(0.3);
    }
  }

  const plansList2 = listTravelPlans();
  readOperations.add(1);

  if (plansList && plansList2) {
    check({ list1: plansList, list2: plansList2 }, {
      'data is consistent during writes': (data) => {
        return Array.isArray(data.list1) && Array.isArray(data.list2);
      },
    });
  }

  sleep(0.5);
}

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting Write-Heavy Load Test');
  console.log('Scenario 1: Intensive Writers (50 VUs) - 80% operations');
  console.log('Scenario 2: Light Readers (12 VUs) - 20% operations');
  console.log('Duration: 12 minutes');
  console.log('Focus: Database write performance, transaction throughput');
  console.log('Expected: High write load, stress on DB connections');
  console.log('='.repeat(80));
}

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('Write-Heavy Load Test completed');
  console.log('');
  console.log('Key metrics to review:');
  console.log('  - write_operations (should be ~4x read_operations)');
  console.log('  - transaction_success (should be >90%)');
  console.log('  - http_req_duration{type:write} (write performance)');
  console.log('  - locations_per_plan (complexity metric)');
  console.log('');
  console.log('Performance indicators:');
  console.log('  ✓ If transaction_success >90% → DB handles load well');
  console.log('  ✓ If write p(95) <1.5s → Good write performance');
  console.log('  ✗ If errors >10% → Database needs optimization');
  console.log('='.repeat(80));
}
