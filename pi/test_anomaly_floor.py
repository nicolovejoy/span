"""Materiality floor + weather-matched HVAC in the daily anomaly check.

    cd pi && python3 -m pytest test_anomaly_floor.py

Deliberately does not stub httpx / influxdb_client (unlike test_cool_alert.py):
this file sorts before test_bath_detector.py and test_charge_detector.py, and a
stub influxdb_client installed here would break their `from influxdb_client
import Point` at collection. conftest.py already stubs matplotlib.
"""
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))

import daily_report as dr  # noqa: E402
import report_baseline as rb  # noqa: E402


class FakeRecord:
    def __init__(self, time, value, values):
        self._time, self._value, self.values = time, value, values

    def get_time(self):
        return self._time

    def get_value(self):
        return self._value


class FakeTable:
    def __init__(self, records):
        self.records = records


class SeqApi:
    """Returns the next canned table list on each query() call; records the Flux."""
    def __init__(self, *responses):
        self.responses, self.flux = list(responses), []

    def query(self, flux, org=None):
        self.flux.append(flux)
        return self.responses.pop(0)


T = date(2026, 11, 19)   # Thursday


def rows_fixture(target=T, similar=((3, 10.0), (5, 11.0), (10, 10.0), (20, 12.0), (30, 11.0)),
                 target_space=16.8, target_hw=11.5, lights=None):
    """Same shape as test_report_baseline.hvac_fixture, as counter rows on the
    "Heat pump" circuit (HVAC). `lights`: optional (target value) with weekday
    samples WK on "Lights / Downstairs"."""
    rows, hw, temps = [], {}, {}
    for k in range(60, 0, -1):
        d = target - timedelta(days=k)
        hw[d] = 4.0 if (k // 7) % 2 == 0 else 5.0
        temps[d] = 60.0
        space = dict(similar).get(k, 3.0)
        if k in dict(similar):
            temps[d] = 43.0
        rows.append(("Heat pump", d, hw[d] + space))
    hw[target], temps[target] = target_hw, 43.0
    rows.append(("Heat pump", target, target_hw + target_space))
    if lights is not None:
        for d, v in zip(rb.trailing_same_weekday_dates(target, 8), [9, 10, 11, 10, 9, 11, 10, 9]):
            rows.append(("Lights / Downstairs", d, v))
        rows.append(("Lights / Downstairs", target, lights))
    return rows, hw, temps


def verdicts(rows, hw, temps, target=T):
    return {v.category: v for v in dr.evaluate_day(target, dr.category_day_kwh(rows), hw, temps)}


class QueryTest(unittest.TestCase):
    def test_hourly_temp_flux_reads_raw_temp_f(self):
        flux = dr._hourly_temp_flux("2026-09-20T07:00:00Z", "2026-11-20T08:00:00Z")
        self.assertIn('r._measurement == "weather" and r._field == "temp_f"', flux)
        self.assertNotIn("aggregateWindow", flux)

    def test_query_hourly_temp_f_skips_none(self):
        t = datetime(2026, 11, 19, 8, tzinfo=timezone.utc)
        api = SeqApi([FakeTable([FakeRecord(t, 43.0, {}), FakeRecord(t, None, {})])])
        self.assertEqual(dr.query_hourly_temp_f(api, "a", "b"), [(t, 43.0)])

    def test_hot_water_flux_is_pacific_daily(self):
        flux = dr._daily_hot_water_flux("a", "b", "sum")
        self.assertIn('option location = timezone.location(name: "America/Los_Angeles")', flux)
        self.assertIn('r._measurement == "hvac_mode" and r._field == "energy_hot_water_kwh"', flux)
        self.assertIn("aggregateWindow(every: 1d, fn: sum", flux)

    def test_hot_water_needs_enough_intervals(self):
        stop_18 = datetime(2026, 11, 19, 8, tzinfo=timezone.utc)   # stop stamp of 11-18 PST
        stop_17 = datetime(2026, 11, 18, 8, tzinfo=timezone.utc)
        sums = [FakeTable([FakeRecord(stop_17, 3.0, {}), FakeRecord(stop_18, 11.5, {})])]
        counts = [FakeTable([FakeRecord(stop_17, 100, {}), FakeRecord(stop_18, 288, {})])]
        api = SeqApi(sums, counts)
        self.assertEqual(dr.query_daily_hot_water_kwh(api, "a", "b"), {date(2026, 11, 18): 11.5})
        self.assertIn("fn: sum", api.flux[0])
        self.assertIn("fn: count", api.flux[1])


class EvaluateDayTest(unittest.TestCase):
    def test_hvac_weather_judgement(self):
        rows, hw, temps = rows_fixture()
        v = verdicts(rows, hw, temps)["HVAC"]
        self.assertEqual(v.action, "judge")
        self.assertEqual(v.hvac.space.basis, "weather")
        self.assertAlmostEqual(v.value, 28.3)
        self.assertAlmostEqual(v.value - v.baseline.median, 13.0)
        self.assertTrue(v.result.is_anomalous)

    def test_hvac_without_hot_water_uses_whole_category_plus_floor(self):
        rows, hw, temps = rows_fixture()
        v = verdicts(rows, {}, temps)["HVAC"]
        self.assertIsNone(v.hvac)
        self.assertEqual(v.baseline.n, 8)       # weekday median/MAD of whole HVAC

    def test_sub_floor_lights_is_not_anomalous(self):
        rows, hw, temps = rows_fixture(lights=15.0)   # +5 kWh, z 3.4, $0.62
        v = verdicts(rows, hw, temps)["Lights"]
        self.assertTrue(rb.evaluate(15.0, v.baseline).is_anomalous)
        self.assertFalse(v.result.is_anomalous)

    def test_material_lights_is_anomalous(self):
        rows, hw, temps = rows_fixture(lights=25.0)   # +15 kWh, $1.86
        self.assertTrue(verdicts(rows, hw, temps)["Lights"].result.is_anomalous)

    def test_categories_without_samples_skip_and_car_under_cap_clears(self):
        rows, hw, temps = rows_fixture()
        for d in rb.trailing_same_weekday_dates(T, 8):
            rows.append(("Tesla Car Charger", d, 0.0))
        rows.append(("Tesla Car Charger", T, 20.0))
        vs = verdicts(rows, hw, temps)
        self.assertEqual(vs["Car"].action, "clear")
        self.assertEqual(vs["Appliances"].action, "skip")

    def test_car_over_cap_still_judged_with_floor(self):
        rows, hw, temps = rows_fixture()
        for d in rb.trailing_same_weekday_dates(T, 8):
            rows.append(("Tesla Car Charger", d, 0.0))
        rows.append(("Tesla Car Charger", T, 150.0))
        v = verdicts(rows, hw, temps)["Car"]
        self.assertEqual(v.action, "judge")
        self.assertTrue(v.result.is_anomalous)


class GenerateAnomalyCheckTest(unittest.TestCase):
    def _run(self, rows, hw, temps, state=None):
        fresh = state or rb.SuppressionState(last_alert_date=None, last_z=None)
        with mock.patch.object(dr, "query_day_coverage", return_value=1.0), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows) as q, \
             mock.patch.object(dr, "query_daily_hot_water_kwh", return_value=hw), \
             mock.patch.object(dr, "query_daily_temps_f", return_value=temps), \
             mock.patch.object(dr, "query_hvac_mode_intervals", return_value=[]), \
             mock.patch.object(dr.rb, "load_state", return_value=fresh), \
             mock.patch.object(dr.rb, "save_state") as save, \
             mock.patch.object(dr.rb, "clear_state") as clear, \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_anomaly_check(mock.Mock(), T)
        return q, save, clear, sent

    def test_fetch_window_starts_60_days_back(self):
        rows, hw, temps = rows_fixture()
        q, *_ = self._run(rows, hw, temps)
        start = q.call_args[0][1]
        self.assertEqual(start, dr.flux_ts(dr.local_day_utc_range(T - timedelta(days=60))[0]))

    def test_combined_hvac_alert_is_sent_and_saved(self):
        rows, hw, temps = rows_fixture()
        _, save, _, sent = self._run(rows, hw, temps)
        sent.assert_called_once()
        save.assert_called_once()
        self.assertEqual(save.call_args[0][1], "HVAC")

    def test_sub_floor_anomaly_clears_state_and_sends_nothing(self):
        # hot water +7 is anomalous, space matches its similar days: 7 kWh, $0.87
        rows, hw, temps = rows_fixture(target_space=10.8)
        prior = rb.SuppressionState(last_alert_date=T - timedelta(days=1), last_z=5.0,
                                    since=T - timedelta(days=1))
        _, save, clear, sent = self._run(rows, hw, temps, state=prior)
        sent.assert_not_called()
        save.assert_not_called()
        self.assertIn("HVAC", [c[0][1] for c in clear.call_args_list])

    def test_query_failures_fall_back_without_raising(self):
        rows, _, _ = rows_fixture()
        with mock.patch.object(dr, "query_day_coverage", return_value=1.0), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
             mock.patch.object(dr, "query_daily_hot_water_kwh", side_effect=RuntimeError("x")), \
             mock.patch.object(dr, "query_daily_temps_f", side_effect=RuntimeError("y")), \
             mock.patch.object(dr, "query_hvac_mode_intervals", return_value=[]), \
             mock.patch.object(dr.rb, "load_state",
                               return_value=rb.SuppressionState(None, None)), \
             mock.patch.object(dr.rb, "save_state"), \
             mock.patch.object(dr, "send_email") as sent, \
             self.assertLogs(dr.logger, level="WARNING") as logs:
            dr.generate_anomaly_check(mock.Mock(), T)
        self.assertEqual(len([m for m in logs.output if "query failed" in m]), 2)
        # whole HVAC 28.3 vs weekday median 7.5 (5+3 / 4+3): +20.8 kWh, $2.58 -> alerts
        sent.assert_called_once()


from email_kit import html_to_text  # noqa: E402


class HvacEmailCopyTest(unittest.TestCase):
    def _alert(self, **fixture_kw):
        rows, hw, temps = rows_fixture(**fixture_kw)
        v = verdicts(rows, hw, temps)["HVAC"]
        return [("HVAC", v.value, v.baseline, v.result)], v.hvac

    def test_weather_comparison_in_plain_words(self):
        alerts, j = self._alert()
        subject, html = dr.render_anomaly_email(T, alerts, {}, hvac=j)
        text = html_to_text(html)
        self.assertEqual(subject, "⚡ HVAC 13.0 kWh above expected ($1.61)")
        self.assertIn("HVAC used 28.3 kWh, 13.0 kWh more than expected ($1.61).", text)
        self.assertIn("16.8 kWh vs an average 10.8 kWh on 5 days at similar temperature "
                      "(within 3°F of 43°F, last 60 days) — unusual.", text)
        self.assertIn("Hot water: 11.5 kWh vs a normal 4.5 kWh for a Thursday — unusual.", text)
        self.assertNotIn("for a Thursday (", text.split("Hot water")[0])

    def test_weekday_fallback_wording(self):
        alerts, j = self._alert(similar=((3, 10.0), (5, 11.0)))
        _, html = dr.render_anomaly_email(T, alerts, {}, hvac=j)
        self.assertIn("for a Thursday (too few days at similar temperature to compare)",
                      html_to_text(html))

    def test_normal_part_is_marked_not_counted(self):
        # space within range, hot water huge: hot water alone over the floor
        alerts, j = self._alert(target_space=10.8, target_hw=20.0)
        self.assertTrue(j.result.is_anomalous)
        _, html = dr.render_anomaly_email(T, alerts, {}, hvac=j)
        self.assertIn("within the normal range, not counted", html_to_text(html))

    def test_day_n_suffix_still_applies(self):
        alerts, j = self._alert()
        subject, _ = dr.render_anomaly_email(T, alerts, {}, hvac=j,
                                             episode_since={"HVAC": T - timedelta(days=2)})
        self.assertTrue(subject.endswith(" · day 3"), subject)

    def test_without_judgement_copy_is_unchanged(self):
        alerts, j = self._alert()
        subject, html = dr.render_anomaly_email(T, alerts, {})
        self.assertNotIn("expected", subject)
        self.assertNotIn("similar temperature", html)

    def test_generate_passes_the_judgement(self):
        rows, hw, temps = rows_fixture()
        _, _, _, sent = GenerateAnomalyCheckTest._run(GenerateAnomalyCheckTest(), rows, hw, temps)
        html, subject = sent.call_args[0]
        self.assertIn("days at similar temperature", html)
        self.assertTrue(subject.startswith("⚡ HVAC 13.0 kWh above expected"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
