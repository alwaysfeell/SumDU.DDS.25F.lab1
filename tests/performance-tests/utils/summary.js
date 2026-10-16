import { BASE_URL } from '../config/endpoints.js';
import { HELPER_THRESHOLDS, formatDuration } from './phases.js';

export const SLA = {
  DEGRADED_P95: 500,
  DEGRADED_FAIL: 0.01,
  BROKEN_P95: 2000,
  BROKEN_FAIL: 0.05,
};

export const TREND_STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

function ms(v) {
  if (v === undefined || v === null || isNaN(v)) return '-';
  if (v >= 10000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${v.toFixed(v < 10 ? 2 : 1)}ms`;
}
function num(v, digits) {
  if (v === undefined || v === null || isNaN(v)) return '-';
  return v.toFixed(digits === undefined ? 0 : digits);
}
function pct(v) {
  if (v === undefined || v === null || isNaN(v)) return '-';
  return `${(v * 100).toFixed(2)}%`;
}
function bytes(v) {
  if (!v) return '0 B';
  if (v > 1e9) return `${(v / 1e9).toFixed(2)} GB`;
  if (v > 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v > 1e3) return `${(v / 1e3).toFixed(1)} kB`;
  return `${v} B`;
}
function padR(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}
function line(ch, n) {
  return ch.repeat(n);
}

function metric(data, name) {
  return data.metrics[name] ? data.metrics[name].values : undefined;
}

export function phaseStats(data, profile) {
  return profile.phases.map((p) => {
    const dur = metric(data, `http_req_duration{phase:${p.id}}`) || {};
    const failed = metric(data, `http_req_failed{phase:${p.id}}`) || {};
    const reqs = metric(data, `http_reqs{phase:${p.id}}`) || {};
    const conflicts = metric(data, `optimistic_lock_conflicts{phase:${p.id}}`) || {};
    const count = reqs.count || 0;
    const failRate = failed.rate || 0;
    const p95 = dur['p(95)'];
    let state = '-';
    if (count > 0) {
      if (p95 >= SLA.BROKEN_P95 || failRate >= SLA.BROKEN_FAIL) state = 'ВІДМОВА';
      else if (p95 >= SLA.DEGRADED_P95 || failRate >= SLA.DEGRADED_FAIL) state = 'ДЕГРАДАЦІЯ';
      else state = 'OK';
    }
    return {
      phase: p,
      count: count,
      rps: p.seconds > 0 ? count / p.seconds : 0,
      avg: dur.avg,
      med: dur.med,
      p95: p95,
      p99: dur['p(99)'],
      max: dur.max,
      failRate: failRate,
      failCount: Math.round(failRate * count),
      conflictRate: conflicts.rate,
      state: state,
    };
  });
}

function vuLabel(p) {
  return p.from === p.target ? `${p.target}` : `${p.from}→${p.target}`;
}

function phaseTable(stats) {
  const cols = [
    ['#', 3, 'L'], ['Фаза', 26, 'R'], ['VU', 10, 'L'], ['Трив.', 6, 'L'], ['Запитів', 8, 'L'],
    ['RPS', 6, 'L'], ['avg', 8, 'L'], ['p95', 8, 'L'], ['p99', 8, 'L'], ['max', 8, 'L'],
    ['Помилки', 8, 'L'], ['409', 7, 'L'], ['Стан', 11, 'R'],
  ];
  const fmt = (vals) =>
    vals.map((v, i) => (cols[i][2] === 'L' ? padL(v, cols[i][1]) : padR(v, cols[i][1]))).join(' ');
  const out = [];
  out.push(fmt(cols.map((c) => c[0])));
  out.push(line('-', cols.reduce((a, c) => a + c[1] + 1, 0)));
  stats.forEach((s, i) => {
    out.push(
      fmt([
        i + 1,
        s.phase.desc.length > 26 ? s.phase.desc.slice(0, 26) : s.phase.desc,
        vuLabel(s.phase),
        formatDuration(s.phase.seconds),
        s.count,
        num(s.rps, 1),
        ms(s.avg),
        ms(s.p95),
        ms(s.p99),
        ms(s.max),
        pct(s.failRate),
        s.conflictRate === undefined ? '-' : pct(s.conflictRate),
        s.state,
      ])
    );
  });
  return out.join('\n');
}

function aggregateValue(values, expr) {
  const m = expr.match(/^\s*([a-z]+(?:\(\d+(?:\.\d+)?\))?)/);
  if (!m) return undefined;
  return values[m[1]];
}

function thresholdLines(data) {
  const out = [];
  Object.keys(data.metrics).sort().forEach((name) => {
    const m = data.metrics[name];
    if (!m.thresholds) return;
    Object.keys(m.thresholds).forEach((expr) => {
      if (HELPER_THRESHOLDS.indexOf(expr) !== -1) return;
      const ok = m.thresholds[expr].ok;
      const v = aggregateValue(m.values, expr);
      let shown;
      if (v === undefined) shown = '-';
      else if (m.contains === 'time') shown = ms(v);
      else if (m.type === 'rate') shown = pct(v);
      else shown = num(v, 2);
      out.push(`  ${ok ? '✓' : '✗'} ${padR(name, 42)} ${padR(expr, 14)} факт: ${shown}`);
    });
  });
  return out;
}

export function renderSummary(data, testName, title, profile, analyze) {
  const W = 128;
  const out = [];
  const httpDur = metric(data, 'http_req_duration') || {};
  const readDur = metric(data, 'http_req_duration{type:read}');
  const writeDur = metric(data, 'http_req_duration{type:write}');
  const failed = metric(data, 'http_req_failed') || {};
  const reqs = metric(data, 'http_reqs') || {};
  const checks = metric(data, 'checks') || {};
  const iters = metric(data, 'iterations') || {};
  const vusMax = metric(data, 'vus_max') || {};
  const conflicts = metric(data, 'optimistic_lock_conflicts');
  const retries = metric(data, 'optimistic_lock_retries');
  const gaveUp = metric(data, 'optimistic_lock_gave_up');
  const apiErr = metric(data, 'api_errors');
  const recv = metric(data, 'data_received') || {};
  const sent = metric(data, 'data_sent') || {};
  const durationSec = data.state.testRunDurationMs / 1000;

  out.push('');
  out.push(line('=', W));
  out.push(`  TravelerAPI · k6 · ${title}`);
  out.push(line('=', W));
  out.push(`  Дата: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC    Тривалість: ${formatDuration(durationSec)}    Макс. VU: ${vusMax.max || vusMax.value || '-'}    API: ${BASE_URL}`);
  out.push('');

  const th = thresholdLines(data);
  if (th.length > 0) {
    out.push('ПОРОГИ (thresholds)');
    th.forEach((l) => out.push(l));
    out.push('');
  }

  out.push('ЗАГАЛЬНІ МЕТРИКИ (весь тест)');
  out.push(`  http_reqs ................ ${reqs.count || 0} запитів, ${num(reqs.rate, 1)} запитів/с`);
  out.push(`  http_req_duration ........ avg=${ms(httpDur.avg)}  med=${ms(httpDur.med)}  p(90)=${ms(httpDur['p(90)'])}  p(95)=${ms(httpDur['p(95)'])}  p(99)=${ms(httpDur['p(99)'])}  max=${ms(httpDur.max)}`);
  if (readDur) out.push(`    { type:read } .......... avg=${ms(readDur.avg)}  p(95)=${ms(readDur['p(95)'])}  max=${ms(readDur.max)}`);
  if (writeDur) out.push(`    { type:write } ......... avg=${ms(writeDur.avg)}  p(95)=${ms(writeDur['p(95)'])}  max=${ms(writeDur.max)}`);
  out.push(`  http_req_failed .......... ${pct(failed.rate)}  (${failed.passes || 0} з ${(failed.passes || 0) + (failed.fails || 0)})`);
  if (apiErr) out.push(`  api_errors ............... ${pct(apiErr.rate)}  (неочікуваний HTTP-статус)`);
  out.push(`  checks ................... ${pct(checks.rate)}  (${checks.passes || 0} успішних, ${checks.fails || 0} невдалих)`);
  if (conflicts) out.push(`  optimistic_lock_conflicts  ${pct(conflicts.rate)} PUT-запитів отримали 409 Conflict`);
  if (retries) out.push(`  optimistic_lock_retries .. ${retries.count} повторів після 409`);
  if (gaveUp) out.push(`  optimistic_lock_gave_up .. ${gaveUp.count} змін не збережено після всіх повторів`);
  out.push(`  iterations (сесій) ....... ${iters.count || 0}  (${num(iters.rate, 2)}/с)`);
  out.push(`  data_received / sent ..... ${bytes(recv.count)} / ${bytes(sent.count)}`);
  out.push('');

  let stats = [];
  if (profile) {
    stats = phaseStats(data, profile);
    out.push('МЕТРИКИ ПО ФАЗАХ  (час — http_req_duration; "Помилки" — http_req_failed; "409" — частка PUT з конфліктом версій)');
    out.push(phaseTable(stats));
    out.push(`  Стан: OK — p95 < ${SLA.DEGRADED_P95} ms і помилок < ${SLA.DEGRADED_FAIL * 100}%;  ДЕГРАДАЦІЯ — p95 ≥ ${SLA.DEGRADED_P95} ms або помилок ≥ ${SLA.DEGRADED_FAIL * 100}%;  ВІДМОВА — p95 ≥ ${SLA.BROKEN_P95} ms або помилок ≥ ${SLA.BROKEN_FAIL * 100}%`);
    out.push('');
  }

  if (analyze) {
    const notes = analyze(stats, data);
    if (notes && notes.length > 0) {
      out.push('ВИСНОВКИ ДЛЯ ЗВІТУ (обчислено автоматично з метрик цього запуску)');
      notes.forEach((n) => out.push(`  • ${n}`));
      out.push('');
    }
  }

  out.push(`Файли: reports/${testName}-summary.txt, reports/${testName}-summary.json`);
  out.push(line('=', W));
  out.push('');
  return out.join('\n');
}

export function makeHandleSummary(testName, title, profile, analyze) {
  return function (data) {
    const text = renderSummary(data, testName, title, profile, analyze);
    const result = {
      stdout: text,
    };
    result[`reports/${testName}-summary.txt`] = text;
    result[`reports/${testName}-summary.json`] = JSON.stringify(data, null, 2);
    return result;
  };
}

export function describe(s) {
  return `avg=${ms(s.avg)}, p95=${ms(s.p95)}, max=${ms(s.max)}, помилок ${pct(s.failRate)} (${s.failCount} з ${s.count}), ${num(s.rps, 1)} запитів/с`;
}
export { ms, pct, num };
