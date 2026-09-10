#!/usr/bin/env python3
"""Unit tests for daily_report's heat-pump cooling alert.

    cd pi && python3 test_cool_alert.py

Pure logic only (summarising `hvac_mode` intervals into cool runs and the
alert subject); nothing touches InfluxDB or Resend.
"""
import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone

for _name in ("httpx",):
    sys.modules.setdefault(_name, types.ModuleType(_name))
if "influxdb_client" not in sys.modules:
    _ic = types.ModuleType("influxdb_client")
    _ic.InfluxDBClient = object
    sys.modules["influxdb_client"] = _ic
if "matplotlib" not in sys.modules:
    _mpl = types.ModuleType("matplotlib")
    _mpl.use = lambda *a, **k: None
    sys.modules["matplotlib"] = _mpl
    sys.modules["matplotlib.pyplot"] = types.ModuleType("matplotlib.pyplot")
    sys.modules["matplotlib.ticker"] = types.ModuleType("matplotlib.ticker")
    sys.modules["matplotlib.dates"] = types.ModuleType("matplotlib.dates")

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
import daily_report as dr   # noqa: E402

UTC = timezone.utc
STEP = timedelta(minutes=5)


def iv(start: datetime, mode: str, kwh: float = 0.1) -> dict:
    return {"start": start, "mode": mode, "energy_kwh": kwh}


def timeline(start: datetime, modes: str) -> list[dict]:
    """'ccc.i' -> cool,cool,cool,(gap),idle at 5-min steps."""
    out = []
    for n, ch in enumerate(modes):
        if ch == ".":
            continue
        out.append(iv(start + n * STEP, {"c": "cool", "i": "idle", "h": "heat", "w": "hot_water"}[ch]))
    return out


class CoolStatsTest(unittest.TestCase):
    T0 = datetime(2026, 9, 9, 20, 35, tzinfo=UTC)   # 13:35 Pacific

    def test_no_cool_intervals(self):
        s = dr.cool_stats(timeline(self.T0, "iihhww"))
        self.assertEqual(s.minutes, 0)
        self.assertEqual(s.runs, 0)
        self.assertIsNone(s.first_start)

    def test_counts_minutes_runs_and_first_start(self):
        # two runs: 3 intervals, then (after idle) 2 intervals
        s = dr.cool_stats(timeline(self.T0, "cccicc"))
        self.assertEqual(s.minutes, 25)
        self.assertEqual(s.runs, 2)
        self.assertEqual(s.first_start, self.T0)
        self.assertAlmostEqual(s.kwh, 0.5)

    def test_timeline_gap_splits_a_run(self):
        s = dr.cool_stats(timeline(self.T0, "cc.cc"))
        self.assertEqual(s.runs, 2)
        self.assertEqual(s.minutes, 20)


class CoolAlertNeededTest(unittest.TestCase):
    def test_threshold_is_inclusive_15_minutes(self):
        self.assertFalse(dr.cool_alert_needed(dr.CoolStats(minutes=10, runs=1, kwh=0.1, first_start=None)))
        self.assertTrue(dr.cool_alert_needed(dr.CoolStats(minutes=15, runs=1, kwh=0.1, first_start=None)))


class RenderCoolEmailTest(unittest.TestCase):
    def test_subject_carries_duration_runs_and_local_first_start(self):
        stats = dr.CoolStats(minutes=90, runs=2, kwh=1.2,
                             first_start=datetime(2026, 9, 9, 20, 35, tzinfo=UTC))
        subject, html = dr.render_cool_email(date(2026, 9, 9), stats)
        self.assertEqual(subject, "❄️ Heat pump cooled 1h30m yesterday (2 runs, first 13:35)")
        self.assertIn("Wednesday, September 9", html)
        self.assertIn("1.2 kWh", html)

    def test_single_run_wording(self):
        stats = dr.CoolStats(minutes=20, runs=1, kwh=0.3,
                             first_start=datetime(2026, 9, 10, 13, 25, tzinfo=UTC))
        subject, _ = dr.render_cool_email(date(2026, 9, 10), stats)
        self.assertEqual(subject, "❄️ Heat pump cooled 20m yesterday (1 run, first 06:25)")


if __name__ == "__main__":
    unittest.main()
