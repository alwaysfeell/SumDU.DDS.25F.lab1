import { check, sleep, group } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  getTravelPlan,
  listTravelPlans,
  addLocation,
  updateLocationWithRetry,
  updateTravelPlan,
  deleteTravelPlan,
  deleteLocation,
  checkHealth,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
  generateLocationWithDates,
} from '../utils/data-generator.js';

const sessionCompleted = new Rate('session_completion_rate');
const actionsPerSession = new Trend('actions_per_session');
const sessionDuration = new Trend('session_duration_seconds');
const userTypeDistribution = new Counter('user_type_distribution');

export const options = {
  scenarios: {
    realistic_users: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 30,
      maxVUs: 100,
      stages: [
        { duration: '3m', target: 10 },
        { duration: '7m', target: 20 },
        { duration: '5m', target: 15 },
        { duration: '3m', target: 5 },
      ],
      exec: 'realisticUserJourney',
    },
  },

  thresholds: {
    ...DEFAULT_THRESHOLDS,

    'http_req_duration': [
      'p(95)<800',
      'p(99)<1500',
    ],

    'session_completion_rate': ['rate>0.90'],

    'actions_per_session': ['avg>5', 'avg<20'],

    'checks': ['rate>0.93'],
  },

  userAgent: 'K6-RealisticUser-LoadTest/1.0',
};

export default function realisticUserJourney() {
  const sessionStart = Date.now();
  let actionsCount = 0;
  let sessionSuccess = true;

  const rand = Math.random();
  let userType;

  if (rand < 0.30) {
    userType = 'new_user';
    userTypeDistribution.add(1, { type: 'new_user' });
    actionsCount = newUserJourney();
  } else if (rand < 0.80) {
    userType = 'experienced_user';
    userTypeDistribution.add(1, { type: 'experienced_user' });
    actionsCount = experiencedUserJourney();
  } else {
    userType = 'browser';
    userTypeDistribution.add(1, { type: 'browser' });
    actionsCount = browserJourney();
  }

  const sessionEnd = Date.now();
  const duration = (sessionEnd - sessionStart) / 1000;

  sessionDuration.add(duration);
  actionsPerSession.add(actionsCount);
  sessionCompleted.add(sessionSuccess ? 1 : 0);
}

function newUserJourney() {
  let actions = 0;

  group('New User Journey', function() {
    checkHealth();
    actions++;
    thinkTime(1, 2);

    group('Browse examples', function() {
      const publicPlans = listTravelPlans();
      actions++;

      if (publicPlans && publicPlans.length > 0) {
        const examplesToView = Math.min(randomIntBetween(2, 3), publicPlans.length);

        for (let i = 0; i < examplesToView; i++) {
          const planId = publicPlans[i].id;
          getTravelPlan(planId);
          actions++;

          thinkTime(3, 6);
        }
      }
    });

    group('Create first plan', function() {
      thinkTime(2, 4);

      const planData = generateTravelPlan();
      planData.title = 'My First Travel Plan';
      planData.description = 'Exciting new journey!';

      const plan = createTravelPlan(planData);
      actions++;

      if (!plan) {
        return actions;
      }

      const planId = plan.id;
      let currentVersion = plan.version;

      thinkTime(1, 2);

      group('Add locations gradually', function() {
        const locationsToAdd = randomIntBetween(2, 5);

        for (let i = 0; i < locationsToAdd; i++) {
          thinkTime(2, 4);

          const locationData = generateLocationWithDates(30 + i);
          const location = addLocation(planId, locationData);
          actions++;

          if (location) {
            thinkTime(1, 2);
            getTravelPlan(planId);
            actions++;
          }
        }
      });

      group('Fix mistakes', function() {
        thinkTime(3, 5);

        const updateData = {
          ...planData,
          budget: (plan.budget || 1000) + 500,
          description: 'Updated description with more details',
          version: currentVersion,
        };

        const updated = updateTravelPlan(planId, updateData);
        actions++;

        if (updated && !updated.conflict) {
          currentVersion = updated.version;
        }
      });

      thinkTime(2, 3);
      getTravelPlan(planId);
      actions++;
    });
  });

  return actions;
}

function experiencedUserJourney() {
  let actions = 0;

  group('Experienced User Journey', function() {
    group('View my plans', function() {
      const myPlans = listTravelPlans();
      actions++;
      thinkTime(1, 2);

      if (!myPlans || myPlans.length === 0) {
        const planData = generateTravelPlan();
        createTravelPlan(planData);
        actions++;
        thinkTime(1, 2);
        return actions;
      }

      const planToEdit = myPlans[Math.floor(Math.random() * myPlans.length)];
      const fullPlan = getTravelPlan(planToEdit.id);
      actions++;

      if (!fullPlan) {
        return actions;
      }

      thinkTime(2, 3);

      group('Add new locations', function() {
        const newLocations = randomIntBetween(1, 3);

        for (let i = 0; i < newLocations; i++) {
          thinkTime(1, 2);
          const locationData = generateLocation();
          addLocation(fullPlan.id, locationData);
          actions++;
        }
      });

      thinkTime(1, 2);

      if (fullPlan.locations && fullPlan.locations.length > 0) {
        group('Update existing locations', function() {
          const locationsToUpdate = Math.min(2, fullPlan.locations.length);

          for (let i = 0; i < locationsToUpdate; i++) {
            const location = fullPlan.locations[i];

            thinkTime(1, 2);

            const updateData = {
              name: location.name + ' (Updated)',
              budget: location.budget ? location.budget + 50 : 100,
              notes: 'Updated by experienced user',
            };

            updateLocationWithRetry(fullPlan.id, location.id, updateData, location.version);
            actions++;
          }
        });
      }

      thinkTime(1, 2);

      if (fullPlan.locations && fullPlan.locations.length > 2 && Math.random() < 0.4) {
        group('Remove unnecessary', function() {
          const locationToDelete = fullPlan.locations[fullPlan.locations.length - 1];

          thinkTime(1, 2);
          deleteLocation(locationToDelete.id);
          actions++;
        });
      }

      group('Update plan details', function() {
        thinkTime(1, 3);

        const updateData = {
          title: fullPlan.title,
          description: fullPlan.description || 'Updated',
          budget: fullPlan.budget ? fullPlan.budget + 200 : 2000,
          version: fullPlan.version,
        };

        updateTravelPlan(fullPlan.id, updateData);
        actions++;
      });

      thinkTime(1, 2);
      getTravelPlan(fullPlan.id);
      actions++;
    });
  });

  return actions;
}

function browserJourney() {
  let actions = 0;

  group('Browser Journey', function() {
    const plans = listTravelPlans();
    actions++;

    if (!plans || plans.length === 0) {
      return actions;
    }

    thinkTime(2, 4);

    const plansToView = Math.min(randomIntBetween(3, 6), plans.length);

    for (let i = 0; i < plansToView; i++) {
      const randomIndex = Math.floor(Math.random() * plans.length);
      const planId = plans[randomIndex].id;

      const planDetails = getTravelPlan(planId);
      actions++;

      if (planDetails && planDetails.locations) {
        thinkTime(4, 8);

        if (Math.random() < 0.3) {
          listTravelPlans();
          actions++;
          thinkTime(2, 3);
        }
      } else {
        thinkTime(1, 2);
      }
    }

    if (Math.random() < 0.4) {
      thinkTime(2, 3);
      const favoriteIndex = Math.floor(Math.random() * plans.length);
      getTravelPlan(plans[favoriteIndex].id);
      actions++;
      thinkTime(3, 5);
    }
  });

  return actions;
}

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting Realistic User Journey Load Test');
  console.log('');
  console.log('User types:');
  console.log('  30% - New Users (creating first plan)');
  console.log('  50% - Experienced Users (editing existing)');
  console.log('  20% - Browsers (just looking)');
  console.log('');
  console.log('Duration: 18 minutes with variable arrival rate');
  console.log('Peak activity: 20 users/second');
  console.log('Focus: Real-world user behavior with think time');
  console.log('='.repeat(80));
}

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('Realistic User Journey Test completed');
  console.log('');
  console.log('Key metrics to review:');
  console.log('  - user_type_distribution (should be ~30/50/20)');
  console.log('  - session_completion_rate (>90% is good)');
  console.log('  - actions_per_session (typically 5-20)');
  console.log('  - session_duration_seconds (includes think time)');
  console.log('');
  console.log('This test simulates real user behavior with natural pauses.');
  console.log('Lower throughput than other tests is expected and normal.');
  console.log('='.repeat(80));
}
