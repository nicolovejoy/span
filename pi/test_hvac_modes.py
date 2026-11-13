"""Tests for hvac_modes.py — pure HVAC mode classification (#14 sub-project 2).

    cd pi && python3 test_hvac_modes.py

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
import hvac_modes as hm   # noqa: E402

UTC = timezone.utc

def utc(*args):
    return datetime(*args, tzinfo=UTC)

def samples(start, seconds_step, powers):
    """[(t0, p0), (t0+step, p1), ...] as sample dicts."""
    return [{"time": start + timedelta(seconds=i * seconds_step), "power": p}
            for i, p in enumerate(powers)]

class BucketIntervalsTest(unittest.TestCase):
    def test_buckets_align_to_5min_boundaries_and_carry_stats(self):
        start = utc(2026, 8, 20, 10, 0)
        hp = samples(start, 30, [3000.0] * 10)          # 10:00:00–10:04:30
        aux = samples(start, 30, [0.0] * 10)
        out = hm.bucket_intervals(hp, aux, start, start + timedelta(minutes=5))
        self.assertEqual(len(out), 1)
        iv = out[0]
        self.assertEqual(iv["start"], utc(2026, 8, 20, 10, 0))
        self.assertEqual(iv["hp_mean_w"], 3000.0)
        self.assertEqual(iv["hp_max_w"], 3000.0)
        self.assertEqual(iv["hp_duty"], 1.0)
        self.assertEqual(iv["hp_transitions"], 0)
        self.assertEqual(iv["aux_mean_w"], 0.0)
        self.assertEqual(iv["n_samples"], 10)
        # (3000 + 0) W * 5 min = 0.25 kWh
        self.assertAlmostEqual(iv["energy_kwh"], 0.25, places=6)

    def test_negative_power_is_absed(self):
        start = utc(2026, 8, 20, 10, 0)
        hp = samples(start, 30, [-3000.0] * 10)
        out = hm.bucket_intervals(hp, [], start, start + timedelta(minutes=5))
        self.assertEqual(out[0]["hp_mean_w"], 3000.0)

    def test_duty_and_transitions_count_crossings_of_idle_threshold(self):
        start = utc(2026, 8, 20, 10, 0)
        # on, on, off, off, on -> duty 3/5, transitions 2 (on->off, off->on)
        hp = samples(start, 60, [3000.0, 3000.0, 0.0, 0.0, 3000.0])
        out = hm.bucket_intervals(hp, [], start, start + timedelta(minutes=5))
        self.assertEqual(out[0]["hp_duty"], 0.6)
        self.assertEqual(out[0]["hp_transitions"], 2)

    def test_gap_interval_is_omitted_not_zeroed(self):
        start = utc(2026, 8, 20, 10, 0)
        hp = samples(start, 30, [3000.0] * 10)  # only the first 5 min has data
        out = hm.bucket_intervals(hp, [], start, start + timedelta(minutes=15))
        self.assertEqual([iv["start"] for iv in out], [utc(2026, 8, 20, 10, 0)])

    def test_unaligned_start_is_floored_to_boundary(self):
        # start 10:02 -> first bucket is 10:00 (samples before `start` excluded anyway)
        start = utc(2026, 8, 20, 10, 2)
        hp = samples(start, 30, [3000.0] * 6)
        out = hm.bucket_intervals(hp, [], start, utc(2026, 8, 20, 10, 5))
        self.assertEqual(out[0]["start"], utc(2026, 8, 20, 10, 0))


def iv(start, hp_mean, duty=1.0, transitions=0, aux_mean=0.0):
    """Interval dict factory with sane defaults for classification tests."""
    return {"start": start, "hp_mean_w": hp_mean, "hp_max_w": hp_mean,
            "hp_duty": duty, "hp_transitions": transitions,
            "aux_mean_w": aux_mean, "aux_max_w": aux_mean,
            "energy_kwh": (hp_mean + aux_mean) * 5 / 60 / 1000, "n_samples": 10}

def series(start, n, **kw):
    return [iv(start + timedelta(minutes=5 * i), **kw) for i in range(n)]

COLD = [{"time": utc(2026, 1, 10, h), "temp_f": 35.0} for h in range(24)]
HOT = [{"time": utc(2026, 7, 10, h), "temp_f": 85.0} for h in range(24)]
MILD = [{"time": utc(2026, 4, 10, h), "temp_f": 62.0} for h in range(24)]

class TempAtTest(unittest.TestCase):
    def test_nearest_reading_within_staleness_window(self):
        self.assertEqual(hm.temp_at(COLD, utc(2026, 1, 10, 3, 20)), 35.0)

    def test_none_when_no_reading_close_enough(self):
        self.assertIsNone(hm.temp_at(COLD, utc(2026, 1, 12, 3)))

    def test_none_on_empty(self):
        self.assertIsNone(hm.temp_at([], utc(2026, 1, 10, 3)))

class ClassifyTest(unittest.TestCase):
    def test_low_power_is_idle_regardless_of_weather(self):
        out = hm.classify(series(utc(2026, 1, 10, 3), 3, hp_mean=10.0), COLD)
        self.assertEqual([i["mode"] for i in out], ["idle"] * 3)

    def test_sustained_high_power_on_cold_day_is_heat(self):
        # 3 hours of steady 3kW: too long for a DHW reheat -> space heating
        out = hm.classify(series(utc(2026, 1, 10, 3), 36, hp_mean=3000.0), COLD)
        self.assertEqual({i["mode"] for i in out}, {"heat"})

    def test_sustained_high_power_on_hot_day_is_cool(self):
        out = hm.classify(series(utc(2026, 7, 10, 3), 36, hp_mean=3000.0), HOT)
        self.assertEqual({i["mode"] for i in out}, {"cool"})

    def test_bounded_high_power_run_is_hot_water_in_any_season(self):
        for weather, month in ((COLD, 1), (HOT, 7)):
            # 30 min of DHW-shaped draw framed by idle
            run = (series(utc(2026, month, 10, 3, 0), 2, hp_mean=10.0)
                   + series(utc(2026, month, 10, 3, 10), 6, hp_mean=3200.0)
                   + series(utc(2026, month, 10, 3, 40), 2, hp_mean=10.0))
            out = hm.classify(run, weather)
            self.assertEqual([i["mode"] for i in out],
                             ["idle"] * 2 + ["hot_water"] * 6 + ["idle"] * 2,
                             f"month={month}")

    def test_partial_edge_intervals_join_their_hot_water_run(self):
        # ramp-up and tail fragments (too little mean power to be DHW-shaped)
        # framed by idle -> part of the reheat, not ambiguous
        run = (series(utc(2026, 4, 10, 3, 0), 1, hp_mean=10.0)
               + series(utc(2026, 4, 10, 3, 5), 1, hp_mean=900.0, duty=0.4)
               + series(utc(2026, 4, 10, 3, 10), 4, hp_mean=3200.0)
               + series(utc(2026, 4, 10, 3, 30), 1, hp_mean=600.0, duty=0.3)
               + series(utc(2026, 4, 10, 3, 35), 1, hp_mean=10.0))
        out = hm.classify(run, MILD)
        self.assertEqual([i["mode"] for i in out],
                         ["idle"] + ["hot_water"] * 6 + ["idle"])

    def test_edge_is_not_absorbed_when_activity_continues_beyond_it(self):
        # reheat followed directly by sustained low-power conditioning: the
        # interval after the run is not the run's edge
        run = (series(utc(2026, 4, 10, 3, 0), 1, hp_mean=10.0)
               + series(utc(2026, 4, 10, 3, 5), 4, hp_mean=3200.0)
               + series(utc(2026, 4, 10, 3, 25), 6, hp_mean=1200.0))
        out = hm.classify(run, MILD)
        self.assertEqual([i["mode"] for i in out],
                         ["idle"] + ["hot_water"] * 4 + ["ambiguous"] * 6)

    def test_edge_extension_does_not_rescue_a_too_short_run(self):
        # a single DHW-shaped interval is still not a reheat, edges or not
        run = (series(utc(2026, 4, 10, 3, 0), 1, hp_mean=900.0, duty=0.4)
               + series(utc(2026, 4, 10, 3, 5), 1, hp_mean=3200.0)
               + series(utc(2026, 4, 10, 3, 10), 1, hp_mean=600.0, duty=0.3))
        out = hm.classify(run, MILD)
        self.assertEqual({i["mode"] for i in out}, {"ambiguous"})

    def test_short_high_power_blip_is_not_hot_water(self):
        # one 5-min interval < DHW_RUN_MIN_MINUTES -> falls through to temp
        run = (series(utc(2026, 1, 10, 3, 0), 1, hp_mean=10.0)
               + series(utc(2026, 1, 10, 3, 5), 1, hp_mean=3200.0)
               + series(utc(2026, 1, 10, 3, 10), 1, hp_mean=10.0))
        out = hm.classify(run, COLD)
        self.assertEqual(out[1]["mode"], "heat")

    def test_choppy_high_power_is_not_hot_water(self):
        # duty/transition profile fails the DHW gate -> temp decides
        out = hm.classify(series(utc(2026, 1, 10, 3), 6, hp_mean=3000.0,
                                 duty=0.5, transitions=6), COLD)
        self.assertEqual({i["mode"] for i in out}, {"heat"})

    def test_midband_temp_is_ambiguous(self):
        out = hm.classify(series(utc(2026, 4, 10, 3), 36, hp_mean=3000.0), MILD)
        self.assertEqual({i["mode"] for i in out}, {"ambiguous"})

    def test_missing_weather_is_ambiguous_but_dhw_still_labels(self):
        run = (series(utc(2026, 1, 10, 3, 0), 36, hp_mean=3000.0)      # would-be heat
               + series(utc(2026, 1, 10, 6, 0), 1, hp_mean=10.0)
               + series(utc(2026, 1, 10, 6, 5), 6, hp_mean=3200.0)     # DHW shape
               + series(utc(2026, 1, 10, 6, 35), 1, hp_mean=10.0))
        out = hm.classify(run, [])
        self.assertEqual({i["mode"] for i in out[:36]}, {"ambiguous"})
        self.assertEqual([i["mode"] for i in out[37:43]], ["hot_water"] * 6)

    def test_timeline_gap_splits_a_dhw_run(self):
        # 6 DHW-shaped intervals but a 20-min hole in the middle. Both halves
        # (15 min each) independently satisfy DHW_RUN_MIN/MAX_MINUTES on their
        # own, so this does not by itself prove the gap splits the run — a
        # merged 30-min run would also land in [10, 120] and pass. See
        # test_gap_split_drops_runs_below_the_dhw_floor for the discriminating case.
        run = (series(utc(2026, 1, 10, 3, 0), 3, hp_mean=3200.0)
               + series(utc(2026, 1, 10, 3, 35), 3, hp_mean=3200.0))
        out = hm.classify(run, COLD)
        self.assertEqual({i["mode"] for i in out}, {"hot_water"})

    def test_gap_split_drops_runs_below_the_dhw_floor(self):
        # Two single-interval (5 min) DHW-shaped runs separated by a gap, on a
        # cold day. Correctly split: each run is 5 min, below
        # DHW_RUN_MIN_MINUTES (10), so neither is hot_water and both fall
        # through to the cold temperature band -> heat. If contiguity were
        # ignored and the two intervals merged into one 10-min run, that run
        # would satisfy the DHW bounds and both intervals would be hot_water
        # instead.
        run = (series(utc(2026, 1, 10, 3, 0), 1, hp_mean=3200.0)
               + series(utc(2026, 1, 10, 3, 20), 1, hp_mean=3200.0))
        out = hm.classify(run, COLD)
        self.assertEqual({i["mode"] for i in out}, {"heat"})


if __name__ == "__main__":
    unittest.main()
