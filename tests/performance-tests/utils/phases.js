import exec from 'k6/execution';
import { setRequestHook } from './api-client.js';

const QUICK = !!__ENV.QUICK;

export function toSeconds(duration) {
  const re = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let total = 0;
  let match;
  while ((match = re.exec(duration)) !== null) {
    const value = parseFloat(match[1]);
    total += match[2] === 'h' ? value * 3600 : match[2] === 'm' ? value * 60 : value;
  }
  return total;
}

export function formatDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest}s`;
  return rest === 0 ? `${m}m` : `${m}m${rest}s`;
}

export function buildProfile(stages) {
  let t = 0;
  let prev = 0;
  const phases = stages.map((st, i) => {
    let seconds = toSeconds(st.dur);
    if (QUICK) seconds = Math.max(3, Math.round(seconds / 10));
    const id = `s${String(i + 1).padStart(2, '0')}_${st.kind}_${st.target}`;
    const phase = {
      id: id,
      kind: st.kind,
      desc: st.desc,
      from: prev,
      target: st.target,
      start: t,
      end: t + seconds,
      seconds: seconds,
    };
    t += seconds;
    prev = st.target;
    return phase;
  });
  return {
    phases: phases,
    stages: phases.map((p) => ({ duration: `${p.seconds}s`, target: p.target })),
    totalSeconds: t,
  };
}

export const HELPER_THRESHOLDS = ['max>=0', 'rate>=0', 'count>=0'];

export function phaseThresholds(profile) {
  const th = {};
  for (const p of profile.phases) {
    th[`http_req_duration{phase:${p.id}}`] = ['max>=0'];
    th[`http_req_failed{phase:${p.id}}`] = ['rate>=0'];
    th[`http_reqs{phase:${p.id}}`] = ['count>=0'];
    th[`optimistic_lock_conflicts{phase:${p.id}}`] = ['rate>=0'];
  }
  return th;
}

let override = null;

export function setPhaseOverride(name) {
  override = name;
}

function currentPhaseId(profile) {
  if (override) return override;
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  for (const p of profile.phases) {
    if (elapsed < p.end) return p.id;
  }
  return 'graceful_stop';
}

export function enablePhaseTagging(profile) {
  setRequestHook(() => {
    try {
      exec.vu.metrics.tags.phase = currentPhaseId(profile);
    } catch (e) {
    }
  });
}
