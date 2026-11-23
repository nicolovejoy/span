# Weekly Briefing Car Split (option C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Monday weekly briefing reports the house and the car separately: house categories stack above zero and EV charging below zero in all three charts, the headline and every delta are house-only, and the car gets its own line.

**Architecture:** One shared constant (`CHARGE_CIRCUIT`, new `pi/ev_circuit.py`) decides which circuit is "the car" for both `charge_detector.py` and the weekly briefing. `build_weekly_context` derives a per-day `house_daily = panel − car` and feeds it to the existing headline / long-run / YoY math in place of `panel_daily`; a new pure `car_stats` builds the car line's numbers. `stack_series` returns the car series negated, and `_draw_stacked` stacks negatives downward from zero on the same axis.

**Tech Stack:** Python 3.11, matplotlib (Agg), unittest run under pytest. No new dependencies.

**Spec:** Decisions recorded in `CLAUDE.md` § Next Steps, first bullet ("Decided 2026-11-23", item 2, "Emails → option C"); mock: https://claude.ai/artifact/YQj61hizkkU4AhJ7cg7TH5 (artboard C, `Trends.dc.html`: house up, car down from a shared zero line, house headline with "vs 12-wk avg", car shown separately as "your driving, not the house"). The mock is the `/trends` page; this plan applies the same picture to the email.

## Global Constraints

- House headline and every delta in the headline block (vs last week, vs 12-wk avg, vs `N-wk avg`, the dormant YoY line) are house-only.
- Car = the circuit named exactly `CHARGE_CIRCUIT` (env `CHARGE_CIRCUIT`, default `"Outdoor / Tesla Car Charger"`), never the `Car` regex in `categories.json`.
- Reconciliation: house stack (house categories + Unmonitored) sums to the house headline kWh; the car bar for the target week equals the car line's kWh.
- Legend stays one row above the plot, in stack order (house bottom→top, then the car).
- Plain-text part (`email_kit.html_to_text`) carries the house headline and the car line numbers.
- Timestamps UTC at rest; calendar weeks Monday-start `America/Los_Angeles` (existing `local_week_start` / `local_day_utc_range`, unchanged).
- Pure math stays separate from Influx I/O, as the file does today. No new dependencies.
- No Pi deploy in this plan. New `pi/*.py` modules need a `COPY` line in `pi/Dockerfile`.
- Test command (343 pass on `email-car-split` at plan time; must stay green):
  `cd pi && uv run --python 3.11 --with pytest --with httpx --with influxdb-client --with tzdata --with matplotlib pytest -q`

## What is house-only today (mapped 2026-11-23)

Nothing. `CLAUDE.md`'s "Weekly section already excludes EV (per-2h-bucket subtract)" is stale: no such code exists in `pi/daily_report.py`. Today in `build_weekly_context` (line ~663):
1. `headline` kWh/cost/all three deltas use `panel_daily` (grid total, car included).
2. `yoy[...]["kwh"]` and `render_yoy_line` use `panel_daily` / `headline["kwh"]` (car included).
3. `top_mover` considers every category incl. `Car`.
4. `Car` is a category from the `categories.json` regex (`Tesla|Car Charger|\bEV\b`), stacked above zero with the rest.
5. The usage table has a `Car` row with its own deltas (that part is already car-only per row).
The only EV special case anywhere is in the daily anomaly check (`generate_anomaly_check`, `EV_FULL_CHARGE_KWH`), which this plan does not touch.

## Decisions

1. `CHARGE_CIRCUIT` moves to a new 1-line module `pi/ev_circuit.py`; `charge_detector.CIRCUIT_NAME` becomes an alias of it. Importing `charge_detector` from `daily_report` was rejected: it pulls `influxdb_client.Point`/`write_api`, which the test stubs lack.
2. In the weekly briefing only, a circuit is `Car` iff its name equals `CHARGE_CIRCUIT`; any other circuit the regex would call `Car` goes to the default bucket (`Else`), and `build_weekly_context` logs one warning naming it. The anomaly check keeps `display_bucket`.
3. House kWh per day = panel − car circuit (unfloored per day); every period sum is floored at 0 once, like Unmonitored.
4. The base service charge stays with the house: headline cost = `cost_n_days(house_kwh, 7)`; car cost is energy-only, `round(kwh * ENERGY_RATE, 2)`.
5. Car line delta: absolute kWh vs last week first, then `_pct_delta_honest` percent (suppressed under 1 kWh), then the 12-wk average as plain context. No car long-run or YoY figure.
6. Car line wording: `Car (EV charging, not in the house figures): <b>54.6 kWh</b> ($6.78), +13.0 kWh vs last week ↑31% · 12-wk avg 42.1 kWh.` It sits after the YoY line so the YoY line reads as part of the house block. Headline leads with `House:`.
7. Car's legend label is `Car ↓`; axis tick labels show absolute values on both the kWh and $ axes; a zero line is drawn only when a car series is present.
8. Usage table: the `Car` row moves to the bottom (after Unmonitored), labelled `Car (EV charging)`, so the rows above it sum to the house. No "house total" row (its cost would disagree with the headline's base charge).
9. Top mover excludes `Car` as well as `Unmonitored`.
10. The sample render is a committed tool, `pi/tools/render_sample_weekly.py`, writing to `~/span-weekly-sample/` (outside the repo).

## Review Focus

1. A day where the charger counter has kWh but the panel is zero-filled (collector gap): house day goes negative; the house week must floor at 0 and never draw a negative house bar. Test in Task 2.
2. A week with no charging at all: no car series, no zero line, no `Car ↓` legend entry; car line reads `0.0 kWh` with no percent. Tests in Tasks 3 and 4.
3. A second circuit matching the `Car` regex (or the charger renamed in the SPAN app): it must not land in the car figures, and the operator must hear about it. Test (warning + `Else`) in Task 1.
4. YoY once last year's data exists (first real case January 2027): both YoY windows must compare house to house. Test in Task 2.
5. Rendering through the real matplotlib (the suite only ever sees the stub): negative bars, the abs formatters and the `↓` glyph. Covered by Task 5's sample render, checked by eye.

---

### Task 1: One car circuit, shared

**Files:**
- Create: `pi/ev_circuit.py`
- Modify: `pi/charge_detector.py:26` (CIRCUIT_NAME)
- Modify: `pi/Dockerfile` (add `COPY ev_circuit.py .` after `COPY charge_detector.py .`)
- Modify: `pi/daily_report.py` — imports; `category_day_kwh` (~line 446); `category_top_circuits` (~line 477); new `weekly_bucket` next to `display_bucket` (~line 941)
- Test: `pi/test_weekly_report.py` (`GroupingTest`), `pi/test_charge_detector.py`

**Interfaces:**
- Produces: `ev_circuit.CHARGE_CIRCUIT: str`; `dr.CHARGE_CIRCUIT` (re-exported via `from ev_circuit import CHARGE_CIRCUIT`); `dr.weekly_bucket(name: str) -> str`; `dr.category_day_kwh(rows, bucket=display_bucket)`; `dr.category_top_circuits(rows, week_start, category, n=5, bucket=display_bucket)`; `dr.stray_car_circuits(rows) -> list[str]`.

- [ ] **Step 1: Write the failing tests** (add to `GroupingTest`)

```python
    def test_weekly_bucket_pins_car_to_the_charge_circuit(self):
        self.assertEqual(dr.weekly_bucket(dr.CHARGE_CIRCUIT), "Car")
        self.assertEqual(dr.weekly_bucket("Garage / EV outlet"), "Else")   # regex says Car
        self.assertEqual(dr.weekly_bucket("Heat pump (HP) / Compressor"), "HVAC")
        self.assertEqual(dr.display_bucket("Garage / EV outlet"), "Car")   # anomaly path unchanged

    def test_category_day_kwh_takes_a_bucket(self):
        rows = [(dr.CHARGE_CIRCUIT, date(2026, 11, 16), 18.0), ("Garage / EV outlet", date(2026, 11, 16), 2.0)]
        self.assertEqual(dr.category_day_kwh(rows, bucket=dr.weekly_bucket),
                         {date(2026, 11, 16): {"Car": 18.0, "Else": 2.0}})
        self.assertEqual(dr.category_day_kwh(rows), {date(2026, 11, 16): {"Car": 20.0}})

    def test_stray_car_circuits_lists_regex_matches_that_are_not_the_charger(self):
        rows = [(dr.CHARGE_CIRCUIT, date(2026, 11, 16), 1.0), ("Garage / EV outlet", date(2026, 11, 16), 1.0),
                ("Garage / EV outlet", date(2026, 11, 17), 1.0)]
        self.assertEqual(dr.stray_car_circuits(rows), ["Garage / EV outlet"])
```

Add to `pi/test_charge_detector.py` (not `test_weekly_report.py`: that file installs an `influxdb_client` stub without `Point`, so importing `charge_detector` from it is order-dependent):

```python
class SharedCircuitTest(unittest.TestCase):
    def test_charge_detector_and_report_share_one_circuit_name(self):
        import ev_circuit
        self.assertEqual(cd.CIRCUIT_NAME, ev_circuit.CHARGE_CIRCUIT)
        self.assertEqual(ev_circuit.CHARGE_CIRCUIT, "Outdoor / Tesla Car Charger")
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd pi && uv run --python 3.11 --with pytest --with httpx --with influxdb-client --with tzdata --with matplotlib pytest -q test_weekly_report.py -k "weekly_bucket or takes_a_bucket or stray_car"` and `pytest -q test_charge_detector.py -k share_one`
Expected: FAIL, `AttributeError: module 'daily_report' has no attribute 'CHARGE_CIRCUIT'` / `ModuleNotFoundError: ev_circuit`.

- [ ] **Step 3: Implement**

`pi/ev_circuit.py`:

```python
"""The one circuit that is "the car": EV charging. Shared by charge_detector
and the weekly briefing so both count the same energy (exact name, not the
Car regex in categories.json)."""
import os

CHARGE_CIRCUIT = os.getenv("CHARGE_CIRCUIT", "Outdoor / Tesla Car Charger")
```

`charge_detector.py:26` → `from ev_circuit import CHARGE_CIRCUIT as CIRCUIT_NAME` (keep the name; line 47 uses it). `daily_report.py`: `from ev_circuit import CHARGE_CIRCUIT`. `weekly_bucket`: `"Car"` if `name == CHARGE_CIRCUIT`; else `display_bucket(name)`, with `"Car"` replaced by the default bucket from `_load_bucket_rules()`. `stray_car_circuits`: sorted unique names where `display_bucket(name) == "Car"` and `name != CHARGE_CIRCUIT`. `category_day_kwh` and `category_top_circuits` gain a `bucket` keyword used in place of `display_bucket`; defaults keep every existing caller identical. Add the Dockerfile `COPY`.

- [ ] **Step 4: Run the full suite**

Run: the Global Constraints test command. Expected: all pass (343 + 4).

- [ ] **Step 5: Commit**

```bash
git add pi/ev_circuit.py pi/charge_detector.py pi/Dockerfile pi/daily_report.py pi/test_weekly_report.py pi/test_charge_detector.py
git commit -m "feat(pi): one shared CHARGE_CIRCUIT; weekly bucket pins Car to it"
```

---

### Task 2: House-only headline and deltas, car numbers in the context

**Files:**
- Modify: `pi/daily_report.py` — `headline_stats` (~line 598), `WeeklyContext` (~line 626), `build_weekly_context` (~line 663–816); new pure `house_daily` and `car_stats` after `avg_week_kwh` (~line 556)
- Test: `pi/test_weekly_report.py` (`HeadlineTest`, `BuildWeeklyContextTest`, new `CarStatsTest`)

**Interfaces:**
- Consumes: Task 1's `weekly_bucket`, `stray_car_circuits`, `CHARGE_CIRCUIT`, `bucket=` keywords.
- Produces:
  - `house_daily(panel_daily: dict[date, float], car_daily: dict[date, float]) -> dict[date, float]` — per day `panel − car`, unfloored, keyed by `panel_daily`'s days.
  - `car_stats(car_daily: dict[date, float], week_start: date) -> dict` with keys `kwh`, `cost` (energy-only, 2 dp), `last_week_kwh`, `delta_kwh`, `delta_pct` (`_pct_delta_honest` vs last week), `avg12_kwh` (mean of the 12 weeks from `trailing_week_starts(week_start, 12)`).
  - `WeeklyContext.car: dict = field(default_factory=dict)` (empty dict = no car line).
  - `ctx.headline` keeps its keys; `kwh`/`cost`/deltas are now house. `ctx.yoy[...]["kwh"]` is house. `ctx.usage_rows` order: house categories (display order, `Car` skipped), `Unmonitored`, then `Car`.
  - `ctx.day_cat` is built with `bucket=weekly_bucket`, so `week_by_day` / `trend` / `month_trend` carry `"Car"` = charger circuit only.

- [ ] **Step 1: Write the failing tests**

```python
class CarStatsTest(unittest.TestCase):
    WEEK = date(2026, 11, 16)

    def test_car_stats_week_last_week_and_12wk_avg(self):
        car = {self.WEEK + timedelta(days=i): 7.8 for i in range(7)}            # 54.6
        car.update({self.WEEK - timedelta(days=7 - i): 5.94 for i in range(7)})  # 41.58 last week
        s = dr.car_stats(car, self.WEEK)
        self.assertAlmostEqual(s["kwh"], 54.6)
        self.assertAlmostEqual(s["cost"], round(54.6 * dr.ENERGY_RATE, 2))
        self.assertAlmostEqual(s["delta_kwh"], 54.6 - 41.58)
        self.assertAlmostEqual(s["delta_pct"], (54.6 - 41.58) / 41.58 * 100)
        self.assertAlmostEqual(s["avg12_kwh"], 41.58 / 12)

    def test_no_charging_gives_zeros_and_no_percent(self):
        s = dr.car_stats({}, self.WEEK)
        self.assertEqual((s["kwh"], s["delta_kwh"], s["avg12_kwh"]), (0.0, 0.0, 0.0))
        self.assertIsNone(s["delta_pct"])

    def test_house_daily_is_panel_minus_car_unfloored(self):
        d = self.WEEK
        self.assertEqual(dr.house_daily({d: 40.0, d + timedelta(days=1): 0.0}, {d: 15.0, d + timedelta(days=1): 5.0}),
                         {d: 25.0, d + timedelta(days=1): -5.0})
```

Add to `HeadlineTest`:

```python
    def test_top_mover_never_names_the_car(self):
        stats = dr.headline_stats(100.0, 100.0, 100.0, 100.0,
                                  week_cat={"HVAC": 50.0, "Car": 60.0}, last_week_cat={"HVAC": 45.0, "Car": 0.0})
        self.assertEqual(stats["top_mover"], "HVAC")
```

Add to `BuildWeeklyContextTest` (uses its `_build`; `C = dr.CHARGE_CIRCUIT`):

```python
    def test_headline_and_deltas_are_house_only_and_bars_reconcile(self):
        week = date(2026, 8, 3)
        hist = [week - timedelta(days=i) for i in range(1, 71)]
        this = [week + timedelta(days=i) for i in range(7)]
        C = dr.CHARGE_CIRCUIT
        # house 20/day throughout; car 0 in history, 30/day this week; panel = house + car
        rows = ([("Heat pump", d, 15.0) for d in hist + this] + [(C, d, 30.0) for d in this])
        panel = {**{d: 20.0 for d in hist}, **{d: 50.0 for d in this}}
        ctx = self._build(rows, panel, week)
        self.assertAlmostEqual(ctx.headline["kwh"], 140.0)
        self.assertAlmostEqual(ctx.headline["cost"], dr.cost_n_days(140.0, 7))
        for k in ("delta_vs_last_week_pct", "delta_vs_12wk_pct", "delta_vs_long_pct"):
            self.assertAlmostEqual(ctx.headline[k], 0.0, msg=k)
        self.assertAlmostEqual(ctx.car["kwh"], 210.0)
        wk = ctx.trend[-1][1]
        self.assertAlmostEqual(sum(v for c, v in wk.items() if c != "Car"), ctx.headline["kwh"])
        self.assertAlmostEqual(wk["Car"], ctx.car["kwh"])
        self.assertEqual([r["category"] for r in ctx.usage_rows][-2:], ["Unmonitored", "Car"])

    def test_house_week_floors_at_zero_when_the_panel_is_missing(self):
        week = date(2026, 8, 3)
        this = [week + timedelta(days=i) for i in range(7)]
        ctx = self._build([(dr.CHARGE_CIRCUIT, d, 10.0) for d in this], {d: 0.0 for d in this}, week)
        self.assertEqual(ctx.headline["kwh"], 0.0)
        self.assertAlmostEqual(ctx.car["kwh"], 70.0)

    def test_yoy_compares_house_to_house(self):
        week = date(2026, 11, 2)
        days = [date(2025, 10, 1) + timedelta(days=i) for i in range((date(2026, 11, 9) - date(2025, 10, 1)).days)]
        C = dr.CHARGE_CIRCUIT
        rows = [("Heat pump", d, 10.0) for d in days] + [(C, d, 25.0 if d >= week else 0.0) for d in days]
        ctx = self._build(rows, {d: 20.0 + (25.0 if d >= week else 0.0) for d in days}, week)
        self.assertAlmostEqual(ctx.yoy["week"]["kwh"], 140.0)
        self.assertAlmostEqual(ctx.headline["kwh"], 140.0)   # car's 175 kWh excluded

    def test_stray_car_circuit_is_logged_and_kept_out_of_the_car(self):
        week = date(2026, 8, 3)
        with self.assertLogs(dr.logger, level="WARNING") as logs:
            ctx = self._build([("Garage / EV outlet", week, 3.0)], {week: 3.0}, week)
        self.assertIn("Garage / EV outlet", "\n".join(logs.output))
        self.assertEqual(ctx.car["kwh"], 0.0)
```

The existing `test_yoy_fills_in_once_last_years_data_exists`, `test_long_run_baseline_...` and `test_chart_periods_include_unmonitored_and_sum_to_the_panel` have no car rows, so they must pass unchanged (house == panel there).

- [ ] **Step 2: Run to verify they fail**

Run: the test command with `test_weekly_report.py -k "CarStats or house or car or stray"`. Expected: FAIL, `AttributeError: ... 'car_stats'`.

- [ ] **Step 3: Implement**

`house_daily`, `car_stats` as specified (period sums via `_sum_days`; floor `kwh` and `last_week_kwh` at 0). `headline_stats`: exclude `{"Unmonitored", "Car"}` from movers. In `build_weekly_context`:
1. `day_cat = category_day_kwh(rows, bucket=weekly_bucket)`; for each name in `stray_car_circuits(rows)` log `logger.warning("weekly briefing: %r matches the Car pattern but is not CHARGE_CIRCUIT %r; counted as house", name, CHARGE_CIRCUIT)`.
2. `car_daily = {d: kwh for name, d, kwh in rows if name == CHARGE_CIRCUIT}` (summed per day); `house = house_daily(panel_daily, car_daily)`.
3. Replace `panel_daily` with `house` in: `week_panel_kwh`, `last_week_panel_kwh`, `trailing12_panel` (each sum floored with `max(0.0, …)`), `avg_week_kwh(…, long_days)` for the headline, and the `yoy[key]["kwh"]` sums. Keep `panel_daily` for `data_days`, `yoy_windows`, `unmon_daily`, `unmon_week`, `unmon_month`.
4. Pass `this_week_cat` / `last_week_cat` as-is (movers now exclude Car). `category_top_circuits(..., bucket=weekly_bucket)`.
5. Usage rows: loop `categories` skipping `"Car"`, append Unmonitored as today, then build the `"Car"` row with the same dict shape (same per-category code path) and append it last.
6. `car=car_stats(car_daily, week_start)` into the `WeeklyContext`.
Update the `WeeklyContext` and `headline_stats` docstrings to say house-only.

- [ ] **Step 4: Run the full suite** — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pi/daily_report.py pi/test_weekly_report.py
git commit -m "feat(pi): weekly headline and deltas are house-only; car stats in context"
```

---

### Task 3: Charts — house above zero, car below

**Files:**
- Modify: `pi/daily_report.py` — `stack_series` (~line 1071), `_draw_stacked` (~line 1084), `_add_cost_axis` (~line 950); new `_abs_kwh_tick`, `_abs_cost_tick` beside `_add_cost_axis`
- Modify: `pi/conftest.py` — stub `matplotlib.ticker.FuncFormatter`
- Test: `pi/test_weekly_report.py` (`StackSeriesTest`, `CostAxisTest`)

**Interfaces:**
- Consumes: periods whose `"Car"` key is the charger only (Task 2).
- Produces: `stack_series(periods, categories) -> list[tuple[str, list[float]]]` — house categories in display order (`"Car"` skipped), then `"Unmonitored"`, then `"Car"` with values `-max(0, v)`; all-zero series omitted. `CAR_LEGEND = "Car ↓"`. `_abs_kwh_tick(v: float, _pos) -> str` → `f"{abs(v):g}"`; `_abs_cost_tick(v: float, _pos) -> str` → `f"${abs(v):,.2f}"`.

- [ ] **Step 1: Write the failing tests** (add to `StackSeriesTest`)

```python
    def test_car_stacks_last_and_below_zero(self):
        series = dr.stack_series([{"HVAC": 5.0, "Car": 12.0, "Unmonitored": 1.0}], self.CATS)
        self.assertEqual(series, [("HVAC", [5.0]), ("Unmonitored", [1.0]), ("Car", [-12.0])])

    def test_draw_stacked_puts_car_under_the_zero_line(self):
        ax = mock.MagicMock()
        dr._draw_stacked(ax, ["a", "b"], [{"HVAC": 5.0, "Car": 12.0}, {"HVAC": 4.0, "Car": 0.0}], self.CATS, 0.7)
        car = [c for c in ax.bar.call_args_list if c.kwargs["label"] == dr.CAR_LEGEND]
        self.assertEqual(len(car), 1)
        self.assertEqual(list(car[0].args[1]), [-12.0, -0.0])
        self.assertEqual(list(car[0].kwargs["bottom"]), [0.0, 0.0])
        ax.axhline.assert_called_once()
        self.assertEqual(ax.axhline.call_args.args[0], 0)
        self.assertEqual(ax.legend.call_args.kwargs["ncol"], 2)   # one row: HVAC, Car ↓

    def test_no_zero_line_without_charging(self):
        ax = mock.MagicMock()
        dr._draw_stacked(ax, ["a"], [{"HVAC": 5.0}], self.CATS, 0.7)
        ax.axhline.assert_not_called()

    def test_tick_labels_show_magnitudes(self):
        self.assertEqual(dr._abs_kwh_tick(-50.0, 0), "50")
        self.assertEqual(dr._abs_cost_tick(-6.2, 0), "$6.20")
```

Existing `test_unmonitored_stacks_last_...`, `test_legend_lists_only_series_that_are_drawn`, `test_negative_values_are_floored`, `test_every_drawn_series_has_a_colour` and `CostAxisTest` must pass unchanged.

- [ ] **Step 2: Run to verify they fail** — `-k "StackSeries or tick_labels"`. Expected: FAIL (`Car` is drawn positive / `CAR_LEGEND` missing).

- [ ] **Step 3: Implement**

`_draw_stacked` keeps two running baselines (`up`, `down`); the `"Car"` series bars from `down` (its values are already negative) and lowers it, every other series bars from `up`. `label=CAR_LEGEND if cat == "Car" else cat`. After the bars, if a `"Car"` series was drawn: `ax.axhline(0, color="#3f3f46", linewidth=1)`. Always set `ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(_abs_kwh_tick))`. `_add_cost_axis` switches its formatter to `FuncFormatter(_abs_cost_tick)` (limits logic unchanged, so the twin lines up below zero too). `conftest.py`: `_mpl_ticker.FuncFormatter = lambda *a, **k: None`. The three `render_*_chart` functions need no change; update `stack_series`'s docstring (bar height above zero = house total, below = car).

- [ ] **Step 4: Run the full suite** — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pi/daily_report.py pi/conftest.py pi/test_weekly_report.py
git commit -m "feat(pi): weekly charts stack the car below zero on a shared axis"
```

---

### Task 4: Headline copy, car line, usage table, plain text

**Files:**
- Modify: `pi/daily_report.py` — `render_headline` (~line 1049), new `render_car_line` after `render_yoy_line` (~line 1031), `render_usage_table` (~line 1160)
- Test: `pi/test_weekly_report.py` (`RenderTest`)

**Interfaces:**
- Consumes: `ctx.car` (Task 2 keys), `_delta_arrow_pct`, `_esc`, `email_kit.html_to_text`.
- Produces: `render_car_line(ctx: WeeklyContext) -> str` ("" when `ctx.car` is empty).

- [ ] **Step 1: Write the failing tests** (add to `RenderTest`; `CAR = {"kwh": 54.6, "cost": 6.78, "last_week_kwh": 41.6, "delta_kwh": 13.0, "delta_pct": 31.25, "avg12_kwh": 42.1}`)

```python
    def test_headline_is_labelled_house_and_car_has_its_own_line(self):
        html = dr.render_headline(self.make_ctx(car=CAR))
        self.assertIn("House: 210.0 kWh", html)
        self.assertIn("Car (EV charging, not in the house figures): <strong>54.6 kWh</strong> ($6.78), "
                      "+13.0 kWh vs last week", html)
        self.assertIn("&uarr;31%", html)
        self.assertIn("12-wk avg 42.1 kWh.", html)

    def test_car_line_order_house_then_yoy_then_car(self):
        yoy = {"week": {"lo": date(2025, 8, 4), "hi": date(2025, 8, 10), "kwh": 200.0}, "centered": None}
        html = dr.render_headline(self.make_ctx(car=CAR, yoy=yoy))
        self.assertLess(html.index("House:"), html.index("Same week last year"))
        self.assertLess(html.index("Same week last year"), html.index("Car (EV charging"))

    def test_car_line_without_charging_has_no_percent(self):
        car = {"kwh": 0.0, "cost": 0.0, "last_week_kwh": 0.0, "delta_kwh": 0.0, "delta_pct": None, "avg12_kwh": 0.0}
        line = dr.render_car_line(self.make_ctx(car=car))
        self.assertIn("<strong>0.0 kWh</strong> ($0.00), +0.0 kWh vs last week", line)
        self.assertNotIn("%", line)

    def test_car_line_absent_without_car_data(self):
        self.assertEqual(dr.render_car_line(self.make_ctx()), "")

    def test_usage_table_labels_the_car_row(self):
        rows = [{"category": "Car", "kwh": 54.6, "cost": 6.78, "delta_week_pct": None, "delta_12wk_pct": None,
                 "delta_long_pct": None, "top_circuits": []}]
        self.assertIn("<td>Car (EV charging)</td>", dr.render_usage_table(self.make_ctx(usage_rows=rows)))

    def test_plain_text_part_carries_house_and_car_numbers(self):
        from email_kit import html_to_text
        text = html_to_text(dr.build_weekly_html(self.make_ctx(car=CAR)))
        self.assertIn("House: 210.0 kWh ($27.87)", text)
        self.assertIn("Car (EV charging, not in the house figures): 54.6 kWh ($6.78), +13.0 kWh vs last week ↑31%", text)
```

`test_render_headline_names_the_top_mover` must still pass.

- [ ] **Step 2: Run to verify they fail** — `-k "house or car_line or car_row or plain_text"`. Expected: FAIL.

- [ ] **Step 3: Implement**

`render_headline`: `<strong>House: {kwh:.1f} kWh</strong>`, rest of the paragraph unchanged, then `render_yoy_line(ctx)`, then `render_car_line(ctx)`. `render_car_line` returns `\n<p style="font-size:13px;color:#444;">Car (EV charging, not in the house figures): <strong>{kwh:.1f} kWh</strong> (${cost:.2f}), {delta_kwh:+.1f} kWh vs last week{_delta_arrow_pct(delta_pct, "")} &middot; 12-wk avg {avg12_kwh:.1f} kWh.</p>`. `render_usage_table`: display label `"Car (EV charging)"` when `r["category"] == "Car"`, still through `_esc`.

- [ ] **Step 4: Run the full suite** — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pi/daily_report.py pi/test_weekly_report.py
git commit -m "feat(pi): weekly headline says House; car gets its own line"
```

---

### Task 5: Sample render from fixture data, docs, full suite

**Files:**
- Create: `pi/tools/render_sample_weekly.py`
- Modify: `CLAUDE.md` — `daily_report.py` paragraph (add one sentence: weekly briefing is house-only with the car below zero, pinned to `CHARGE_CIRCUIT` in `pi/ev_circuit.py`); Next Steps "Decided 2026-11-23" item (2) → "built on branch `email-car-split`, not deployed"; the "EV monthly + annual cost rollup" bullet: delete the stale "(per-2h-bucket subtract)" claim
- Modify: `pi/daily_report.py:1456-1457` comment ("the weekly report excludes it from comparisons") — now true; leave as is unless wording is off.

**Interfaces:**
- Consumes: `dr.build_weekly_context`, `dr.build_weekly_html`, `email_kit.html_to_text`, `dr.CHARGE_CIRCUIT`.
- Produces: `python pi/tools/render_sample_weekly.py OUT_DIR` writes `OUT_DIR/weekly.html`, `OUT_DIR/weekly.txt`, `OUT_DIR/chart-1.png`…`chart-3.png` (plus the HVAC chart as `chart-4.png`) and prints house kWh, car kWh and `reconciles: True`.

- [ ] **Step 1: Write the script**

Deterministic fixture, no Influx: 400 days ending Sunday 2026-11-22, target week `date(2026, 11, 16)`. Circuits per day: `"Heat pump (HP) / Compressor"` (HVAC, ~12–17 kWh, higher on weekends), `"Kitchen Lights"` (~7.5), `"Kitchen / Oven"` (~3), `"Garage outlet"` (Else, ~0.5), and `dr.CHARGE_CIRCUIT` at 18 kWh on three weekdays per week except a two-week gap mid-October (mirrors the mock's near-zero Oct 12/19 weeks). Panel per day = sum of circuits + 3.0 (Unmonitored). Patch with `unittest.mock.patch.object` exactly as `BuildWeeklyContextTest._build` does: `query_daily_circuit_counter_kwh`, `query_daily_panel_kwh`, plus `query_hvac_mode_intervals` → `[]` and `query_mean_temp_f` → `44.0`. Call `build_weekly_context(object(), date(2026, 11, 16))`, write the HTML and `html_to_text` output, decode each `data:image/png;base64,` src into `chart-N.png`, then assert house stack reconciliation (`sum` of `ctx.trend[-1][1]` minus `Car` == `ctx.headline["kwh"]`, `ctx.trend[-1][1]["Car"] == ctx.car["kwh"]`, within 1e-6) and print the result. `sys.path.insert` the `pi/` directory; create `OUT_DIR` with `mkdir(parents=True, exist_ok=True)`.

- [ ] **Step 2: Run it with the real matplotlib (outside pytest, so the conftest stub is not loaded)**

Run: `uv run --python 3.11 --with httpx --with influxdb-client --with tzdata --with matplotlib python pi/tools/render_sample_weekly.py ~/span-weekly-sample`
Expected: prints house and car kWh and `reconciles: True`; `~/span-weekly-sample/` holds `weekly.html`, `weekly.txt`, 4 PNGs.

- [ ] **Step 3: Look at the output**

Open the PNGs with the Read tool (it renders images) and check: house bars above a dark zero line, car bars below it, legend one row ending `Car ↓`, both axes show positive tick labels below zero, the mid-October weeks show no car bar. Check `weekly.txt` has the `House:` headline and the `Car (EV charging, not in the house figures):` line. Fix and re-run if any fails. Leave the directory in place for Nico.

- [ ] **Step 4: Update the docs** as listed under Files.

- [ ] **Step 5: Run the full suite**

Run: `cd pi && uv run --python 3.11 --with pytest --with httpx --with influxdb-client --with tzdata --with matplotlib pytest -q`
Expected: all pass, count = 343 + tests added in Tasks 1–4.

- [ ] **Step 6: Commit**

```bash
git add pi/tools/render_sample_weekly.py CLAUDE.md
git commit -m "chore(pi): sample weekly render tool; docs for the car split"
```
