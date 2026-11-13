"""Tests for the weekly briefing + anomaly check layer added to daily_report.py.

    cd pi && python3 test_weekly_report.py

Stubs runtime deps the same way test_daily_report_rollups.py does — nothing here
touches InfluxDB. pytest's conftest.py provides the matplotlib stub.
"""
import os
import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

for _name in ("httpx",):
    sys.modules.setdefault(_name, types.ModuleType(_name))
if "influxdb_client" not in sys.modules:
    _ic = types.ModuleType("influxdb_client")
    _ic.InfluxDBClient = object
    sys.modules["influxdb_client"] = _ic

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
import daily_report as dr   # noqa: E402
import collector_health as ch   # noqa: E402

UTC = timezone.utc


def utc(*args):
    return datetime(*args, tzinfo=UTC)


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


class FakeApi:
    """Records the Flux it is handed; returns canned tables."""

    def __init__(self, tables=None):
        self.flux = []
        self.tables = tables or []

    def query(self, flux, org=None):
        self.flux.append(flux)
        return self.tables


class CounterFluxTest(unittest.TestCase):
    def test_reads_energy_wh_counter_on_circuit_1h_only(self):
        flux = dr._counter_kwh_flux(dr.flux_ts(utc(2026, 8, 3, 7)),
                                    dr.flux_ts(utc(2026, 8, 10, 7)), "1d")
        self.assertIn('r._measurement == "circuit_1h" and r._field == "energy_wh_counter"', flux)
        self.assertNotIn('"circuit"', flux.replace('"circuit_1h"', ''))  # no raw fallback

    def test_pacific_aligned_for_day_grid(self):
        flux = dr._counter_kwh_flux(dr.flux_ts(utc(2026, 8, 3, 7)),
                                    dr.flux_ts(utc(2026, 8, 10, 7)), "1d")
        self.assertIn('timezone.location(name: "America/Los_Angeles")', flux)

    def test_stop_stamp_recentring_is_hardcoded(self):
        # 1h period: range shifted forward a full hour, then timeShift back 30 min —
        # same recentring _circuit_kwh_flux does for stamp="stop", but with no
        # runtime detection (no raw probe).
        flux = dr._counter_kwh_flux("2026-08-03T07:00:00Z", "2026-08-10T07:00:00Z", "1d")
        self.assertIn("range(start: 2026-08-03T08:00:00Z, stop: 2026-08-10T08:00:00Z)", flux)
        self.assertIn("timeShift(duration: -1800s)", flux)

    def test_name_filter_is_applied(self):
        flux = dr._counter_kwh_flux("2026-08-03T07:00:00Z", "2026-08-10T07:00:00Z", "1d",
                                    name_filter="Heat pump|Auxiliary")
        self.assertIn("r.name =~ /(?i)Heat pump|Auxiliary/", flux)


class QueryDailyCounterTest(unittest.TestCase):
    def test_rows_are_named_dated_kwh_tuples(self):
        # a stop-stamped 1d bucket at local 2026-08-04T07:00Z covers 2026-08-03 local
        tables = [FakeTable([
            FakeRecord(utc(2026, 8, 4, 7), 1.5, {"name": "Kitchen"}),
            FakeRecord(utc(2026, 8, 5, 7), 2.25, {"name": "Kitchen"}),
        ])]
        rows = dr.query_daily_circuit_counter_kwh(
            FakeApi(tables), "2026-08-03T07:00:00Z", "2026-08-05T07:00:00Z")
        self.assertEqual(rows, [
            ("Kitchen", date(2026, 8, 3), 1.5),
            ("Kitchen", date(2026, 8, 4), 2.25),
        ])


class GroupingTest(unittest.TestCase):
    ROWS = [
        ("Kitchen Lights", date(2026, 8, 3), 1.0),
        ("Kitchen Lights", date(2026, 8, 10), 2.0),   # next week
        ("Heat pump", date(2026, 8, 3), 5.0),
        ("Heat pump", date(2026, 8, 4), 6.0),
        ("Tesla Car Charger", date(2026, 8, 3), 10.0),
    ]

    def test_local_week_start_is_the_monday_on_or_before(self):
        self.assertEqual(dr.local_week_start(date(2026, 8, 3)), date(2026, 8, 3))  # Monday
        self.assertEqual(dr.local_week_start(date(2026, 8, 9)), date(2026, 8, 3))  # Sunday

    def test_category_day_kwh_rolls_up_via_display_bucket(self):
        out = dr.category_day_kwh(self.ROWS)
        self.assertEqual(out[date(2026, 8, 3)], {"Lights": 1.0, "HVAC": 5.0, "Car": 10.0})
        self.assertEqual(out[date(2026, 8, 4)], {"HVAC": 6.0})

    def test_week_totals_sums_seven_days_from_monday(self):
        day_cat = dr.category_day_kwh(self.ROWS)
        self.assertEqual(dr.week_totals(day_cat, date(2026, 8, 3)),
                         {"Lights": 1.0, "HVAC": 11.0, "Car": 10.0})
        self.assertEqual(dr.week_totals(day_cat, date(2026, 8, 10)), {"Lights": 2.0})

    def test_circuit_week_totals_stays_at_circuit_granularity(self):
        self.assertEqual(dr.circuit_week_totals(self.ROWS, date(2026, 8, 3)),
                         {"Kitchen Lights": 1.0, "Heat pump": 11.0, "Tesla Car Charger": 10.0})

    def test_category_top_circuits_filters_and_sorts_descending(self):
        rows = self.ROWS + [("Auxiliary", date(2026, 8, 3), 1.0)]
        top = dr.category_top_circuits(rows, date(2026, 8, 3), "HVAC")
        self.assertEqual(top, [("Heat pump", 11.0), ("Auxiliary", 1.0)])

    def test_trailing_week_starts_is_oldest_first_excluding_target(self):
        got = dr.trailing_week_starts(date(2026, 8, 17), 3)
        self.assertEqual(got, [date(2026, 7, 27), date(2026, 8, 3), date(2026, 8, 10)])

    def test_trailing_month_starts_is_oldest_first_excluding_target(self):
        got = dr.trailing_month_starts(date(2026, 8, 1), 3)
        self.assertEqual(got, [date(2026, 5, 1), date(2026, 6, 1), date(2026, 7, 1)])

    def test_trailing_month_starts_crosses_year_boundary(self):
        got = dr.trailing_month_starts(date(2026, 2, 1), 3)
        self.assertEqual(got, [date(2025, 11, 1), date(2025, 12, 1), date(2026, 1, 1)])

    def test_month_totals_sums_within_the_calendar_month(self):
        day_cat = {
            date(2026, 7, 31): {"HVAC": 100.0},   # prior month — excluded
            date(2026, 8, 1): {"HVAC": 1.0, "Lights": 2.0},
            date(2026, 8, 31): {"HVAC": 3.0},
            date(2026, 9, 1): {"HVAC": 200.0},   # next month — excluded
        }
        self.assertEqual(dr.month_totals(day_cat, date(2026, 8, 1)),
                         {"HVAC": 4.0, "Lights": 2.0})

    def test_circuit_month_totals_stays_at_circuit_granularity(self):
        # self.ROWS' two "Kitchen Lights" rows (8/3 and 8/10) both fall in August,
        # unlike test_circuit_week_totals's single-week slice.
        rows = self.ROWS + [("Heat pump", date(2026, 9, 1), 999.0)]   # next month — excluded
        self.assertEqual(dr.circuit_month_totals(rows, date(2026, 8, 1)),
                         {"Kitchen Lights": 3.0, "Heat pump": 11.0, "Tesla Car Charger": 10.0})

    def test_sum_days_is_half_open(self):
        daily = {date(2026, 8, 3): 1.0, date(2026, 8, 4): 2.0, date(2026, 8, 10): 99.0}
        self.assertEqual(dr._sum_days(daily, date(2026, 8, 3), date(2026, 8, 5)), 3.0)

    def test_unmonitored_is_panel_minus_known_circuits_floored_at_zero(self):
        self.assertEqual(dr.unmonitored_kwh(100.0, {"a": 40.0, "b": 30.0}), 30.0)
        self.assertEqual(dr.unmonitored_kwh(50.0, {"a": 60.0}), 0.0)  # never negative

    def test_all_categories_matches_categories_json_plus_default(self):
        cats = dr._all_categories()
        self.assertEqual(cats, ["Lights", "HVAC", "Car", "Appliances", "Else"])


class HeadlineTest(unittest.TestCase):
    def test_pct_delta_none_when_baseline_is_zero_or_negative(self):
        self.assertIsNone(dr._pct_delta(5.0, 0.0))

    def test_pct_delta_sign_matches_direction(self):
        self.assertAlmostEqual(dr._pct_delta(110.0, 100.0), 10.0)
        self.assertAlmostEqual(dr._pct_delta(90.0, 100.0), -10.0)

    def test_top_mover_is_the_largest_absolute_category_swing_excluding_unmonitored(self):
        stats = dr.headline_stats(
            week_kwh=210.0, last_week_kwh=200.0, trailing12_avg_kwh=195.0,
            long_avg_week_kwh=190.0,
            week_cat={"HVAC": 80.0, "Lights": 20.0, "Unmonitored": 50.0},
            last_week_cat={"HVAC": 60.0, "Lights": 22.0, "Unmonitored": 10.0},
        )
        # Unmonitored swung by 40, HVAC by 20 — but Unmonitored is excluded
        self.assertEqual(stats["top_mover"], "HVAC")
        self.assertAlmostEqual(stats["top_mover_delta_kwh"], 20.0)
        self.assertAlmostEqual(stats["delta_vs_last_week_pct"], 5.0)
        self.assertAlmostEqual(stats["delta_vs_long_pct"], (210.0 - 190.0) / 190.0 * 100)
        self.assertAlmostEqual(stats["kwh"], 210.0)

    def test_no_movers_when_categories_are_empty(self):
        stats = dr.headline_stats(0.0, 0.0, 0.0, 0.0, {}, {})
        self.assertIsNone(stats["top_mover"])

    def test_no_top_mover_named_when_every_delta_is_exactly_zero(self):
        # A flat week — nothing changed for any category. max() would otherwise
        # pick one arbitrarily by iteration order and the headline would claim
        # a meaningless "biggest mover was X (+0.0 kWh)".
        stats = dr.headline_stats(
            week_kwh=100.0, last_week_kwh=100.0, trailing12_avg_kwh=100.0,
            long_avg_week_kwh=100.0,
            week_cat={"HVAC": 50.0, "Lights": 20.0},
            last_week_cat={"HVAC": 50.0, "Lights": 20.0},
        )
        self.assertIsNone(stats["top_mover"])
        self.assertEqual(stats["top_mover_delta_kwh"], 0.0)


class BaselineHelpersTest(unittest.TestCase):
    def test_data_days_skips_zero_filled_and_missing_days(self):
        panel = {date(2026, 1, 1): 0.0, date(2026, 1, 2): 20.0, date(2026, 1, 4): 30.0}
        self.assertEqual(dr.data_days(panel, date(2026, 1, 1), date(2026, 1, 5)),
                         [date(2026, 1, 2), date(2026, 1, 4)])

    def test_data_days_is_half_open(self):
        panel = {date(2026, 1, 2): 20.0, date(2026, 1, 3): 20.0}
        self.assertEqual(dr.data_days(panel, date(2026, 1, 2), date(2026, 1, 3)), [date(2026, 1, 2)])

    def test_avg_week_is_mean_day_times_seven(self):
        days = [date(2026, 1, 2), date(2026, 1, 4)]
        self.assertAlmostEqual(dr.avg_week_kwh({days[0]: 20.0, days[1]: 30.0}, days), 175.0)
        self.assertEqual(dr.avg_week_kwh({}, []), 0.0)

    def test_pct_delta_honest_suppresses_small_bases(self):
        self.assertIsNone(dr._pct_delta_honest(2.0, 0.9))
        self.assertAlmostEqual(dr._pct_delta_honest(2.0, 1.0), 100.0)

    def test_range_label(self):
        self.assertEqual(dr.range_label(date(2025, 11, 3), date(2025, 11, 9)), "Nov 3–9, 2025")
        self.assertEqual(dr.range_label(date(2025, 10, 20), date(2025, 11, 23)), "Oct 20–Nov 23, 2025")
        self.assertEqual(dr.range_label(date(2025, 12, 29), date(2026, 1, 4)), "Dec 29, 2025–Jan 4, 2026")
        self.assertEqual(dr.range_label(date(2026, 11, 1), date(2026, 11, 1)), "Nov 1, 2026")


class YoyWindowsTest(unittest.TestCase):
    WEEK = date(2026, 11, 2)            # Monday
    LY = date(2025, 11, 3)              # the Monday 52 weeks earlier

    def panel(self, lo, hi_exclusive):
        return {lo + timedelta(days=i): 30.0 for i in range((hi_exclusive - lo).days)}

    def test_last_years_week_is_52_weeks_back_on_the_same_weekdays(self):
        win = dr.yoy_windows(self.panel(date(2025, 10, 1), date(2025, 12, 31)), self.WEEK)
        lo, hi, days = win["week"]
        self.assertEqual((lo, hi, len(days)), (self.LY, date(2025, 11, 9), 7))
        self.assertEqual(lo.weekday(), 0)
        lo, hi, days = win["centered"]
        self.assertEqual((lo, hi, len(days)), (date(2025, 10, 20), date(2025, 11, 23), 35))

    def test_none_without_last_years_data(self):
        win = dr.yoy_windows(self.panel(date(2026, 1, 4), date(2026, 11, 9)), self.WEEK)
        self.assertEqual(win, {"week": None, "centered": None})

    def test_week_needs_all_seven_days(self):
        panel = self.panel(date(2025, 10, 1), date(2025, 12, 31))
        panel[date(2025, 11, 5)] = 0.0
        win = dr.yoy_windows(panel, self.WEEK)
        self.assertIsNone(win["week"])
        self.assertEqual(len(win["centered"][2]), 34)   # centred tolerates a missing day

    def test_a_week_starting_on_the_first_day_of_collection_does_not_count(self):
        # Data begins on last year's Monday itself: that first day is partial.
        win = dr.yoy_windows(self.panel(self.LY, date(2025, 12, 31)), self.WEEK)
        self.assertIsNone(win["week"])

    def test_centered_needs_28_of_35_days(self):
        self.assertIsNone(dr.yoy_windows(self.panel(date(2025, 10, 28), date(2025, 12, 31)), self.WEEK)["centered"])


class StackSeriesTest(unittest.TestCase):
    CATS = ["Lights", "HVAC", "Car", "Appliances", "Else"]

    def test_unmonitored_stacks_last_so_the_bar_reaches_the_panel_total(self):
        series = dr.stack_series([{"HVAC": 5.0, "Lights": 2.0, "Unmonitored": 3.0}], self.CATS)
        self.assertEqual([name for name, _ in series], ["Lights", "HVAC", "Unmonitored"])
        self.assertAlmostEqual(sum(v[0] for _, v in series), 10.0)

    def test_legend_lists_only_series_that_are_drawn(self):
        series = dr.stack_series([{"HVAC": 5.0, "Car": 0.0}, {"HVAC": 1.0}], self.CATS)
        self.assertEqual(series, [("HVAC", [5.0, 1.0])])

    def test_negative_values_are_floored(self):
        self.assertEqual(dr.stack_series([{"HVAC": -1.0}, {"HVAC": 2.0}], self.CATS),
                         [("HVAC", [0.0, 2.0])])

    def test_every_drawn_series_has_a_colour(self):
        for cat in self.CATS + ["Unmonitored"]:
            self.assertIn(cat, dr.CATEGORY_COLORS)
        self.assertEqual(len(set(dr.CATEGORY_COLORS.values())), len(dr.CATEGORY_COLORS))


class BuildWeeklyContextTest(unittest.TestCase):
    def _build(self, rows, panel_daily, week_start):
        with mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
             mock.patch.object(dr, "query_daily_panel_kwh", return_value=list(panel_daily.items())):
            return dr.build_weekly_context(object(), week_start)

    def test_outdoor_temps_are_wired_for_this_week_and_last(self):
        with mock.patch.object(dr, "query_mean_temp_f", side_effect=[49.2, 46.7]) as m:
            ctx = self._build([], {}, date(2026, 11, 2))
        self.assertEqual((ctx.temp_f, ctx.temp_f_prev), (49.2, 46.7))
        # Pacific Mondays; the fall-back week (Oct 26–Nov 2) starts at 07:00Z, the next at 08:00Z
        self.assertEqual(m.call_args_list[0].args[1:], ("2026-11-02T08:00:00Z", "2026-11-09T08:00:00Z"))
        self.assertEqual(m.call_args_list[1].args[1:], ("2026-10-26T07:00:00Z", "2026-11-02T08:00:00Z"))

    def test_weather_failure_omits_the_line_and_keeps_the_report(self):
        with mock.patch.object(dr, "query_mean_temp_f", side_effect=RuntimeError("boom")):
            ctx = self._build([], {}, date(2026, 11, 2))
        self.assertIsNone(ctx.temp_f)

    def test_long_run_baseline_is_an_average_week_over_days_with_data(self):
        # 70 days of history at 10 kWh/day HVAC, 20 kWh/day panel; target week doubles both.
        week = date(2026, 8, 3)
        hist = [week - timedelta(days=i) for i in range(1, 71)]
        this = [week + timedelta(days=i) for i in range(7)]
        rows = [("Heat pump", d, 10.0) for d in hist] + [("Heat pump", d, 20.0) for d in this]
        panel = {**{d: 20.0 for d in hist}, **{d: 40.0 for d in this}}
        ctx = self._build(rows, panel, week)
        self.assertEqual(ctx.long_weeks, 10)
        # 280 kWh week vs a 140 kWh average week = +100%, not the old week-vs-month figure
        self.assertAlmostEqual(ctx.headline["delta_vs_long_pct"], 100.0)
        hvac = next(r for r in ctx.usage_rows if r["category"] == "HVAC")
        self.assertAlmostEqual(hvac["delta_long_pct"], 100.0)
        unmon = next(r for r in ctx.usage_rows if r["category"] == "Unmonitored")
        self.assertAlmostEqual(unmon["delta_long_pct"], 100.0)
        self.assertEqual(ctx.yoy, {"week": None, "centered": None})
        self.assertIsNone(hvac["delta_yoy_pct"])

    def test_chart_periods_include_unmonitored_and_sum_to_the_panel(self):
        week = date(2026, 8, 3)
        this = [week + timedelta(days=i) for i in range(7)]
        ctx = self._build([("Heat pump", d, 20.0) for d in this], {d: 25.0 for d in this}, week)
        self.assertAlmostEqual(ctx.week_by_day[0][1]["Unmonitored"], 5.0)
        self.assertAlmostEqual(sum(ctx.trend[-1][1].values()), ctx.headline["kwh"])
        self.assertAlmostEqual(ctx.month_trend[-1][1]["Unmonitored"], 35.0)

    def test_yoy_fills_in_once_last_years_data_exists(self):
        week = date(2026, 11, 2)
        days = [date(2025, 10, 1) + timedelta(days=i) for i in range((date(2026, 11, 9) - date(2025, 10, 1)).days)]
        kwh = lambda d: 40.0 if d >= week else 20.0
        ctx = self._build([("Heat pump", d, kwh(d) / 2) for d in days], {d: kwh(d) for d in days}, week)
        self.assertEqual(ctx.long_weeks, 52)
        self.assertEqual((ctx.yoy["week"]["lo"], ctx.yoy["week"]["hi"]), (date(2025, 11, 3), date(2025, 11, 9)))
        self.assertAlmostEqual(ctx.yoy["week"]["kwh"], 140.0)
        self.assertAlmostEqual(ctx.yoy["centered"]["kwh"], 140.0)
        hvac = next(r for r in ctx.usage_rows if r["category"] == "HVAC")
        self.assertAlmostEqual(hvac["delta_yoy_pct"], 100.0)

    def test_wires_queries_into_a_consistent_context(self):
        rows = [
            ("Heat pump", date(2026, 8, 3), 10.0),
            ("Heat pump", date(2026, 7, 27), 8.0),   # last week
            ("Kitchen Lights", date(2026, 8, 3), 2.0),
        ]
        panel_daily = {date(2026, 8, 3): 15.0, date(2026, 7, 27): 12.0}
        with mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
             mock.patch.object(dr, "query_daily_panel_kwh", return_value=list(panel_daily.items())):
            ctx = dr.build_weekly_context(object(), date(2026, 8, 3))

        self.assertEqual(ctx.week_start, date(2026, 8, 3))
        self.assertEqual(ctx.categories, ["Lights", "HVAC", "Car", "Appliances", "Else"])
        hvac_row = next(r for r in ctx.usage_rows if r["category"] == "HVAC")
        self.assertAlmostEqual(hvac_row["kwh"], 10.0)
        self.assertAlmostEqual(hvac_row["delta_week_pct"], 25.0)  # 10 vs 8
        self.assertIn("delta_long_pct", hvac_row)
        unmon_row = next(r for r in ctx.usage_rows if r["category"] == "Unmonitored")
        self.assertAlmostEqual(unmon_row["kwh"], 3.0)  # 15 - (10 + 2)
        self.assertEqual(len(ctx.week_by_day), 7)
        self.assertEqual(ctx.week_by_day[0][0], date(2026, 8, 3))
        self.assertAlmostEqual(ctx.headline["kwh"], 15.0)
        self.assertIn("delta_vs_long_pct", ctx.headline)
        # 13 months: 12 trailing + the target week's calendar month (Aug 2026)
        self.assertEqual(len(ctx.month_trend), 13)
        self.assertEqual(ctx.month_trend[-1][0], date(2026, 8, 1))
        aug_totals = ctx.month_trend[-1][1]
        self.assertAlmostEqual(aug_totals.get("HVAC", 0.0), 10.0)


class RenderTest(unittest.TestCase):
    def make_ctx(self, **overrides):
        base = dict(
            week_start=date(2026, 8, 3), rows=[], panel_daily={}, day_cat={},
            categories=["Lights", "HVAC", "Car", "Appliances", "Else"],
            headline={"kwh": 210.0, "cost": 27.87, "delta_vs_last_week_pct": 5.0,
                     "delta_vs_12wk_pct": 7.7, "delta_vs_long_pct": 12.1,
                     "top_mover": "HVAC", "top_mover_delta_kwh": 20.0},
            usage_rows=[{"category": "HVAC", "kwh": 80.0, "cost": 9.93,
                        "delta_week_pct": 33.3, "delta_12wk_pct": 10.0, "delta_long_pct": 15.0,
                        "top_circuits": [("Heat pump", 75.0), ("Auxiliary", 5.0)]}],
            week_by_day=[(date(2026, 8, 3) + timedelta(days=i), {"HVAC": float(i)})
                        for i in range(7)],
            trend=[(date(2026, 8, 3) - timedelta(weeks=w), {"HVAC": float(w)})
                  for w in range(12, -1, -1)],
            month_trend=[(date(2026, 8, 1), {"HVAC": float(m)}) for m in range(13)],
        )
        base.update(overrides)
        return dr.WeeklyContext(**base)

    def test_render_headline_names_the_top_mover(self):
        html = dr.render_headline(self.make_ctx())
        self.assertIn("210.0", html.replace(",", ""))
        self.assertIn("HVAC", html)

    def test_render_12mo_trend_chart_smoke(self):
        html = dr.render_12mo_trend_chart(self.make_ctx())
        self.assertIn("12-month trend", html)

    def test_render_12mo_trend_chart_empty_when_no_trend(self):
        html = dr.render_12mo_trend_chart(self.make_ctx(month_trend=[]))
        self.assertEqual(html, "")

    def test_render_12mo_trend_chart_handles_a_partial_current_month(self):
        # week_start=Aug 3 -> week ends Aug 9, well short of Aug 31; must not
        # raise and must still render the chart section (MTD label lives in
        # the chart image, which matplotlib is stubbed out for in this test).
        month_trend = [(date(2026, 8, 1), {"HVAC": 1.0})]
        html = dr.render_12mo_trend_chart(self.make_ctx(month_trend=month_trend))
        self.assertIn("12-month trend", html)

    def test_render_usage_table_includes_nested_top_circuits(self):
        html = dr.render_usage_table(self.make_ctx())
        self.assertIn("HVAC", html)
        self.assertIn("Heat pump", html)
        self.assertIn("Auxiliary", html)

    def test_usage_table_names_the_long_run_column_by_weeks_of_data(self):
        self.assertIn("<th>vs 44-wk avg</th>", dr.render_usage_table(self.make_ctx(long_weeks=44)))
        self.assertIn("<th>vs 52-wk avg</th>", dr.render_usage_table(self.make_ctx(long_weeks=52)))
        self.assertNotIn("12-mo", dr.render_usage_table(self.make_ctx(long_weeks=44)))

    def test_headline_names_the_long_run_baseline(self):
        html = dr.render_headline(self.make_ctx(long_weeks=44))
        self.assertIn("vs 44-wk avg", html)
        self.assertNotIn("12-mo", html)

    def test_yoy_is_absent_until_last_years_data_exists(self):
        ctx = self.make_ctx()
        self.assertEqual(dr.render_yoy_line(ctx), "")
        self.assertNotIn("last year", dr.render_headline(ctx))
        self.assertEqual(dr.render_usage_table(ctx).count("<th>"), 6)

    def test_yoy_line_names_periods_and_leads_with_absolute_delta(self):
        yoy = {"week": {"lo": date(2025, 8, 4), "hi": date(2025, 8, 10), "kwh": 200.0},
               "centered": {"lo": date(2025, 7, 21), "hi": date(2025, 8, 24), "kwh": 180.0}}
        html = dr.render_headline(self.make_ctx(yoy=yoy))
        self.assertIn("Same week last year (Aug 4–10, 2025): 200.0 kWh, +10.0 kWh", html)
        self.assertIn("Typical week around then (Jul 21–Aug 24, 2025): 180.0 kWh, +30.0 kWh", html)

    def test_yoy_line_shows_only_the_window_that_has_data(self):
        yoy = {"week": None,
               "centered": {"lo": date(2025, 7, 21), "hi": date(2025, 8, 24), "kwh": 180.0}}
        line = dr.render_yoy_line(self.make_ctx(yoy=yoy))
        self.assertNotIn("Same week last year", line)
        self.assertIn("Typical week around then", line)

    def test_usage_table_gains_a_named_yoy_column_when_available(self):
        yoy = {"week": {"lo": date(2025, 8, 4), "hi": date(2025, 8, 10), "kwh": 200.0},
               "centered": None}
        ctx = self.make_ctx(yoy=yoy)
        ctx.usage_rows[0]["delta_yoy_pct"] = 25.0
        html = dr.render_usage_table(ctx)
        self.assertIn("<th>vs Aug 4–10, 2025</th>", html)
        self.assertIn('colspan="7"', html)
        self.assertIn("25%", html)

    def test_outdoor_line_states_temperature_and_no_expectation(self):
        line = dr.render_outdoor_line(self.make_ctx(temp_f=49.2, temp_f_prev=46.7))
        self.assertIn("Outdoors: 49&deg;F average this week, 47&deg;F last week.", line)
        self.assertNotIn("expected", line)
        self.assertIn("Outdoors: 49&deg;F", dr.render_hvac_block(self.make_ctx(temp_f=49.2)))

    def test_outdoor_line_absent_without_weather(self):
        self.assertEqual(dr.render_outdoor_line(self.make_ctx()), "")
        self.assertNotIn("last week.", dr.render_outdoor_line(self.make_ctx(temp_f=49.2)))

    def test_hvac_block_names_both_month_to_date_periods(self):
        html = dr.render_hvac_block(self.make_ctx(week_start=date(2026, 11, 2), day_cat={
            date(2026, 11, 3): {"HVAC": 6.0}, date(2026, 10, 3): {"HVAC": 5.0}}))
        self.assertIn("kWh Nov 1–8", html)
        self.assertIn("vs Oct 1–8", html)
        self.assertNotIn("last month", html)

    def test_render_usage_table_handles_no_baseline_gracefully(self):
        ctx = self.make_ctx(usage_rows=[{"category": "Car", "kwh": 0.0, "cost": 0.0,
                                        "delta_week_pct": None, "delta_12wk_pct": None,
                                        "delta_long_pct": None, "top_circuits": []}])
        html = dr.render_usage_table(ctx)   # must not raise on None deltas
        self.assertIn("Car", html)

    def test_weekly_html_has_explore_links(self):
        import re
        html = dr.build_weekly_html(self.make_ctx())
        hrefs = re.findall(r'href="([^"]*)"', html)
        self.assertEqual(len(hrefs), 3)
        for h in hrefs:
            self.assertTrue(h.startswith("https://span.pianohouseproject.org/"), h)
        self.assertEqual(sum("range=1y" in h for h in hrefs), 1)
        self.assertEqual(sum("show=HVAC" in h for h in hrefs), 1)
        # week link spans Monday 00:00 to next Monday 00:00 Pacific, all categories
        start, _ = dr.local_day_utc_range(date(2026, 8, 3))
        end, _ = dr.local_day_utc_range(date(2026, 8, 10))
        week = [h for h in hrefs if "from=" in h and "show=" not in h]
        self.assertEqual(len(week), 1)
        self.assertIn(f"from={int(start.timestamp() * 1000)}&amp;to={int(end.timestamp() * 1000)}", week[0])

    def test_usage_table_escapes_names_and_pads_nested_row(self):
        ctx = self.make_ctx(usage_rows=[{"category": "R&D <x>", "kwh": 1.0, "cost": 0.1,
                                        "delta_week_pct": None, "delta_12wk_pct": None,
                                        "delta_long_pct": None,
                                        "top_circuits": [("A&B <c>", 1.0)]}])
        html = dr.render_usage_table(ctx)
        self.assertIn("R&amp;D &lt;x&gt;", html)
        self.assertIn("A&amp;B &lt;c&gt;", html)
        self.assertNotIn("<x>", html)
        self.assertIn("padding:6px 12px;border-bottom:1px solid #eee;font-size:11px", html)
        self.assertIn("padding-left:24px", html)

    def test_build_weekly_html_concatenates_sections(self):
        html = dr.build_weekly_html(self.make_ctx())
        self.assertIn("<html>", html)
        self.assertIn("HVAC", html)


class HvacBlockTest(unittest.TestCase):
    def test_mom_comparison_is_a_fair_partial_month_comparison(self):
        day_cat = {
            date(2026, 8, 1): {"HVAC": 3.0}, date(2026, 8, 10): {"HVAC": 4.0},
            date(2026, 7, 1): {"HVAC": 2.0}, date(2026, 7, 10): {"HVAC": 1.0},
            date(2026, 7, 25): {"HVAC": 100.0},   # after the day-10 cutoff — excluded
        }
        this_month, last_month = dr.mom_comparison(day_cat, date(2026, 8, 10), "HVAC")
        self.assertAlmostEqual(this_month, 7.0)    # Aug 1 + Aug 10
        self.assertAlmostEqual(last_month, 3.0)    # Jul 1 + Jul 10 (day-of-month cutoff)

    def test_mom_comparison_clamps_cutoff_to_shorter_month(self):
        day_cat = {
            date(2026, 2, 28): {"HVAC": 5.0},   # last valid Feb day — the clamped cutoff
            date(2026, 3, 31): {"HVAC": 9.0},   # this month, day 31
        }
        this_month, last_month = dr.mom_comparison(day_cat, date(2026, 3, 31), "HVAC")
        self.assertAlmostEqual(this_month, 9.0)
        self.assertAlmostEqual(last_month, 5.0)   # clamped to Feb 28, doesn't read into March

    def test_render_hvac_block_smoke(self):
        day_cat = {date(2026, 8, 3) + timedelta(days=i): {"HVAC": float(i)} for i in range(7)}
        day_cat.update({date(2026, 7, 27) + timedelta(days=i): {"HVAC": 1.0} for i in range(7)})
        ctx = dr.WeeklyContext(
            week_start=date(2026, 8, 3), rows=[], panel_daily={}, day_cat=day_cat,
            categories=["Lights", "HVAC", "Car", "Appliances", "Else"],
            headline={"kwh": 0, "cost": 0, "delta_vs_last_week_pct": None,
                     "delta_vs_12wk_pct": None, "delta_vs_long_pct": None,
                     "top_mover": None, "top_mover_delta_kwh": 0},
            usage_rows=[], week_by_day=[(date(2026, 8, 3) + timedelta(days=i),
                                       {"HVAC": float(i)}) for i in range(7)],
            trend=[], month_trend=[],
        )
        html = dr.render_hvac_block(ctx)
        self.assertIn("HVAC", html)


class CostAxisTest(unittest.TestCase):
    def test_add_cost_axis_sets_twin_ylim_and_label(self):
        ax = mock.MagicMock()
        ax.get_ylim.return_value = (0, 40)
        ax2 = mock.MagicMock()
        ax.twinx.return_value = ax2

        dr._add_cost_axis(ax, "$ / week")

        ax2.set_ylim.assert_called_once_with(0 * dr.ENERGY_RATE, 40 * dr.ENERGY_RATE)
        ax2.set_ylabel.assert_called_once_with("$ / week")


class AnomalyCheckTest(unittest.TestCase):
    def test_query_day_coverage_flux_shape(self):
        flux = dr._day_coverage_flux(date(2026, 8, 17))
        self.assertIn('r._measurement == "circuit_1h" and r._field == "energy_wh_counter"', flux)
        self.assertIn('distinct(column: "_time")', flux)
        # distinct(column: "_time") |> count() errors in real Influx ("count:
        # unsupported aggregate column type time") -- map each distinct time
        # to a plain int and sum those instead (#16 Task 3b fix). distinct()
        # also drops the "_time" column itself, so the map must restore it
        # explicitly -- verified against real data (task-3b-report.md);
        # {r with _value: 1} alone silently produced zero rows.
        self.assertIn('map(fn: (r) => ({_time: r._value, _value: 1})', flux)
        self.assertIn('sum()', flux)
        after_distinct = flux.split('distinct(column: "_time")')[1]
        self.assertNotIn('count()', after_distinct.split('sum()')[0])

    def test_query_day_coverage_converts_summed_count_to_fraction(self):
        tables = [FakeTable([FakeRecord(None, 24, {})])]
        coverage = dr.query_day_coverage(FakeApi(tables), date(2026, 8, 17))
        self.assertAlmostEqual(coverage, 1.0)

    def test_query_day_coverage_is_zero_on_no_rows(self):
        coverage = dr.query_day_coverage(FakeApi([]), date(2026, 8, 17))
        self.assertEqual(coverage, 0.0)

    def test_render_anomaly_email_subject_names_category_and_direction(self):
        import report_baseline as rb
        baseline = rb.compute_baseline([10, 11, 10, 9, 10, 11, 10, 9])
        result = rb.evaluate(20.0, baseline)
        subject, html = dr.render_anomaly_email(
            date(2026, 8, 18),  # Tuesday
            [("HVAC", 20.0, baseline, result)],
            {"HVAC": [("Heat pump", 18.0)]},
        )
        self.assertIn("HVAC", subject)
        self.assertIn("above normal for a Tuesday", subject)
        self.assertIn("Heat pump", html)

    def _anomaly_alerts(self):
        import report_baseline as rb
        base = rb.compute_baseline([10, 11, 10, 9, 10, 11, 10, 9])
        zero = rb.compute_baseline([0, 0, 0, 0, 0, 0, 0, 0])
        return [("HVAC", 20.0, base, rb.evaluate(20.0, base)),
                ("Car", 5.0, zero, rb.evaluate(5.0, zero))]

    def test_anomaly_email_links_each_category(self):
        from email_kit import html_to_text
        alerts = self._anomaly_alerts()
        self.assertIsNone(alerts[1][3].pct)   # median-0 path
        _, html = dr.render_anomaly_email(date(2026, 8, 18), alerts, {})
        text = html_to_text(html)
        for cat in ("HVAC", "Car"):
            self.assertIn(f"Open {cat} on Tuesday in the dashboard", html)
            self.assertIn(f"show={cat}&amp;drill={cat}", html)
        self.assertEqual(html.count('href="https://span.pianohouseproject.org/?from='), 2)
        self.assertIn("https://span.pianohouseproject.org/?from=", text)
        self.assertIn("show=Car&drill=Car", text)

    def test_href_ampersands_are_escaped(self):
        import re
        _, html = dr.render_anomaly_email(date(2026, 8, 18), self._anomaly_alerts(), {})
        hrefs = re.findall(r'href="([^"]*)"', html)
        self.assertTrue(hrefs)
        for h in hrefs:
            self.assertIn("&amp;", h)
            self.assertFalse(re.search(r"&(?!amp;)", h), h)

    def test_anomaly_email_escapes_names_but_text_part_is_plain(self):
        import report_baseline as rb
        from email_kit import html_to_text
        base = rb.compute_baseline([10, 11, 10, 9, 10, 11, 10, 9])
        _, html = dr.render_anomaly_email(
            date(2026, 8, 18), [("R&D <x>", 20.0, base, rb.evaluate(20.0, base))],
            {"R&D <x>": [("A&B <c>", 18.0)]})
        self.assertIn("R&amp;D &lt;x&gt;", html)
        self.assertIn("A&amp;B &lt;c&gt;", html)
        self.assertNotIn("<x>", html)
        text = html_to_text(html)
        self.assertIn("R&D <x>", text)
        self.assertIn("A&B <c>", text)

    def test_day_link_dst_fall_back_is_25_hours(self):
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(dr.day_link(date(2026, 11, 1))).query)
        self.assertEqual(int(q["to"][0]) - int(q["from"][0]), 25 * 3600 * 1000)

    def test_day_link_category_and_drill(self):
        self.assertIn("show=HVAC", dr.day_link(date(2026, 8, 18), "HVAC"))
        self.assertNotIn("drill", dr.day_link(date(2026, 8, 18), "HVAC"))
        self.assertTrue(dr.day_link(date(2026, 8, 18), "HVAC", drill=True).endswith("show=HVAC&drill=HVAC"))
        self.assertNotIn("show", dr.day_link(date(2026, 8, 18)))

    def test_generate_anomaly_check_sends_nothing_on_a_normal_day(self):
        with mock.patch.object(dr, "query_day_coverage", return_value=1.0), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh",
                              return_value=[("Heat pump", d, 10.0)
                                           for d in [date(2026, 8, 18) - timedelta(weeks=w)
                                                    for w in range(9)]]), \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_anomaly_check(mock.Mock(), date(2026, 8, 18))
            sent.assert_not_called()

    def test_generate_anomaly_check_suppresses_on_low_coverage(self):
        with mock.patch.object(dr, "query_day_coverage", return_value=0.4), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh") as q, \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_anomaly_check(mock.Mock(), date(2026, 8, 18))
            q.assert_not_called()   # short-circuits before even fetching rows
            sent.assert_not_called()

    def test_generate_anomaly_check_leaves_state_untouched_when_suppressed(self):
        # HVAC ("Heat pump") is genuinely anomalous (median=10, mad~1.4826, value=40
        # -> z~20.23) but should_alert() says no: a prior alert already exists at
        # last_z=20.0, and 20.23 is not >25% worse than 20.0 (threshold would be 25.0).
        # Verified directly against report_baseline.evaluate()/should_alert() with
        # these exact numbers before writing this test.
        import report_baseline as rb
        target = date(2026, 8, 18)  # Tuesday
        sample_dates = rb.trailing_same_weekday_dates(target, 8)
        rows = [("Heat pump", d, v)
               for d, v in zip(sample_dates, [9, 10, 11, 10, 9, 11, 10, 9])]
        rows.append(("Heat pump", target, 40.0))
        prior_state = rb.SuppressionState(last_alert_date=sample_dates[-1], last_z=20.0)

        with mock.patch.object(dr, "query_day_coverage", return_value=1.0), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
             mock.patch.object(dr.rb, "load_state", return_value=prior_state), \
             mock.patch.object(dr.rb, "save_state") as save, \
             mock.patch.object(dr.rb, "clear_state") as clear, \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_anomaly_check(mock.Mock(), target)
            save.assert_not_called()
            clear.assert_not_called()
            sent.assert_not_called()

    def test_generate_anomaly_check_skips_car_under_full_charge_cap(self):
        # Car/EV charging is normally ~0 on this weekday, so a naive z-score
        # would flag any charging as anomalous -- but up to a full charge's
        # worth should never alert (Nico, 2026-08-23: two false-positive-feeling
        # emails, one for exactly this).
        import report_baseline as rb
        target = date(2026, 8, 22)  # Saturday
        sample_dates = rb.trailing_same_weekday_dates(target, 8)
        rows = [("Tesla Car Charger", d, 0.0) for d in sample_dates]
        rows.append(("Tesla Car Charger", target, 20.6))
        fresh_state = rb.SuppressionState(last_alert_date=None, last_z=None)

        with mock.patch.object(dr, "query_day_coverage", return_value=1.0), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
             mock.patch.object(dr.rb, "load_state", return_value=fresh_state), \
             mock.patch.object(dr.rb, "save_state") as save, \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_anomaly_check(mock.Mock(), target)

        sent.assert_not_called()
        save.assert_not_called()

    def test_generate_anomaly_check_still_alerts_car_over_full_charge_cap(self):
        import report_baseline as rb
        target = date(2026, 8, 22)  # Saturday
        sample_dates = rb.trailing_same_weekday_dates(target, 8)
        rows = [("Tesla Car Charger", d, 0.0) for d in sample_dates]
        rows.append(("Tesla Car Charger", target, 150.0))  # over the 120 kWh cap
        fresh_state = rb.SuppressionState(last_alert_date=None, last_z=None)

        with mock.patch.object(dr, "query_day_coverage", return_value=1.0), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
             mock.patch.object(dr.rb, "load_state", return_value=fresh_state), \
             mock.patch.object(dr.rb, "save_state") as save, \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_anomaly_check(mock.Mock(), target)

        sent.assert_called_once()
        save.assert_called_once()

    def test_generate_anomaly_check_sends_an_email_for_a_fresh_anomaly(self):
        # The actual alert-fires-and-gets-sent path — untested before this fix,
        # which is exactly where Fix 1 (inf% subject) and Fix 2 (week- vs.
        # day-scoped "driven by") lived undetected through eleven task reviews.
        import report_baseline as rb
        target = date(2026, 8, 18)  # Tuesday
        sample_dates = rb.trailing_same_weekday_dates(target, 8)
        rows = [("Heat pump", d, v)
               for d, v in zip(sample_dates, [9, 10, 11, 10, 9, 11, 10, 9])]
        rows.append(("Heat pump", target, 40.0))          # the anomalous day itself
        # A large same-week (Monday) value that is NOT part of the weekday
        # baseline and NOT the anomalous day. If "driven by" were still scoped
        # to the whole week (the Fix 2 bug), this would leak into the total.
        rows.append(("Heat pump", date(2026, 8, 17), 500.0))
        fresh_state = rb.SuppressionState(last_alert_date=None, last_z=None)

        with mock.patch.object(dr, "query_day_coverage", return_value=1.0), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
             mock.patch.object(dr.rb, "load_state", return_value=fresh_state), \
             mock.patch.object(dr.rb, "save_state") as save, \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_anomaly_check(mock.Mock(), target)

        sent.assert_called_once()
        save.assert_called_once()
        html, subject = sent.call_args[0]

        self.assertNotIn("inf", subject)
        self.assertIn("HVAC", subject)

        # Fix 2: "Driven by" must reflect only the target day's circuit total
        # (40.0), never a week-aggregate figure that includes Monday's 500.0.
        self.assertIn("Heat pump (40.0 kWh)", html)
        self.assertNotIn("500.0", html)
        self.assertNotIn("540.0", html)


class HvacModeSplitTest(unittest.TestCase):
    ZERO = {"heat": 0.0, "cool": 0.0, "hot_water": 0.0, "idle": 0.0, "ambiguous": 0.0}

    def make_ctx(self, **overrides):
        return RenderTest.make_ctx(RenderTest(), **overrides)

    def _alerts(self, cat="HVAC"):
        import report_baseline as rb
        base = rb.compute_baseline([10, 11, 10, 9, 10, 11, 10, 9])
        return [(cat, 20.0, base, rb.evaluate(20.0, base))]

    def test_mode_kwh_sums_and_zero_fills(self):
        out = dr.mode_kwh([
            {"start": None, "mode": "heat", "energy_kwh": 0.5},
            {"start": None, "mode": "heat", "energy_kwh": 0.25},
            {"start": None, "mode": "hot_water", "energy_kwh": 1.0},
            {"start": None, "mode": "weird", "energy_kwh": 9.0},
        ])
        self.assertEqual(out, {"heat": 0.75, "cool": 0.0, "hot_water": 1.0,
                               "idle": 0.0, "ambiguous": 0.0})

    def test_mode_kwh_empty_is_all_zero(self):
        self.assertEqual(dr.mode_kwh([]), self.ZERO)

    def test_hvac_split_block_empty_without_data(self):
        self.assertEqual(dr.render_hvac_split_block(self.make_ctx()), "")
        self.assertEqual(dr.render_hvac_split_block(self.make_ctx(hvac_modes=dict(self.ZERO))), "")

    def test_hvac_split_block_rows(self):
        ctx = self.make_ctx(hvac_modes={**self.ZERO, "heat": 6.0, "hot_water": 2.0},
                            hvac_modes_prev={**self.ZERO, "heat": 4.0})
        html = dr.render_hvac_split_block(ctx)
        self.assertIn("<h3>Heat pump by mode</h3>", html)
        self.assertIn('<table class="summary">', html)
        for label in ("Heat", "Cool", "Hot water", "Other"):
            self.assertIn(label, html)
        self.assertIn("6.0", html)
        self.assertIn("75%", html)
        self.assertIn("4.0", html)

    def test_hvac_split_block_other_sums_idle_and_ambiguous(self):
        ctx = self.make_ctx(hvac_modes={**self.ZERO, "heat": 1.0, "idle": 0.5, "ambiguous": 0.25})
        self.assertIn("0.8", dr.render_hvac_split_block(ctx))  # 0.75 -> .1f

    def test_split_block_sits_after_hvac_block_in_sections(self):
        s = dr.WEEKLY_SECTIONS
        self.assertEqual(s.index(dr.render_hvac_split_block), s.index(dr.render_hvac_block) + 1)

    def test_weekly_html_omits_split_without_data(self):
        html = dr.build_weekly_html(self.make_ctx())
        self.assertNotIn("Heat pump by mode", html)

    def test_context_defaults_are_empty_dicts(self):
        ctx = self.make_ctx()
        self.assertEqual(ctx.hvac_modes, {})
        self.assertEqual(ctx.hvac_modes_prev, {})

    def _build(self, hvac):
        with mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=[]), \
             mock.patch.object(dr, "query_daily_panel_kwh", return_value=[]), \
             mock.patch.object(dr, "query_hvac_mode_intervals", **hvac) as q:
            ctx = dr.build_weekly_context(object(), date(2026, 8, 3))
        return ctx, q

    def test_build_weekly_context_fills_both_weeks(self):
        def fake(api, start, stop):
            return [{"start": None, "mode": "heat",
                     "energy_kwh": 2.0 if "2026-08-03" in start else 1.0}]
        ctx, q = self._build({"side_effect": fake})
        self.assertEqual(q.call_count, 2)
        self.assertAlmostEqual(ctx.hvac_modes["heat"], 2.0)
        self.assertAlmostEqual(ctx.hvac_modes_prev["heat"], 1.0)
        self.assertEqual(ctx.hvac_modes["cool"], 0.0)

    def test_build_weekly_context_hvac_windows_are_pacific_mondays(self):
        ctx, q = self._build({"return_value": []})
        starts_stops = [(c.args[1], c.args[2]) for c in q.call_args_list]
        # Aug 3 2026 is a Monday; PDT = UTC-7
        self.assertIn(("2026-08-03T07:00:00Z", "2026-08-10T07:00:00Z"), starts_stops)
        self.assertIn(("2026-07-27T07:00:00Z", "2026-08-03T07:00:00Z"), starts_stops)

    def test_build_weekly_context_empty_query_gives_zero_filled_and_no_block(self):
        ctx, _ = self._build({"return_value": []})
        self.assertEqual(ctx.hvac_modes, self.ZERO)
        self.assertEqual(dr.render_hvac_split_block(ctx), "")

    def test_build_weekly_context_hvac_query_failure_warns_and_leaves_empty(self):
        with self.assertLogs(dr.logger, level="WARNING") as cm:
            ctx, _ = self._build({"side_effect": RuntimeError("influx down")})
        self.assertTrue(any("hvac_mode" in m for m in cm.output))
        self.assertEqual(ctx.hvac_modes, {})
        self.assertEqual(ctx.hvac_modes_prev, {})
        self.assertEqual(dr.render_hvac_split_block(ctx), "")

    def test_anomaly_hvac_block_shows_mode_split(self):
        split = {"heat": 3.2, "cool": 0.0, "hot_water": 1.1, "idle": 0.0, "ambiguous": 0.0}
        _, html = dr.render_anomaly_email(date(2026, 8, 18), self._alerts("HVAC"), {},
                                          mode_split=split)
        self.assertIn("Heat 3.2", html)
        self.assertIn("Hot water 1.1", html)
        _, html = dr.render_anomaly_email(date(2026, 8, 18), self._alerts("Lights"), {},
                                          mode_split=split)
        self.assertNotIn("Heat 3.2", html)

    def test_anomaly_all_zero_split_shows_no_line(self):
        _, html = dr.render_anomaly_email(date(2026, 8, 18), self._alerts("HVAC"), {},
                                          mode_split=dict(self.ZERO))
        self.assertNotIn("Hot water", html)

    def test_anomaly_without_mode_split_unchanged(self):
        subject, html = dr.render_anomaly_email(date(2026, 8, 18), self._alerts("HVAC"), {})
        self.assertIn("HVAC", subject)
        self.assertNotIn("Hot water", html)

    def test_anomaly_email_new_today_label(self):
        subject, html = dr.render_anomaly_email(
            date(2026, 8, 18), self._alerts("HVAC"), {}, episode_since={})
        self.assertIn("<strong>NEW today</strong>", html)
        self.assertNotIn("day", subject.replace("Tuesday", ""))
        # None and since == target_date behave the same as a missing category
        _, html2 = dr.render_anomaly_email(
            date(2026, 8, 18), self._alerts("HVAC"), {},
            episode_since={"HVAC": date(2026, 8, 18)})
        self.assertIn("NEW today", html2)

    def test_anomaly_email_day_n_label_and_subject_suffix(self):
        subject, html = dr.render_anomaly_email(
            date(2026, 11, 4), self._alerts("HVAC"), {},
            episode_since={"HVAC": date(2026, 11, 2)})
        self.assertIn("Day 3 since Nov 2", html)
        self.assertNotIn("NEW today", html)
        self.assertTrue(subject.endswith(" \u00b7 day 3"), subject)

    def test_anomaly_multi_category_subject_unchanged(self):
        subject, html = dr.render_anomaly_email(
            date(2026, 11, 4), self._alerts("HVAC") + self._alerts("Car"), {},
            episode_since={"HVAC": date(2026, 11, 2)})
        self.assertEqual(subject, "\u26a1 Unusual usage: HVAC, Car")
        self.assertIn("Day 3 since Nov 2", html)
        self.assertIn("NEW today", html)

    def test_generate_anomaly_check_passes_episode_since_after_save(self):
        import report_baseline as rb
        target = date(2026, 8, 18)
        sample_dates = rb.trailing_same_weekday_dates(target, 8)
        rows = [("Heat pump", d, v)
                for d, v in zip(sample_dates, [9, 10, 11, 10, 9, 11, 10, 9])]
        rows.append(("Heat pump", target, 40.0))
        saved = rb.SuppressionState(last_alert_date=target, last_z=20.0,
                                    since=date(2026, 8, 16))
        fresh = rb.SuppressionState(last_alert_date=None, last_z=None)
        # first load (pre-alert) is fresh; load after save returns the saved state
        loads = [fresh, saved] + [fresh] * 50
        with mock.patch.object(dr, "query_day_coverage", return_value=1.0), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
             mock.patch.object(dr.rb, "load_state", side_effect=loads), \
             mock.patch.object(dr.rb, "save_state"), \
             mock.patch.object(dr, "query_hvac_mode_intervals", return_value=[]), \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_anomaly_check(mock.Mock(), target)
        html, subject = sent.call_args[0]
        self.assertIn("Day 3 since Aug 16", html)
        self.assertTrue(subject.endswith(" \u00b7 day 3"), subject)

    def _generate(self, category, intervals_kw):
        import report_baseline as rb
        target = date(2026, 8, 18)
        sample_dates = rb.trailing_same_weekday_dates(target, 8)
        rows = [(category if category != "HVAC" else "Heat pump", d, v)
                for d, v in zip(sample_dates, [9, 10, 11, 10, 9, 11, 10, 9])]
        rows.append((rows[0][0], target, 40.0))
        fresh = rb.SuppressionState(last_alert_date=None, last_z=None)
        with mock.patch.object(dr, "query_day_coverage", return_value=1.0), \
             mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
             mock.patch.object(dr.rb, "load_state", return_value=fresh), \
             mock.patch.object(dr.rb, "save_state"), \
             mock.patch.object(dr, "query_hvac_mode_intervals", **intervals_kw) as q, \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_anomaly_check(mock.Mock(), target)
        return q, sent

    def test_generate_anomaly_check_includes_mode_split_for_hvac(self):
        iv = [{"start": None, "mode": "heat", "energy_kwh": 3.2},
              {"start": None, "mode": "hot_water", "energy_kwh": 1.1}]
        q, sent = self._generate("HVAC", {"return_value": iv})
        q.assert_called_once()
        html, _ = sent.call_args[0]
        self.assertIn("Heat 3.2", html)
        self.assertIn("Hot water 1.1", html)

    def test_generate_anomaly_check_survives_hvac_query_failure(self):
        with self.assertLogs(dr.logger, level="WARNING"):
            q, sent = self._generate("HVAC", {"side_effect": RuntimeError("boom")})
        sent.assert_called_once()
        html, _ = sent.call_args[0]
        self.assertNotIn("Hot water", html)


class SendEmailDryRunTest(unittest.TestCase):
    def test_dry_run_logs_and_skips_resend(self):
        # httpx is a bare stub module in this test file (no `post` attribute) --
        # if the DRY_RUN guard didn't short-circuit, this would raise
        # AttributeError, so a clean return is itself proof the guard fired.
        with mock.patch.dict(os.environ, {"DRY_RUN": "1"}):
            with self.assertLogs(dr.logger, level="INFO") as cm:
                dr.send_email("<html></html>", "a subject")
        self.assertTrue(any("DRY_RUN" in line and "a subject" in line for line in cm.output))

    def test_dry_run_0_is_off_matching_the_use_rollups_convention(self):
        # Same string-parsing convention as USE_ROLLUPS: DRY_RUN=0 must mean
        # "off", not "truthy because the env var is set".
        fake_resp = mock.Mock()
        fake_resp.json.return_value = {"id": "abc"}
        with mock.patch.dict(os.environ, {"DRY_RUN": "0"}), \
             mock.patch.object(dr.httpx, "post", create=True, return_value=fake_resp) as post:
            dr.send_email("<html></html>", "a subject")
        post.assert_called_once()
        fake_resp.raise_for_status.assert_called_once()


class GapEmailTest(unittest.TestCase):
    def test_subject_includes_gap_clause_for_a_long_gap(self):
        stats = ch.GapStats(
            present=2540, expected=2880, coverage=2540 / 2880,
            longest_gap_s=10200,
            longest_gap_start=datetime(2026, 7, 30, 12, 50, tzinfo=timezone.utc),
            gaps_over_5m=1,
        )
        subject, _ = dr.render_gap_email(date(2026, 7, 30), stats, {})
        self.assertEqual(
            subject,
            "⚠️ Collector missed 340 polls yesterday (11.8%) — longest gap 2h50m from 05:50",
        )

    def test_subject_omits_gap_clause_for_scattered_loss(self):
        stats = ch.GapStats(
            present=2822, expected=2880, coverage=2822 / 2880,
            longest_gap_s=90,
            longest_gap_start=datetime(2026, 8, 21, 3, 0, tzinfo=timezone.utc),
            gaps_over_5m=0,
        )
        subject, _ = dr.render_gap_email(date(2026, 8, 21), stats, {})
        self.assertEqual(subject, "⚠️ Collector missed 58 polls yesterday (2.0%)")

    def test_html_lists_present_expected_and_breakdown_when_present(self):
        stats = ch.GapStats(
            present=2540, expected=2880, coverage=2540 / 2880,
            longest_gap_s=10200,
            longest_gap_start=datetime(2026, 7, 30, 12, 50, tzinfo=timezone.utc),
            gaps_over_5m=1,
        )
        _, html = dr.render_gap_email(date(2026, 7, 30), stats, {"timeout": 40, "connect": 12})
        self.assertIn("2540", html)
        self.assertIn("2880", html)
        self.assertIn("timeout: 40", html)
        self.assertIn("connect: 12", html)

    def test_html_notes_missing_collector_poll_data_when_breakdown_empty(self):
        stats = ch.GapStats(
            present=2822, expected=2880, coverage=2822 / 2880,
            longest_gap_s=90, longest_gap_start=None, gaps_over_5m=0,
        )
        _, html = dr.render_gap_email(date(2026, 8, 21), stats, {})
        self.assertIn("no collector_poll data for this day (pre-#16 deploy?)", html)


class QueryPollTimestampsTest(unittest.TestCase):
    def test_reads_timestamps_from_value_not_time(self):
        # distinct(column: "_time") moves the distinct timestamps into
        # `_value` and drops the `_time` column -- get_time() KeyErrors
        # against real Influx (caught in the Step 5 dry-run on the Pi).
        ts = datetime(2026, 7, 30, 12, 50, tzinfo=timezone.utc)
        tables = [FakeTable([FakeRecord(None, ts, {})])]
        out = dr.query_poll_timestamps(
            FakeApi(tables), "2026-07-30T00:00:00Z", "2026-07-31T00:00:00Z")
        self.assertEqual(out, [ts])


class QueryPollFailuresTest(unittest.TestCase):
    def test_returns_error_tag_to_count_dict(self):
        # group(columns: ["error"]) |> count() -- one table/record per error
        # tag value, _value carrying the count, error still in rec.values.
        tables = [
            FakeTable([FakeRecord(None, 40, {"error": "timeout"})]),
            FakeTable([FakeRecord(None, 12, {"error": "connect"})]),
        ]
        out = dr.query_poll_failures(
            FakeApi(tables), "2026-07-30T00:00:00Z", "2026-07-31T00:00:00Z")
        self.assertEqual(out, {"timeout": 40, "connect": 12})

    def test_empty_result_gives_empty_dict(self):
        out = dr.query_poll_failures(
            FakeApi([]), "2026-08-21T00:00:00Z", "2026-08-22T00:00:00Z")
        self.assertEqual(out, {})


class GenerateGapCheckTest(unittest.TestCase):
    NO_ALERT_STATS = ch.GapStats(
        present=2870, expected=2880, coverage=2870 / 2880,
        longest_gap_s=60, longest_gap_start=None, gaps_over_5m=0,
    )
    ALERT_STATS = ch.GapStats(
        present=2540, expected=2880, coverage=2540 / 2880,
        longest_gap_s=10200,
        longest_gap_start=datetime(2026, 7, 30, 12, 50, tzinfo=timezone.utc),
        gaps_over_5m=1,
    )

    def test_sends_nothing_when_no_alert_needed(self):
        with mock.patch.object(dr, "query_poll_timestamps", return_value=[]), \
             mock.patch.object(dr.ch, "gap_stats", return_value=self.NO_ALERT_STATS), \
             mock.patch.object(dr, "query_poll_failures") as poll_failures, \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_gap_check(mock.Mock(), date(2026, 8, 21))
            sent.assert_not_called()
            poll_failures.assert_not_called()

    def test_sends_once_when_alert_needed(self):
        with mock.patch.object(dr, "query_poll_timestamps", return_value=[]), \
             mock.patch.object(dr.ch, "gap_stats", return_value=self.ALERT_STATS), \
             mock.patch.object(dr, "query_poll_failures", return_value={"timeout": 5}), \
             mock.patch.object(dr, "send_email") as sent:
            dr.generate_gap_check(mock.Mock(), date(2026, 7, 30))
            sent.assert_called_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
