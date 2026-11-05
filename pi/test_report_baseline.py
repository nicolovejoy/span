"""
    cd pi && python3 test_report_baseline.py
"""
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

import report_baseline as rb


class MedianMadTest(unittest.TestCase):
    def test_median_odd_and_even(self):
        self.assertEqual(rb.median([1, 3, 2]), 2)
        self.assertEqual(rb.median([1, 2, 3, 4]), 2.5)

    def test_mad_is_normal_consistent(self):
        # symmetric spread around 10: MAD * 1.4826 approximates stdev for a
        # normal-ish sample
        samples = [8, 9, 10, 11, 12]
        self.assertAlmostEqual(rb.mad(samples), 1.4826, places=3)

    def test_compute_baseline_reports_sample_count(self):
        b = rb.compute_baseline([1.0, 2.0, 3.0])
        self.assertEqual(b.n, 3)
        self.assertEqual(b.median, 2.0)


class EvaluateTest(unittest.TestCase):
    def test_fires_only_when_both_z_and_floor_exceeded(self):
        # 8 samples all near 10, one outlier value of 20 to evaluate
        baseline = rb.compute_baseline([9, 10, 10, 11, 10, 9, 10, 11])
        result = rb.evaluate(20.0, baseline)
        self.assertTrue(result.is_anomalous)
        self.assertGreater(abs(result.z), 3)

    def test_floor_suppresses_a_small_wobble_on_a_tiny_category(self):
        # Lights-scale baseline: median 0.3, near-zero MAD — without the floor
        # a 0.3 kWh wobble would fire on z alone
        baseline = rb.compute_baseline([0.28, 0.30, 0.29, 0.31, 0.30, 0.29, 0.30, 0.31])
        result = rb.evaluate(0.6, baseline)   # +0.3 kWh swing, well under the 1.0 kWh floor
        self.assertFalse(result.is_anomalous)

    def test_floor_scales_with_a_large_category(self):
        # Car-scale baseline: median 40 kWh — 20% floor (8 kWh) dominates the 1.0 kWh minimum
        baseline = rb.compute_baseline([38, 40, 39, 41, 40, 39, 40, 42])
        just_under = rb.evaluate(47.5, baseline)   # 7.5 kWh over — under the 8 kWh floor
        self.assertFalse(just_under.is_anomalous)

    def test_degenerate_mad_zero_falls_back_to_percentage_floor(self):
        baseline = rb.compute_baseline([5.0] * 8)   # mad == 0
        self.assertEqual(baseline.mad, 0.0)
        small = rb.evaluate(6.0, baseline)          # 20% over — under the 50% fallback floor
        self.assertFalse(small.is_anomalous)
        self.assertIsNone(small.z)
        big = rb.evaluate(8.0, baseline)             # 60% over — trips the 50% fallback floor
        self.assertTrue(big.is_anomalous)

    def test_zero_median_baseline_gives_pct_none_not_inf(self):
        # A category that's genuinely idle on this weekday (e.g. an EV charger
        # with several zero-usage trailing weekdays) has median == 0. A nonzero,
        # anomalous value must not produce pct == inf (garbage in the email
        # subject) — it's undefined, so it should be None.
        baseline = rb.compute_baseline([0.0] * 8)
        self.assertEqual(baseline.median, 0.0)
        result = rb.evaluate(6.0, baseline)
        self.assertIsNone(result.pct)
        self.assertTrue(result.is_anomalous)   # 6.0 > max(0.5*0, 1.0) floor
        self.assertIsNone(result.z)            # mad == 0 -> percentage-fallback branch


class WeekdayBucketingTest(unittest.TestCase):
    def test_trailing_same_weekday_dates_is_oldest_first(self):
        # 2026-08-18 is a Tuesday; the target itself is excluded, so the three
        # Tuesdays immediately before it are 2026-07-28, 08-04, 08-11
        got = rb.trailing_same_weekday_dates(date(2026, 8, 18), n=3)
        self.assertEqual(got, [date(2026, 7, 28), date(2026, 8, 4), date(2026, 8, 11)])

    def test_trailing_same_weekday_survives_a_dst_boundary(self):
        # 2026-03-10 is a Tuesday, one day after the 2026-03-08 spring-forward —
        # trailing_same_weekday_dates is pure calendar-week arithmetic (timedelta
        # weeks), which is DST-agnostic by construction; this test locks that in.
        got = rb.trailing_same_weekday_dates(date(2026, 3, 10), n=8)
        self.assertEqual(len(got), 8)
        self.assertTrue(all(d.weekday() == 1 for d in got))  # all Tuesdays
        self.assertEqual(got[-1], date(2026, 3, 3))


class CoverageTest(unittest.TestCase):
    def test_day_coverage_threshold(self):
        self.assertTrue(rb.day_coverage_ok(0.90))
        self.assertFalse(rb.day_coverage_ok(0.89))

    def test_category_coverage_threshold(self):
        self.assertTrue(rb.category_coverage_ok(6))
        self.assertFalse(rb.category_coverage_ok(5))


class SuppressionStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "state.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_file_is_no_prior_alert(self):
        state = rb.load_state(self.path, "HVAC")
        self.assertIsNone(state.last_alert_date)

    def test_corrupt_json_is_no_prior_alert(self):
        self.path.write_text("{not valid json")
        state = rb.load_state(self.path, "HVAC")
        self.assertIsNone(state.last_alert_date)

    def test_save_then_load_round_trips(self):
        rb.save_state(self.path, "HVAC", date(2026, 8, 18), 4.2)
        state = rb.load_state(self.path, "HVAC")
        self.assertEqual(state.last_alert_date, date(2026, 8, 18))
        self.assertAlmostEqual(state.last_z, 4.2)

    def test_save_preserves_other_categories(self):
        rb.save_state(self.path, "HVAC", date(2026, 8, 18), 4.2)
        rb.save_state(self.path, "Lights", date(2026, 8, 19), 3.5)
        data = json.loads(self.path.read_text())
        self.assertIn("HVAC", data)
        self.assertIn("Lights", data)

    def test_clear_removes_the_category_only(self):
        rb.save_state(self.path, "HVAC", date(2026, 8, 18), 4.2)
        rb.save_state(self.path, "Lights", date(2026, 8, 19), 3.5)
        rb.clear_state(self.path, "HVAC")
        self.assertIsNone(rb.load_state(self.path, "HVAC").last_alert_date)
        self.assertIsNotNone(rb.load_state(self.path, "Lights").last_alert_date)

    def test_save_state_keeps_episode_start(self):
        rb.save_state(self.path, "HVAC", date(2026, 11, 1), 4.2)
        rb.save_state(self.path, "HVAC", date(2026, 11, 3), 5.6)
        state = rb.load_state(self.path, "HVAC")
        self.assertEqual(state.since, date(2026, 11, 1))
        self.assertEqual(state.last_alert_date, date(2026, 11, 3))
        self.assertAlmostEqual(state.last_z, 5.6)

    def test_clear_state_then_save_starts_new_episode(self):
        rb.save_state(self.path, "HVAC", date(2026, 11, 1), 4.2)
        rb.clear_state(self.path, "HVAC")
        rb.save_state(self.path, "HVAC", date(2026, 11, 5), 4.0)
        self.assertEqual(rb.load_state(self.path, "HVAC").since, date(2026, 11, 5))

    def test_load_state_legacy_entry_without_since(self):
        self.path.write_text(json.dumps({"HVAC": {"date": "2026-11-02", "z": 4.1}}))
        state = rb.load_state(self.path, "HVAC")
        self.assertEqual(state.since, date(2026, 11, 2))
        self.assertEqual(state.last_alert_date, date(2026, 11, 2))

    def test_save_state_on_legacy_entry_keeps_fallback_since(self):
        self.path.write_text(json.dumps({"HVAC": {"date": "2026-11-02", "z": 4.1}}))
        rb.save_state(self.path, "HVAC", date(2026, 11, 4), 6.0)
        self.assertEqual(rb.load_state(self.path, "HVAC").since, date(2026, 11, 2))

    def test_state_with_no_entry_has_no_since(self):
        self.assertIsNone(rb.load_state(self.path, "HVAC").since)

    def test_a_six_day_heat_wave_produces_one_alert_not_six(self):
        """The failure this whole design exists to avoid (spec, 'Guard: repeat
        suppression'). A flat, non-worsening anomaly stays suppressed for the
        whole episode — only worsening or a return to normal lifts it, so
        elapsed time alone never re-triggers."""
        baseline = rb.compute_baseline([10, 11, 10, 9, 10, 11, 10, 9])  # HVAC-ish
        hot_value = 40.0   # anomalous every day of the heat wave, same severity
        alerts_sent = 0
        day = date(2026, 7, 20)   # Monday
        for i in range(6):
            today = day + timedelta(days=i)
            result = rb.evaluate(hot_value, baseline)
            state = rb.load_state(self.path, "HVAC")
            if rb.should_alert(result, state):
                alerts_sent += 1
                rb.save_state(self.path, "HVAC", today, result.z)
        self.assertEqual(alerts_sent, 1)

    def test_state_clears_once_back_to_normal(self):
        rb.save_state(self.path, "HVAC", date(2026, 8, 18), 4.5)
        baseline = rb.compute_baseline([10, 11, 10, 9, 10, 11, 10, 9])
        normal_result = rb.evaluate(10.0, baseline)
        self.assertFalse(normal_result.is_anomalous)
        # caller's responsibility per should_alert's docstring: clear on normal
        rb.clear_state(self.path, "HVAC")
        state = rb.load_state(self.path, "HVAC")
        self.assertIsNone(state.last_alert_date)
        # a fresh anomaly right after clearing should alert immediately, not be
        # suppressed by the just-cleared episode
        result = rb.evaluate(40.0, baseline)
        self.assertTrue(rb.should_alert(result, state))

    def test_worsening_deviation_breaks_the_suppression_window(self):
        rb.save_state(self.path, "HVAC", date(2026, 8, 18), 4.0)
        state = rb.load_state(self.path, "HVAC")
        result = rb.AnomalyResult(is_anomalous=True, z=5.5, pct=80.0)   # +37.5% over 4.0
        self.assertTrue(rb.should_alert(result, state))   # still anomalous, but materially worse

    def test_mild_worsening_stays_suppressed(self):
        rb.save_state(self.path, "HVAC", date(2026, 8, 18), 4.0)
        state = rb.load_state(self.path, "HVAC")
        result = rb.AnomalyResult(is_anomalous=True, z=4.5, pct=70.0)   # only +12.5%
        self.assertFalse(rb.should_alert(result, state))


class CoverageGapTest(unittest.TestCase):
    def test_a_coverage_gap_produces_zero_alerts(self):
        """spec, 'Guard: coverage check' — a collector outage must not be
        reported as an anomaly in every category."""
        self.assertFalse(rb.day_coverage_ok(0.40))  # caller suppresses the whole day


if __name__ == "__main__":
    unittest.main(verbosity=2)
