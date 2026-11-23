#!/usr/bin/env python3
"""Read-only backtest of the daily anomaly check (alert-floor rule) on the Pi's data.

From the worktree on the laptop (one line):
  python3 pi/tools/alert_backtest.py --bundle | ssh nico@phrpi.local 'cd /home/nico/SPAN/pi && docker compose run --rm --no-deps -T -e DRY_RUN=1 daily-report python - 2026-09-24 2026-11-22'

--bundle prints this script with this branch's daily_report.py, report_baseline.py,
email_kit.py and categories.json embedded; inside the container they shadow /app's copies.
Reads Influx only. Suppression state is simulated in memory from FIRST-28 days.
"""
import sys
from pathlib import Path

BUNDLE_FILES = ("daily_report.py", "report_baseline.py", "email_kit.py", "categories.json")

if __name__ == "__main__" and "--bundle" in sys.argv:
    pi_dir = Path(__file__).resolve().parent.parent
    print("BUNDLED = " + repr({n: (pi_dir / n).read_text() for n in BUNDLE_FILES}))
    print(Path(__file__).read_text())
    sys.exit(0)

import os
import tempfile
from datetime import date, timedelta

os.environ["DRY_RUN"] = "1"
BUNDLED = globals().get("BUNDLED", {})
if BUNDLED:
    tmp = Path(tempfile.mkdtemp(prefix="alertbt-"))
    for name, src in BUNDLED.items():
        (tmp / name).write_text(src)
    sys.path.insert(0, str(tmp))
sys.path.append("/app")

import daily_report as dr          # noqa: E402
import report_baseline as rb       # noqa: E402
from influxdb_client import InfluxDBClient   # noqa: E402


def part_str(p):
    if p is None:
        return "-"
    tag = "unusual" if p.result.is_anomalous else "normal"
    return (f"{p.name}[{p.basis} n={p.baseline.n}] {p.value:.1f} vs {p.baseline.median:.1f} "
            f"({p.excess_kwh:+.1f}, {tag})")


def main(first: date, last: date):
    warm = first - timedelta(days=28)
    lo = warm - timedelta(days=rb.SIMILAR_LOOKBACK_DAYS)
    start = dr.flux_ts(dr.local_day_utc_range(lo)[0])
    stop = dr.flux_ts(dr.local_day_utc_range(last + timedelta(days=1))[0])
    client = InfluxDBClient(url=dr.INFLUXDB_URL, token=dr.INFLUXDB_TOKEN, org=dr.INFLUXDB_ORG)
    qa = client.query_api()
    day_cat = dr.category_day_kwh(dr.query_daily_circuit_counter_kwh(qa, start, stop))
    hw = dr.query_daily_hot_water_kwh(qa, start, stop)
    temps = dr.query_daily_temps_f(qa, start, stop)

    state: dict[str, rb.SuppressionState] = {}
    alert_days = []
    d = warm
    while d <= last:
        report = d >= first
        cov = dr.query_day_coverage(qa, d)
        if not rb.day_coverage_ok(cov):
            if report:
                print(f"{d} coverage {cov:.0%}: suppressed")
            d += timedelta(days=1)
            continue
        fired = []
        hvac_line = ""
        for v in dr.evaluate_day(d, day_cat, hw, temps):
            if v.action == "skip":
                continue
            if v.action == "clear":
                state.pop(v.category, None)
                continue
            if v.category == "HVAC":
                if v.hvac is not None:
                    j = v.hvac
                    hvac_line = (f" | {part_str(j.space)} | {part_str(j.hot_water)} | combined "
                                 f"{j.combined_kwh:+.1f} kWh ${abs(j.combined_kwh) * dr.ENERGY_RATE:.2f}")
                else:
                    ex = v.value - v.baseline.median
                    hvac_line = f" | whole-HVAC fallback {ex:+.1f} kWh ${abs(ex) * dr.ENERGY_RATE:.2f}"
            st = state.get(v.category) or rb.SuppressionState(None, None)
            if v.result.is_anomalous:
                if rb.should_alert(v.result, st):
                    since = st.since if st.last_alert_date is not None else d
                    state[v.category] = rb.SuppressionState(d, v.result.z, since)
                    ex = v.value - v.baseline.median
                    fired.append(f"{v.category} {ex:+.1f} kWh ${abs(ex) * dr.ENERGY_RATE:.2f}")
            else:
                state.pop(v.category, None)
        if report:
            t = temps.get(d)
            hvac = day_cat.get(d, {}).get("HVAC", 0.0)
            print(f"{d} {d.strftime('%a')} {'-' if t is None else f'{t:.1f}F'} "
                  f"HVAC {hvac:.1f} (hw {hw.get(d, float('nan')):.1f}){hvac_line}"
                  f"{' || ALERT ' + '; '.join(fired) if fired else ''}")
            if fired:
                alert_days.append(d.isoformat())
        d += timedelta(days=1)
    print(f"ALERT DAYS ({len(alert_days)}): {alert_days}")
    client.close()


if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if not x.startswith("-")]
    main(date.fromisoformat(a[0]), date.fromisoformat(a[1]))
