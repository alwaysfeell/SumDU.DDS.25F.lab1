import { STRESS_THRESHOLDS } from '../config/endpoints.js';
import { setupSharedPlans, cleanupTestPlans, travelerJourney } from '../scenarios/traveler-journey.js';
import { buildProfile, phaseThresholds, enablePhaseTagging, setPhaseOverride } from '../utils/phases.js';
import { makeHandleSummary, TREND_STATS, describe, ms, pct } from '../utils/summary.js';

const BASE_VUS = parseInt(__ENV.BASE_VUS || '100', 10);
const SPIKE_VUS = parseInt(__ENV.SPIKE_VUS || '2000', 10);

const profile = buildProfile([
  { dur: '1m', target: BASE_VUS, kind: 'warmup', desc: `Розігрів 0→${BASE_VUS} VU` },
  { dur: '2m', target: BASE_VUS, kind: 'base', desc: `Базовий рівень ${BASE_VUS} VU` },
  { dur: '20s', target: SPIKE_VUS, kind: 'spikeup', desc: `СПЛЕСК ${BASE_VUS}→${SPIKE_VUS} VU` },
  { dur: '1m', target: SPIKE_VUS, kind: 'spike', desc: `Пік ${SPIKE_VUS} VU` },
  { dur: '20s', target: BASE_VUS, kind: 'spikedown', desc: `Падіння ${SPIKE_VUS}→${BASE_VUS} VU` },
  { dur: '30s', target: BASE_VUS, kind: 'rec1', desc: 'Відновлення 0–30 с' },
  { dur: '30s', target: BASE_VUS, kind: 'rec2', desc: 'Відновлення 30–60 с' },
  { dur: '1m', target: BASE_VUS, kind: 'rec3', desc: 'Відновлення 1–2 хв' },
  { dur: '1m', target: BASE_VUS, kind: 'rec4', desc: 'Відновлення 2–3 хв' },
  { dur: '20s', target: 0, kind: 'down', desc: 'Зниження → 0 VU' },
]);
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
  userAgent: 'K6-SpikeTest/1.0',
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
  const by = (kind) => stats.find((s) => s.phase.kind === kind);
  const base = by('base');
  const spikePhases = stats.filter((s) => ['spikeup', 'spike', 'spikedown'].indexOf(s.phase.kind) !== -1);
  const recs = stats.filter((s) => s.phase.kind.indexOf('rec') === 0);
  const notes = [];
  if (!base) return notes;

  notes.push(`Базовий рівень (${BASE_VUS} VU): ${describe(base)}.`);
  const peak = by('spike');
  if (peak) notes.push(`Під час піку (${SPIKE_VUS} VU): ${describe(peak)}.`);

  let total = 0;
  let lost = 0;
  let worstP95 = 0;
  spikePhases.forEach((s) => { total += s.count; lost += s.failCount; worstP95 = Math.max(worstP95, s.p95 || 0); });
  notes.push(lost > 0
    ? `Під час сплеску (наростання + пік + падіння) втрачено ${lost} з ${total} запитів (${pct(total ? lost / total : 0)}): помилки 5xx, розриви з'єднань або тайм-аути > 10 s.`
    : `Під час сплеску жоден запит не втрачено (${total} запитів, 0 помилок); найгірший p95 у фазах сплеску = ${ms(worstP95)} (на базовому рівні ${ms(base.p95)}).`);

  const limit = Math.max(base.p95 * 2, base.p95 + 50);
  const ends = { rec1: '30 с', rec2: '60 с', rec3: '2 хв', rec4: '3 хв' };
  const firstOk = recs.find((r) => r.count > 0 && r.p95 <= limit && r.failRate < 0.01);
  if (firstOk) {
    const idx = recs.indexOf(firstOk);
    notes.push(idx === 0
      ? `Час відновлення: ≤ 30 с — вже у вікні «${firstOk.phase.desc}» p95=${ms(firstOk.p95)} (норма: ≤ ${ms(limit)}, тобто ≤ 2× базового p95).`
      : `Час відновлення: ≈ ${ends[recs[idx - 1].phase.kind]}–${ends[firstOk.phase.kind]} після падіння навантаження — у вікні «${firstOk.phase.desc}» p95=${ms(firstOk.p95)} повернувся до норми (≤ ${ms(limit)}).`);
  } else {
    notes.push(`За 3 хв після сплеску система НЕ повернулася до базових показників (p95 не опустився до ${ms(limit)} або є помилки).`);
  }
  notes.push(`p95 у вікнах відновлення: ${recs.map((r) => `${r.phase.desc.replace('Відновлення ', '')}: ${ms(r.p95)}`).join(';  ')}.`);
  return notes;
}

export const handleSummary = makeHandleSummary('spike-test', `SPIKE TEST (${BASE_VUS} → ${SPIKE_VUS} → ${BASE_VUS} VU)`, profile, analyze);
