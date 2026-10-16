import { group } from 'k6';
import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { THINK_TIME } from '../config/endpoints.js';
import {
  listTravelPlans,
  createTravelPlan,
  getTravelPlan,
  addLocation,
  updateLocationWithRetry,
  updateTravelPlanWithRetry,
  deleteLocation,
  deleteTravelPlan,
  checkHealth,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
  generateLocationWithDates,
} from '../utils/data-generator.js';

export const SHARED_PLANS = parseInt(__ENV.SHARED_PLANS || '50', 10);
const SEED_LOCATIONS = 3;
const TITLE_PREFIX = 'k6:';

function pause() {
  thinkTime(THINK_TIME.MIN, THINK_TIME.MAX);
}

function money(min, max) {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

export function setupSharedPlans() {
  if (!checkHealth()) {
    throw new Error('TravelerAPI недоступний (GET /health). Запустіть сервер: python run.py');
  }
  cleanupTestPlans();

  const ids = [];
  for (let i = 0; i < SHARED_PLANS; i++) {
    const data = generateTravelPlan();
    data.title = `${TITLE_PREFIX} Shared plan #${i + 1}`;
    const plan = createTravelPlan(data);
    if (!plan) continue;
    for (let j = 0; j < SEED_LOCATIONS; j++) {
      const loc = generateLocation();
      loc.name = `Seed ${j + 1}: ${loc.name}`;
      addLocation(plan.id, loc);
    }
    ids.push(plan.id);
  }
  if (ids.length === 0) {
    throw new Error('Не вдалося створити жодного спільного плану — перевірте API і БД');
  }
  console.log(`Створено ${ids.length} спільних планів по ${SEED_LOCATIONS} локації`);
  return { sharedPlanIds: ids };
}

export function cleanupTestPlans() {
  const plans = listTravelPlans() || [];
  let removed = 0;
  for (const p of plans) {
    if (typeof p.title === 'string' && p.title.indexOf(TITLE_PREFIX) === 0) {
      if (deleteTravelPlan(p.id)) removed++;
    }
  }
  if (removed > 0) console.log(`Прибрано тестових планів: ${removed}`);
  return removed;
}

export function travelerJourney(data) {
  const r = Math.random();
  if (r < 0.55) {
    collaboratorSession(data.sharedPlanIds);
  } else if (r < 0.85) {
    plannerSession();
  } else {
    viewerSession(data.sharedPlanIds);
  }
}

function collaboratorSession(sharedPlanIds) {
  group('collaborator', function () {
    const planId = randomItem(sharedPlanIds);

    const plan = getTravelPlan(planId);
    if (!plan) {
      pause();
      return;
    }
    pause();

    let added = null;
    if (Math.random() < 0.5) {
      added = addLocation(planId, generateLocationWithDates(randomIntBetween(10, 60)));
      pause();
    }

    const seeds = (plan.locations || []).filter((l) => l.name.indexOf('Seed') === 0);
    if (seeds.length > 0 && Math.random() < 0.6) {
      const loc = randomItem(seeds);
      updateLocationWithRetry(
        planId,
        loc.id,
        { budget: money(10, 500), notes: `Edited by VU ${__VU} at ${new Date().toISOString()}` },
        loc.version
      );
      pause();
    }

    if (Math.random() < 0.25) {
      updateTravelPlanWithRetry(planId, { budget: money(500, 5000) }, plan.version);
      pause();
    }

    getTravelPlan(planId);
    pause();

    if (added) {
      deleteLocation(added.id);
    }
  });
}

function plannerSession() {
  group('planner', function () {
    const planData = generateTravelPlan();
    planData.title = `${TITLE_PREFIX} ${planData.title}`;
    const plan = createTravelPlan(planData);
    if (!plan) {
      pause();
      return;
    }
    pause();

    const locations = [];
    const count = randomIntBetween(2, 3);
    for (let i = 0; i < count; i++) {
      const loc = addLocation(plan.id, generateLocationWithDates(30 + i));
      if (loc) locations.push(loc);
      pause();
    }

    getTravelPlan(plan.id);
    pause();

    if (locations.length > 0) {
      const loc = locations[0];
      updateLocationWithRetry(plan.id, loc.id, { notes: 'Book tickets in advance', budget: money(20, 300) }, loc.version);
      pause();
    }

    updateTravelPlanWithRetry(plan.id, { description: 'Final version of the trip' }, plan.version);
    pause();

    getTravelPlan(plan.id);
    pause();

    deleteTravelPlan(plan.id);
  });
}

function viewerSession(sharedPlanIds) {
  group('viewer', function () {
    if (Math.random() < 0.5) {
      listTravelPlans();
      pause();
    }
    const views = randomIntBetween(2, 4);
    for (let i = 0; i < views; i++) {
      getTravelPlan(randomItem(sharedPlanIds));
      pause();
    }
  });
}
