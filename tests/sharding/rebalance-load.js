import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:4567';
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

export const options = {
  vus: parseInt(__ENV.VUS || '20', 10),
  duration: __ENV.DURATION || '90s',
  thresholds: {
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export default function () {
  const created = http.post(`${BASE}/api/travel-plans`,
    JSON.stringify({ title: `rebalance ${__VU}-${__ITER}`, budget: 100 }), JSON_HEADERS);
  if (!check(created, { 'plan created (201)': (r) => r.status === 201 })) return;
  const id = created.json('id');

  const location = http.post(`${BASE}/api/travel-plans/${id}/locations`,
    JSON.stringify({ name: 'Stop 1' }), JSON_HEADERS);
  check(location, { 'location added (201)': (r) => r.status === 201 });

  const updated = http.put(`${BASE}/api/travel-plans/${id}`,
    JSON.stringify({ budget: 150, version: 1 }), JSON_HEADERS);
  check(updated, { 'plan updated (200)': (r) => r.status === 200 });

  const read = http.get(`${BASE}/api/travel-plans/${id}`);
  check(read, {
    'plan read (200)': (r) => r.status === 200,
    'location is with the plan': (r) => r.status === 200 && r.json('locations').length === 1,
  });

  if (__ITER % 2 === 0) {
    const removed = http.del(`${BASE}/api/travel-plans/${id}`);
    check(removed, { 'plan deleted (204)': (r) => r.status === 204 });
  }
  sleep(0.2);
}
