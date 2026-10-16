# TravelerAPI — k6 performance tests

Тести продуктивності TravelerAPI на [k6](https://grafana.com/docs/k6/latest/).
Основа — https://github.com/potapuff/SumDU.DDS.25F.lab2

## Запуск

API: `http://127.0.0.1:4567` (`config/endpoints.js`, або `-e API_URL=...`).

```
k6 run tests/smoke-test.js
k6 run tests/load-test.js
```

З HTML-дашбордом: `run.bat load-test`

## Тести

| Файл | Тип | Профіль | Тривалість |
|---|---|---|---|
| `tests/smoke-test.js` | Smoke | 2 → 5 VU | 20 с |
| `tests/load-test.js` | Load | 50 → 100 → 200 → 300 VU | 17 хв |
| `tests/stress-test.js` | Stress | 100 → … → 2000 VU, відновлення на 100 VU | 20 хв |
| `tests/spike-test.js` | Spike | 100 → 2000 → 100 VU | 8 хв |
| `tests/endurance-test.js` | Endurance | 100 VU | 30 хв |

Load, stress, spike і endurance використовують спільний сценарій `scenarios/traveler-journey.js`.

Параметри: `LOAD_LEVELS`, `STRESS_LEVELS`, `BASE_VUS`, `SPIKE_VUS`, `ENDURANCE_VUS`, `SHARED_PLANS`, `REQ_TIMEOUT`, `QUICK`, `VERBOSE`.

## Результати

`reports/` — `*-summary.txt`, `*-summary.json`, `*-dashboard.html`, `endurance-memory.csv` (`monitor.ps1`).
