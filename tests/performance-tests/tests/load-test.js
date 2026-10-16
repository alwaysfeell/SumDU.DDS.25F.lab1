import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import { setupSharedPlans, cleanupTestPlans, travelerJourney } from '../scenarios/traveler-journey.js';
import { buildProfile, phaseThresholds, enablePhaseTagging, setPhaseOverride } from '../utils/phases.js';
import { makeHandleSummary, TREND_STATS, describe, pct } from '../utils/summary.js';

const LEVELS = (__ENV.LOAD_LEVELS || '50,100,200,300').split(',').map((v) => parseInt(v, 10));

const stages = [];
let prev = 0;
for (const level of LEVELS) {
  stages.push({ dur: '1m', target: level, kind: 'ramp', desc: `Наростання ${prev}→${level} VU` });
  stages.push({ dur: '3m', target: level, kind: 'hold', desc: `Утримання ${level} VU` });
  prev = level;
}
stages.push({ dur: '1m', target: 0, kind: 'down', desc: 'Зниження → 0 VU' });

const profile = buildProfile(stages);
enablePhaseTagging(profile);

export const options = {
  stages: profile.stages,
  thresholds: {
    ...DEFAULT_THRESHOLDS,
    ...phaseThresholds(profile),
  },
  summaryTrendStats: TREND_STATS,
  setupTimeout: '2m',
  teardownTimeout: '5m',
  userAgent: 'K6-LoadTest/1.0',
};

export function setup() {
  setPhaseOverride('setup');
  return setupSharedPlans();
}

export default function (data) {
  travelerJourney(data);
}

export function teardown() {
  setPhaseOverride('teardown');
  cleanupTestPlans();
}

function analyze(stats, data) {
  const holds = stats.filter((s) => s.phase.kind === 'hold');
  const notes = [];
  if (holds.length === 0) return notes;

  let maxOk = null;
  for (const h of holds) {
    if (h.state === 'OK') maxOk = h;
    else break;
  }
  const last = holds[holds.length - 1];
  if (maxOk === null) {
    notes.push(`Вже на першій сходинці (${holds[0].phase.target} VU) вимоги SLA не виконуються: ${describe(holds[0])}.`);
  } else if (maxOk === last) {
    notes.push(`Максимальна кількість користувачів: усі сходинки до ${last.phase.target} VU пройдено без порушення SLA → API витримує щонайменше ${last.phase.target} VU. Точну межу показує stress-тест.`);
  } else {
    const next = holds[holds.indexOf(maxOk) + 1];
    notes.push(`Максимальна кількість користувачів без порушення SLA: ${maxOk.phase.target} VU. На ${next.phase.target} VU стан «${next.state}»: ${describe(next)}.`);
  }
  notes.push(`Пікове навантаження (${last.phase.target} VU): ${describe(last)}.`);
  const failed = data.metrics.http_req_failed ? data.metrics.http_req_failed.values : { rate: 0, passes: 0 };
  const total = data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0;
  notes.push(`Рівень помилок за весь тест: ${pct(failed.rate)} (${failed.passes} з ${total} запитів).`);
  const conflicts = data.metrics.optimistic_lock_conflicts;
  if (conflicts) {
    notes.push(`409 Conflict отримали ${pct(conflicts.values.rate)} PUT-запитів — це не помилки, а спрацювання optimistic locking при одночасному редагуванні.`);
  }
  return notes;
}

export const handleSummary = makeHandleSummary('load-test', `LOAD TEST (сходинки ${LEVELS.join(' → ')} VU)`, profile, analyze);
