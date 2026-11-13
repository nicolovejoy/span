"""Tests for attribution.py — pure run-grouping + bath predicate over the
classified hvac_mode timeline (#14 sub-project 2).

    cd pi && python3 test_attribution.py

Nothing here touches the network or a real InfluxDB.
"""
import sys
import types
import unittest
from datetime import datetime, timezone, timedelta
from unittest import mock

if "influxdb_client" not in sys.modules:
    _ic = types.ModuleType("influxdb_client")
    _ic.InfluxDBClient = object
    # A lambda factory, not the MagicMock class itself: `Point("weather")` must
    # return a fresh, unrestricted mock. Assigning the class directly would make
    # the call `Point("weather")` bind "weather" to MagicMock's `spec` kwarg,
    # which then rejects the `.field(...)` chain weather_poller.py relies on
    # (a plain string has no `.field` attribute for the spec to allow).
    _ic.Point = lambda *a, **k: mock.MagicMock()
    sys.modules["influxdb_client"] = _ic
    _wa = types.ModuleType("influxdb_client.client.write_api")
    _wa.SYNCHRONOUS = "sync"
    sys.modules["influxdb_client.client.write_api"] = _wa

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
import attribution as at   # noqa: E402

UTC = timezone.utc

def utc(*args):
    return datetime(*args, tzinfo=UTC)

def iv(start, mode, hp_mean=3200.0, aux_mean=0.0):
    return {"start": start, "mode": mode, "hp_mean_w": hp_mean, "hp_max_w": hp_mean,
            "aux_mean_w": aux_mean, "aux_max_w": aux_mean,
            "energy_kwh": (hp_mean + aux_mean) * 5 / 60 / 1000, "n_samples": 10}

def series(start, n, mode, **kw):
    return [iv(start + timedelta(minutes=5 * i), mode, **kw) for i in range(n)]

class RunsTest(unittest.TestCase):
    def test_groups_contiguous_same_mode(self):
        ivs = (series(utc(2026, 1, 10, 3, 0), 2, "idle")
               + series(utc(2026, 1, 10, 3, 10), 6, "hot_water")
               + series(utc(2026, 1, 10, 3, 40), 2, "heat"))
        out = at.runs(ivs, "hot_water")
        self.assertEqual(len(out), 1)
        self.assertEqual(len(out[0]), 6)

    def test_gap_breaks_a_run(self):
        ivs = (series(utc(2026, 1, 10, 3, 0), 3, "hot_water")
               + series(utc(2026, 1, 10, 3, 30), 3, "hot_water"))
        self.assertEqual(len(at.runs(ivs, "hot_water")), 2)

    def test_empty(self):
        self.assertEqual(at.runs([], "hot_water"), [])

class BathEventsTest(unittest.TestCase):
    def test_long_hot_water_run_is_a_bath_with_detector_schema(self):
        ivs = series(utc(2026, 1, 10, 3, 0), 6, "hot_water", hp_mean=3200.0, aux_mean=100.0)
        events = at.bath_events(ivs)
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev["start"], utc(2026, 1, 10, 3, 0))
        self.assertEqual(ev["end"], utc(2026, 1, 10, 3, 30))
        self.assertEqual(ev["duration_min"], 30.0)
        self.assertEqual(ev["hp_mean_power_w"], 3200.0)
        self.assertEqual(ev["hp_max_power_w"], 3200.0)
        self.assertTrue(ev["aux_active"])
        self.assertEqual(ev["aux_mean_power_w"], 100.0)
        # energy: sum of interval energies; cost via rates
        self.assertAlmostEqual(ev["energy_kwh"], 6 * 3300 * 5 / 60 / 1000, places=6)
        self.assertGreater(ev["cost_dollars"], 0)

    def test_edge_fragments_do_not_drag_a_bath_under_the_power_floor(self):
        # 8 x 2500 W core framed by low-power edge fragments: whole-run mean is
        # 2120 W (under the 2400 W floor), core mean is 2500 W -> still a bath,
        # reported over the whole run
        run = (series(utc(2026, 3, 1, 4, 0), 1, "hot_water", hp_mean=600.0)
               + series(utc(2026, 3, 1, 4, 5), 8, "hot_water", hp_mean=2500.0)
               + series(utc(2026, 3, 1, 4, 45), 1, "hot_water", hp_mean=600.0))
        events = at.bath_events(run)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["start"], utc(2026, 3, 1, 4, 0))
        self.assertEqual(events[0]["hp_mean_power_w"], 2500.0)
        self.assertEqual(events[0]["duration_min"], 40.0)

    def test_short_run_is_not_a_bath(self):
        ivs = series(utc(2026, 1, 10, 3, 0), 4, "hot_water")   # 20 min < 25
        self.assertEqual(at.bath_events(ivs), [])

    def test_weak_run_is_not_a_bath(self):
        ivs = series(utc(2026, 1, 10, 3, 0), 6, "hot_water", hp_mean=2000.0)
        self.assertEqual(at.bath_events(ivs), [])

    def test_aux_inactive_when_aux_near_zero(self):
        ivs = series(utc(2026, 1, 10, 3, 0), 6, "hot_water", aux_mean=0.0)
        self.assertFalse(at.bath_events(ivs)[0]["aux_active"])

    def test_shower_shaped_run_clears_duration_and_power_but_not_energy(self):
        # 5 intervals = 25 min (meets BATH_MIN_MINUTES exactly). hp_mean=2448 W
        # clears BATH_MEAN_POWER_MIN_W (2400). Total energy = 5 * 2448 * 5/60/1000
        # = 1.02 kWh, under BATH_MIN_KWH (1.5). This is a "shower" per the Phase 0
        # findings: duration and power alone can't separate it from a real bath,
        # only the energy floor does.
        ivs = series(utc(2026, 1, 10, 3, 0), 5, "hot_water", hp_mean=2448.0)
        self.assertEqual(len(ivs) * 5, at.BATH_MIN_MINUTES)
        self.assertGreaterEqual(2448.0, at.BATH_MEAN_POWER_MIN_W)
        total_kwh = sum(i["energy_kwh"] for i in ivs)
        self.assertAlmostEqual(total_kwh, 1.02, places=6)
        self.assertLess(total_kwh, at.BATH_MIN_KWH)
        self.assertEqual(at.bath_events(ivs), [])

    def test_run_just_above_the_energy_floor_is_a_bath(self):
        # Same 25-min duration, but hp_mean=3700 W pushes total energy to
        # ~1.54 kWh, just above BATH_MIN_KWH -- confirms the floor doesn't
        # simply reject every run.
        ivs = series(utc(2026, 1, 10, 3, 0), 5, "hot_water", hp_mean=3700.0)
        total_kwh = sum(i["energy_kwh"] for i in ivs)
        self.assertGreater(total_kwh, at.BATH_MIN_KWH)
        events = at.bath_events(ivs)
        self.assertEqual(len(events), 1)


if __name__ == "__main__":
    unittest.main()
