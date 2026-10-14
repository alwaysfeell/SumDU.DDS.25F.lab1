import json
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4567"
results_ok = True


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else None)


def run_simultaneously(funcs):
    barrier = threading.Barrier(len(funcs))

    def wrapper(f):
        barrier.wait()
        return f()

    with ThreadPoolExecutor(max_workers=len(funcs)) as ex:
        return list(ex.map(wrapper, funcs))


def check(name, condition, details=""):
    global results_ok
    results_ok &= condition
    print(f"  [{'OK' if condition else 'FAIL'}] {name}" + (f" — {details}" if details else ""))


def problem1_concurrent_plan_updates(n=20):
    print(f"\nПроблема 1: {n} користувачів одночасно оновлюють план з version=1")
    _, plan = call("POST", "/api/travel-plans", {"title": "Європа", "budget": 2000})
    pid = plan["id"]
    funcs = [lambda i=i: call("PUT", f"/api/travel-plans/{pid}",
                              {"budget": 2000 + i, "version": 1}) for i in range(n)]
    statuses = [s for s, _ in run_simultaneously(funcs)]
    _, final = call("GET", f"/api/travel-plans/{pid}")
    check("рівно один запит успішний (200)", statuses.count(200) == 1, f"200: {statuses.count(200)}")
    check("решта отримали 409 Conflict", statuses.count(409) == n - 1, f"409: {statuses.count(409)}")
    check("фінальна версія = 2", final["version"] == 2, f"version={final['version']}")
    call("DELETE", f"/api/travel-plans/{pid}")


def problem2_concurrent_location_inserts(n=30):
    print(f"\nПроблема 2: {n} користувачів одночасно додають локацію в один план")
    _, plan = call("POST", "/api/travel-plans", {"title": "Auto-order test"})
    pid = plan["id"]
    funcs = [lambda i=i: call("POST", f"/api/travel-plans/{pid}/locations",
                              {"name": f"City {i}"}) for i in range(n)]
    statuses = [s for s, _ in run_simultaneously(funcs)]
    _, final = call("GET", f"/api/travel-plans/{pid}")
    orders = sorted(loc["visit_order"] for loc in final["locations"])
    check("усі запити успішні (201)", statuses.count(201) == n, f"201: {statuses.count(201)}")
    check(f"номери 1..{n} без дублікатів і пропусків", orders == list(range(1, n + 1)),
          f"унікальних номерів: {len(set(orders))}")
    call("DELETE", f"/api/travel-plans/{pid}")


def problem3_concurrent_location_updates():
    print("\nПроблема 3: A змінює budget, B одночасно змінює notes однієї локації")
    _, plan = call("POST", "/api/travel-plans", {"title": "Location update test"})
    pid = plan["id"]
    _, loc = call("POST", f"/api/travel-plans/{pid}/locations",
                  {"name": "Paris", "budget": 50, "notes": "Book tickets"})
    lid = loc["id"]
    results = run_simultaneously([
        lambda: call("PUT", f"/api/locations/{lid}", {"budget": 75}),
        lambda: call("PUT", f"/api/locations/{lid}", {"notes": "Tickets booked!"}),
    ])
    _, final = call("GET", f"/api/travel-plans/{pid}")
    final_loc = final["locations"][0]
    check("обидва запити успішні", [s for s, _ in results] == [200, 200])
    check("budget = 75 (зміна A не втрачена)", final_loc["budget"] == 75.0, str(final_loc["budget"]))
    check("notes = 'Tickets booked!' (зміна B не втрачена)",
          final_loc["notes"] == "Tickets booked!", final_loc["notes"])
    call("DELETE", f"/api/travel-plans/{pid}")


def latency_test(requests=500, workers=20):
    print(f"\nШвидкодія: {requests} запитів, {workers} паралельних потоків")
    _, plan = call("POST", "/api/travel-plans", {"title": "Latency test"})
    pid = plan["id"]
    for i in range(5):
        call("POST", f"/api/travel-plans/{pid}/locations", {"name": f"Stop {i}"})

    def one(_):
        started = time.perf_counter()
        status, _ = call("GET", f"/api/travel-plans/{pid}")
        return status, (time.perf_counter() - started) * 1000

    with ThreadPoolExecutor(max_workers=workers) as ex:
        timings = list(ex.map(one, range(requests)))
    ms = sorted(t for _, t in timings)
    p95 = ms[int(len(ms) * 0.95) - 1]
    print(f"  середнє: {statistics.mean(ms):.1f} ms, медіана: {statistics.median(ms):.1f} ms, "
          f"p95: {p95:.1f} ms, максимум: {ms[-1]:.1f} ms")
    check("усі відповіді 200", all(s == 200 for s, _ in timings))
    check("95% запитів швидше за 200 ms", p95 < 200, f"p95 = {p95:.1f} ms")
    call("DELETE", f"/api/travel-plans/{pid}")


if __name__ == "__main__":
    print(f"API: {BASE}")
    problem1_concurrent_plan_updates()
    problem2_concurrent_location_inserts()
    problem3_concurrent_location_updates()
    latency_test()
    print("\nРЕЗУЛЬТАТ:", "УСІ ПЕРЕВІРКИ ПРОЙДЕНО" if results_ok else "Є ПОМИЛКИ")
    sys.exit(0 if results_ok else 1)
