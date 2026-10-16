import { sleep } from 'k6';
import { SMOKE_THRESHOLDS } from '../config/endpoints.js';
import {
  checkHealth,
  createTravelPlan,
  getTravelPlan,
  addLocation,
  updateTravelPlan,
  deleteTravelPlan,
  listTravelPlans,
  verifyPlanDeleted,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
} from '../utils/data-generator.js';

export const options = {
  stages: [
    { duration: '5s', target: 2 },
    { duration: '10s', target: 5 },
    { duration: '5s', target: 0 },
  ],

  thresholds: {
    ...SMOKE_THRESHOLDS,

    'http_req_duration': ['p(95)<2000'],

    'http_req_failed{type:write}': ['rate==0'],
    'http_req_failed{type:read}': ['rate<0.12'],
    'api_errors': ['rate==0'],

    'checks': ['rate>0.90'],
  },

  userAgent: 'K6-SmokeTest/1.0',
};

export default function () {
  const isHealthy = checkHealth();

  if (!isHealthy) {
    console.error('❌ API health check failed!');
    return;
  }

  thinkTime(0.5, 1);

  const plans = listTravelPlans();

  thinkTime(0.5, 1);

  const planData = generateTravelPlan();
  planData.title = 'Smoke Test Plan';

  console.debug(`📝 Creating travel plan with data: ${JSON.stringify(planData)}`);
  const plan = createTravelPlan(planData);

  if (!plan) {
    console.error('❌ Failed to create travel plan');
    console.error('   This could indicate:');
    console.error('   - API returned non-201 status');
    console.error('   - Response body is not valid JSON');
    console.error('   - Plan data validation failed');
    return;
  }

  const planId = plan.id;
  console.debug(`✓ Created plan: ${planId}`);

  thinkTime(1, 1.5);

  const retrievedPlan = getTravelPlan(planId);

  if (!retrievedPlan) {
    console.error(`❌ Failed to retrieve travel plan: ${planId}`);
    console.error('   This could indicate:');
    console.error('   - API returned non-200 status');
    console.error('   - Response body is not valid JSON');
    console.error('   - Plan was not found (404)');
    deleteTravelPlan(planId);
    return;
  }

  console.debug(`✓ Retrieved plan: ${planId}`);
  console.debug(`   Plan details: title="${retrievedPlan.title}", version=${retrievedPlan.version}, locations=${retrievedPlan.locations?.length || 0}`);

  thinkTime(1, 1.5);

  const locationData = generateLocation();
  locationData.name = 'Smoke Test Location';

  console.debug(`📍 Adding location to plan ${planId} with data: ${JSON.stringify(locationData)}`);
  const location = addLocation(planId, locationData);

  if (!location) {
    console.error(`❌ Failed to add location to plan ${planId}`);
    console.error('   This could indicate:');
    console.error('   - API returned non-201 status');
    console.error('   - Response body is not valid JSON');
    console.error('   - Location data validation failed');
    console.error('   - Plan not found (404)');
    deleteTravelPlan(planId);
    return;
  }

  console.debug(`✓ Added location: ${location.id}`);

  thinkTime(1, 1.5);

  console.debug(`🔄 Re-fetching plan ${planId} to get the latest version...`);
  const planAfterLocationAdd = getTravelPlan(planId);

  if (!planAfterLocationAdd) {
      console.error(`❌ Failed to re-fetch plan ${planId} before update`);
      deleteTravelPlan(planId);
      return;
  }
  console.debug(`✓ Got updated version: ${planAfterLocationAdd.version}`);

  const updateData = {
      ...planData,
      title: 'Updated Smoke Test Plan',
      version: planAfterLocationAdd.version,
  };

  const updated = updateTravelPlan(planId, updateData);

  if (!updated || updated.conflict) {
      console.error('❌ Failed to update travel plan');
      deleteTravelPlan(planId);
      return;
  }

  console.debug(`✓ Updated plan: ${planId}`);

  thinkTime(1, 1.5);

  const deleted = deleteTravelPlan(planId);

  if (!deleted) {
    console.error('❌ Failed to delete travel plan');
    return;
  }

  console.debug(`✓ Deleted plan: ${planId}`);

  thinkTime(1, 1.5);

  const isDeleted = verifyPlanDeleted(planId);

  if (!isDeleted) {
    console.error(`❌ Plan ${planId} was not properly deleted`);
  }

  sleep(1);
}

export function setup() {
  console.log('='.repeat(80));
  console.log('🔥 SMOKE TEST - Basic Functionality Check');
  console.log('='.repeat(80));
  console.log('Target: 5 concurrent users (minimal load)');
  console.log('Duration: 2 minutes');
  console.log('Purpose: Verify API is functional before heavy load testing');
  console.log('');
  console.log('Testing:');
  console.log('  ✓ Health check');
  console.log('  ✓ List travel plans');
  console.log('  ✓ Create travel plan');
  console.log('  ✓ Read travel plan');
  console.log('  ✓ Add location');
  console.log('  ✓ Update travel plan');
  console.log('  ✓ Delete travel plan');
  console.log('='.repeat(80));
  console.log('');
}

export function teardown(data) {
  console.log('');
  console.log('='.repeat(80));
  console.log('🔥 SMOKE TEST COMPLETED');
  console.log('='.repeat(80));
  console.log('');
  console.log('Next steps:');
  console.log('  ✓ If all checks passed → proceed with load testing');
  console.log('  ✗ If checks failed → fix issues before load testing');
  console.log('='.repeat(80));
}
