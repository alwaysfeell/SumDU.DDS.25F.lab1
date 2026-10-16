import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import { setupSharedPlans, cleanupTestPlans, travelerJourney } from '../scenarios/traveler-journey.js';
import { buildProfile, phaseThresholds, enablePhaseTagging, setPhaseOverride } from '../utils/phases.js';
import { makeHandleSummary, TREND_STATS, ms, pct, num } from '../utils/summary.js';

const VUS = parseInt(__ENV.ENDURANCE_VUS || '100', 10);
const WINDOWS = 7;
const WINDOW_MIN = 4;

const stages = [{ dur: '1m', target: VUS, kind: 'ramp', desc: `Наростання 0→${VUS} VU` }];
for (let i = 0; i < WINDOWS; i++) {
  stages.push({ dur: `${WINDOW_MIN}m`, target: VUS, kind: `win${i + 1}`, desc: `Хвилини ${1 + i * WINDOW_MIN}–${1 + (i + 1) * WINDOW_MIN}` });
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
  userAgent: 'K6-EnduranceTest/1.0',
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
  const wins = stats.filter((s) => s.phase.kind.indexOf('win') === 0 && s.count > 0);
  const notes = [];
  if (wins.length < 2) return notes;

  const first = wins[0];
  const last = wins[wins.length - 1];
  const p95s = wins.map((w) => w.p95);
  const avgP95 = p95s.reduce((a, b) => a + b, 0) / p95s.length;
  const minP95 = Math.min(...p95s);
  const maxP95 = Math.max(...p95s);
  const change = first.p95 > 0 ? (last.p95 - first.p95) / first.p95 : 0;
  const rpsList = wins.map((w) => w.rps);

  notes.push(`p95 по 4-хвилинних вікнах: ${wins.map((w) => ms(w.p95)).join(' → ')}.`);
  notes.push(`Зміна p95 між першим і останнім вікном: ${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}% (${ms(first.p95)} → ${ms(last.p95)}); розкид між вікнами ${ms(minP95)}…${ms(maxP95)} (±${num(((maxP95 - minP95) / 2 / avgP95) * 100, 1)}% від середнього).`);
  notes.push(`Пропускна здатність по вікнах: ${rpsList.map((r) => num(r, 1)).join(' → ')} запитів/с; помилки по вікнах: ${wins.map((w) => pct(w.failRate)).join(' → ')}.`);

  const degraded = (last.p95 > first.p95 * 1.5 && last.p95 - first.p95 > 20) || last.failRate - first.failRate > 0.01;
  notes.push(degraded
    ? 'Висновок: спостерігається ДЕГРАДАЦІЯ з часом — p95 або помилки помітно зросли до кінця тесту (перевірте пам\'ять у reports/endurance-memory.csv).'
    : 'Висновок: деградації з часом НЕ виявлено — p95, RPS і рівень помилок стабільні протягом усього тесту.');

  const failed = data.metrics.http_req_failed ? data.metrics.http_req_failed.values : { rate: 0, passes: 0 };
  notes.push(`Помилок за 30 хв: ${pct(failed.rate)} (${failed.passes} запитів).`);
  return notes;
}

export const handleSummary = makeHandleSummary('endurance-test', `ENDURANCE TEST (${VUS} VU, ${WINDOWS * WINDOW_MIN + 2} хв)`, profile, analyze);
