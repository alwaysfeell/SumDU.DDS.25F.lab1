import { STRESS_THRESHOLDS } from '../config/endpoints.js';
import { setupSharedPlans, cleanupTestPlans, travelerJourney } from '../scenarios/traveler-journey.js';
import { buildProfile, phaseThresholds, enablePhaseTagging, setPhaseOverride } from '../utils/phases.js';
import { makeHandleSummary, TREND_STATS, describe, ms, num } from '../utils/summary.js';

const LEVELS = (__ENV.STRESS_LEVELS || '100,200,400,600,800,1000,1500,2000').split(',').map((v) => parseInt(v, 10));
const RECOVERY_VUS = LEVELS[0];

const stages = [];
let prev = 0;
for (const level of LEVELS) {
  stages.push({ dur: '30s', target: level, kind: 'ramp', desc: `Наростання ${prev}→${level} VU` });
  stages.push({ dur: '1m30s', target: level, kind: 'hold', desc: `Рівень ${level} VU` });
  prev = level;
}
stages.push({ dur: '30s', target: RECOVERY_VUS, kind: 'drop', desc: `Зниження ${prev}→${RECOVERY_VUS} VU` });
stages.push({ dur: '3m', target: RECOVERY_VUS, kind: 'recovery', desc: `Відновлення ${RECOVERY_VUS} VU` });
stages.push({ dur: '30s', target: 0, kind: 'down', desc: 'Зниження → 0 VU' });

const profile = buildProfile(stages);
enablePhaseTagging(profile);

export const options = {
  stages: profile.stages,
  thresholds: {
    ...STRESS_THRESHOLDS,
    ...phaseThresholds(profile),
  },
  summaryTrendStats: TREND_STATS,
  setupTimeout: '2m',
  teardownTimeout: '5m',
  userAgent: 'K6-StressTest/1.0',
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

function analyze(stats) {
  const holds = stats.filter((s) => s.phase.kind === 'hold');
  const recovery = stats.find((s) => s.phase.kind === 'recovery');
  const notes = [];
  if (holds.length === 0) return notes;

  const degradedIdx = holds.findIndex((h) => h.state !== 'OK');
  const brokenIdx = holds.findIndex((h) => h.state === 'ВІДМОВА');

  if (degradedIdx === -1) {
    notes.push(`Деградації не виявлено до ${holds[holds.length - 1].phase.target} VU включно — збільште рівні: -e STRESS_LEVELS=...`);
  } else {
    const d = holds[degradedIdx];
    const before = degradedIdx > 0 ? holds[degradedIdx - 1] : null;
    notes.push(`Деградація почалася на рівні ${d.phase.target} VU: ${describe(d)}.` +
      (before ? ` На попередньому рівні ${before.phase.target} VU: p95=${ms(before.p95)}, помилок ${(before.failRate * 100).toFixed(2)}%.` : ''));
  }

  if (brokenIdx === -1) {
    notes.push(`Точку відмови (p95 ≥ 2 s або помилок ≥ 5%) у межах тесту не досягнуто (максимум ${holds[holds.length - 1].phase.target} VU).`);
  } else {
    const b = holds[brokenIdx];
    notes.push(`Точка відмови (breaking point): ${b.phase.target} VU — ${describe(b)}.`);
  }

  let best = holds[0];
  holds.forEach((h) => { if (h.rps > best.rps) best = h; });
  notes.push(`Максимальна пропускна здатність ≈ ${num(best.rps, 1)} запитів/с (рівень ${best.phase.target} VU). Якщо далі RPS не росте, а час відповіді росте — сервер насичений, запити стоять у черзі.`);

  if (recovery) {
    const base = holds[0];
    const limit = Math.max(base.p95 * 2, base.p95 + 50);
    const recovered = recovery.state === 'OK' && recovery.p95 <= limit;
    notes.push(`Відновлення: на ${base.phase.target} VU до перевантаження p95=${ms(base.p95)}, після зниження навантаження (3 хв на ${recovery.phase.target} VU): ${describe(recovery)} → ` +
      (recovered ? 'система ВІДНОВИЛАСЯ.' : 'система НЕ відновилася повністю (див. графік у дашборді — коли саме повернулась норма).'));
  }
  return notes;
}

export const handleSummary = makeHandleSummary('stress-test', `STRESS TEST (рівні ${LEVELS.join(' → ')} VU, відновлення на ${RECOVERY_VUS} VU)`, profile, analyze);
