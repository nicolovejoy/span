# Alert Materiality Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daily anomaly-check email quiet unless a deviation is worth money ($1.50 or more), and judge HVAC heating against days of similar outdoor temperature instead of the same weekday, so cold snaps stop producing alerts.

**Architecture:** All new decision logic is pure and lives in the existing pure module `pi/report_baseline.py` (already copied into the image, so no Dockerfile change). `pi/daily_report.py` gains two read-only Influx queries (daily mean outdoor temperature, daily hot-water kWh), a pure per-day `evaluate_day` that turns fetched dicts into verdicts, and HVAC-specific email copy. `generate_anomaly_check` keeps its coverage guard, Car rule, and repeat-suppression state handling and now acts on `evaluate_day`'s verdicts. A read-only backtest tool, `pi/tools/alert_backtest.py`, runs the same production functions against the live Pi data.

**Tech Stack:** Python 3.11 stdlib only (the Pi image installs a fixed set), pytest/unittest, Flux via `influxdb-client`.

**Spec:** No separate spec. Source of truth: the owner's binding decision of 2026-11-23 (the "Ask Nico next session (a)" paragraph in `CLAUDE.md`, plus the four rules restated below), and the 60-day backtest write-up (2026-09-24 to 2026-11-22) whose method this plan reproduces.

## The rule (binding, restated so every task works from the same text)

1. **Materiality floor, every category.** A category may alert only if `round(abs(excess_kwh) * ENERGY_RATE, 2) >= 1.50`, where `excess_kwh = value - baseline center`. It applies to below-normal days too. `ENERGY_RATE` is the flat `0.1241 $/kWh` from `pi/rates.py`, so the floor is about 12.1 kWh. The rounding to cents is deliberate: the rule is "the dollar figure the email would print is at least $1.50", which makes it testable without float edge cases.
2. **A sub-floor day counts as normal.** The floor is folded into `AnomalyResult.is_anomalous`. A day that passes the statistical test but not the floor therefore clears the category's episode state (`rb.clear_state`), exactly as a statistically normal day does. The backtest simulated this; the repeat-suppression code itself is unchanged.
3. **HVAC split.** HVAC is two parts:
   1. **hot water** = the day's `hvac_mode` `energy_hot_water_kwh` sum, judged on the existing same-weekday baseline (median/MAD of the trailing 8 same-weekday days, needs 6 of 8);
   2. **space** = the HVAC category's counter kWh minus hot water (it includes the Control circuit), judged against the days in the previous 60 (target−60 … target−1) whose Pacific-day mean outdoor temperature is within ±3.0°F of the target's (inclusive). Center = the **mean** of those days' space kWh, spread = `rb.mad` of the same days (MAD about their median), then the unchanged `rb.evaluate` test (|z| > 3 and |diff| > max(20% of center, 1 kWh); MAD 0 → 50% fallback). A day is eligible as a similar day only if it has a temperature mean (≥ 20 hourly readings), a hot-water value, and an HVAC value. With fewer than 3 similar days (or no temperature for the target), space falls back to the same-weekday baseline of space kWh (needs 6 of 8).
4. **HVAC combination (chosen rule).** Each part runs its own statistical test. **A part's excess counts only if that part fails its own test** (`part.result.is_anomalous`); a part within its normal range contributes 0. The counted excesses are **added with sign**: `combined_kwh = sum(part.value - part.center for counted parts)`. HVAC alerts iff at least one part is counted **and** the floor holds on `combined_kwh` (rule 1). Opposite-sign counted parts net out (a +14 kWh space excess and a −3 kWh hot-water shortfall is +11 kWh, $1.37, no alert). For repeat suppression, the combined result's `z` is the signed z of the counted part with the largest |z| (`None` if no counted part has a z). `pct = abs(combined_kwh) / (space center + hot-water center) * 100` (None when that sum is 0).
   Why this rule: it is the owner's "two excesses added, floor on the sum"; it keeps a part's ordinary day-to-day noise from pushing the total over the floor; and signed addition reports the real net money effect.
5. **HVAC falls back to the old path** (whole-category same-weekday baseline, plus the floor) when the target day has no hot-water value (classifier down, query failed, or before 2026-01-04), or when neither part has enough samples.
6. **Unchanged:** data-gap alert, cooling alert, repeat suppression and episode state (`should_alert`, `save_state`, `load_state`, `clear_state`), the Car rule (`value <= EV_FULL_CHARGE_KWH` clears state and skips; the floor also applies to Car above the cap), the 90% day-coverage guard, the 6-of-8 per-category sample guard, the weekly briefing, and the email copy of non-HVAC categories.

## Global Constraints

- Work only in the worktree `/Users/nico/src/span-worktrees/alert-floor`, branch `alert-floor`. Never push, merge, or deploy to the Pi. No `vercel` commands.
- Never read `.env` files or other secret material, and never name a `.env` path in a shell command.
- Run the Pi suite with: `cd /Users/nico/src/span-worktrees/alert-floor/pi && uv run --python 3.11 --with pytest --with httpx --with influxdb-client --with tzdata --with matplotlib pytest -q`. Baseline at plan start: **343 passed**. No task may leave a previously passing test failing. The existing anomaly tests in `pi/test_weekly_report.py` (`AnomalyCheckTest`, `HvacModeSplitTest`) must pass **unmodified**; their HVAC cases use a mock client whose new queries raise, which must land on the fallback path of rule 5.
- New logic goes in `pi/report_baseline.py` (pure, already in the image) and `pi/daily_report.py`. Do not add a new `pi/*.py` module the container imports; if you must, add a `COPY <name> .` line to `pi/Dockerfile` next to `COPY report_baseline.py .` (a missing one crashloops `daily-report`). `pi/tools/alert_backtest.py` is run over stdin and needs no COPY line.
- Pure functions take dicts and lists and touch no Influx, no file, no clock. Tests must not touch the network, InfluxDB or Resend.
- UTC at rest, Pacific on display. Pacific days come from `LOCAL_TZ` / `local_day_utc_range` / `_local_day` in `daily_report.py`, or `datetime.astimezone(tz).date()` in pure code. Never build a date from `.isoformat()[:10]`.
- `report_baseline.Baseline.median` holds the baseline **center**: the median on the weekday path, the mean on the weather path. Do not rename the field (existing callers and tests use it).
- Write each task's tests first, run them and see them fail, then implement.
- Commit after each task. Messages end with the `Co-Authored-By:` line your session's attribution instructions give.

## Verified while planning

The Task 1–2 code and tests in this plan were run as written in a scratch copy (32 pass), and the Task 3–4 code, a straightforward renderer implementation of Task 4's copy, and their tests were run against a scratch copy of `pi/` (full suite 363 pass, existing anomaly tests unmodified). The Task 5 bundler output parses and its bootstrap imports the bundled modules. Nothing was run against the Pi.

## Review Focus

- The combination rule exactly as stated in rule 4: a non-anomalous part never contributes to `combined_kwh`; signs are kept; the floor uses `round(..., 2)`.
- `load_state` is still called only for categories that reach the "judge" action (an existing test feeds `load_state` a side-effect list in category order).
- A sub-floor anomalous day clears state (rule 2), so the next material day reads "NEW today".
- DST: `daily_mean_temps` puts all 25 hours of 2026-11-01 into 2026-11-01.
- The fetch window is now target−60 days, not target−56; similar days never include the target or later days.
- The hot-water query requires ≥ 260 intervals in the day, so a day with a classifier outage is not used as a similar day or a weekday sample.

---

### Task 1: Pure floor and temperature helpers in `report_baseline.py`

**Files:**
- Modify: `pi/report_baseline.py`
- Test: `pi/test_report_baseline.py` (new test classes appended)

**Interfaces (produces):**

```python
from dataclasses import replace
from datetime import datetime, tzinfo

MATERIALITY_FLOOR_USD = 1.50
SIMILAR_TEMP_F = 3.0          # ± band, inclusive
SIMILAR_LOOKBACK_DAYS = 60    # target-60 .. target-1
SIMILAR_MIN_DAYS = 3
MIN_TEMP_HOURS = 20           # hourly readings needed for a day's mean


def material(excess_kwh: float, rate: float, floor_usd: float = MATERIALITY_FLOOR_USD) -> bool:
    """True when the excess, priced at `rate` and rounded to cents, is at least the floor.
    Sign-agnostic: a below-normal day is judged on its shortfall."""
    return round(abs(excess_kwh) * rate, 2) >= floor_usd


def with_floor(result: AnomalyResult, excess_kwh: float, rate: float,
               floor_usd: float = MATERIALITY_FLOOR_USD) -> AnomalyResult:
    """`result` with is_anomalous ANDed with material(); z and pct unchanged."""
    return replace(result, is_anomalous=result.is_anomalous and material(excess_kwh, rate, floor_usd))


def daily_mean_temps(points: list[tuple[datetime, float]], tz: tzinfo,
                     min_hours: int = MIN_TEMP_HOURS) -> dict[date, float]:
    """Mean of hourly readings per local calendar day of `tz`. Days with fewer than
    `min_hours` readings are omitted. `points` are tz-aware datetimes (UTC from Influx)."""
    by_day: dict[date, list[float]] = {}
    for t, v in points:
        by_day.setdefault(t.astimezone(tz).date(), []).append(v)
    return {d: sum(vs) / len(vs) for d, vs in by_day.items() if len(vs) >= min_hours}


def similar_temp_days(target: date, temps: dict[date, float], eligible: set[date],
                      tol_f: float = SIMILAR_TEMP_F,
                      lookback_days: int = SIMILAR_LOOKBACK_DAYS) -> list[date]:
    """Days in [target - lookback_days, target - 1] that are in `eligible`, have a temperature,
    and whose temperature is within ±tol_f (inclusive) of the target's. Oldest first.
    [] when the target has no temperature."""
    if target not in temps:
        return []
    t0 = temps[target]
    out = []
    for k in range(lookback_days, 0, -1):
        d = target - timedelta(days=k)
        if d in eligible and d in temps and abs(temps[d] - t0) <= tol_f:
            out.append(d)
    return out


def weather_matched_baseline(samples: list[float],
                             min_days: int = SIMILAR_MIN_DAYS) -> Baseline | None:
    """Center = mean of samples, spread = mad(samples) (about their median), n = len.
    None with fewer than min_days samples (caller falls back to the weekday baseline)."""
    if len(samples) < min_days:
        return None
    return Baseline(median=sum(samples) / len(samples), mad=mad(samples), n=len(samples))
```

- [ ] **Step 1: Write the failing tests** in `pi/test_report_baseline.py` (add `from datetime import datetime, timezone` and `from zoneinfo import ZoneInfo` to the imports; `PT = ZoneInfo("America/Los_Angeles")`, `UTC = timezone.utc`):

```python
class MaterialityFloorTest(unittest.TestCase):
    RATE = 0.1241

    def test_floor_at_rounded_cents(self):
        self.assertTrue(rb.material(12.1, self.RATE))    # $1.5016 -> $1.50
        self.assertTrue(rb.material(12.05, self.RATE))   # $1.4954 -> $1.50
        self.assertFalse(rb.material(12.0, self.RATE))   # $1.4892 -> $1.49

    def test_floor_is_sign_agnostic(self):
        self.assertTrue(rb.material(-13.0, self.RATE))
        self.assertFalse(rb.material(-5.0, self.RATE))

    def test_zero_excess_is_not_material(self):
        self.assertFalse(rb.material(0.0, self.RATE))

    def test_custom_floor_and_rate(self):
        self.assertTrue(rb.material(1.5, 1.0, floor_usd=1.50))
        self.assertFalse(rb.material(1.4, 1.0, floor_usd=1.50))

    def test_with_floor_keeps_z_and_pct(self):
        b = rb.compute_baseline([9, 10, 11, 10, 9, 11, 10, 9])
        r = rb.evaluate(16.0, b)                 # anomalous, +6 kWh
        self.assertTrue(r.is_anomalous)
        f = rb.with_floor(r, 6.0, self.RATE)
        self.assertFalse(f.is_anomalous)         # $0.74 < $1.50
        self.assertEqual((f.z, f.pct), (r.z, r.pct))

    def test_with_floor_never_creates_an_anomaly(self):
        b = rb.compute_baseline([9, 10, 11, 10, 9, 11, 10, 9])
        r = rb.evaluate(11.0, b)                 # normal
        self.assertFalse(rb.with_floor(r, 50.0, self.RATE).is_anomalous)

    def test_below_normal_day_over_floor_stays_anomalous(self):
        b = rb.compute_baseline([19, 20, 21, 20, 19, 21, 20, 19])
        r = rb.evaluate(7.0, b)                  # -13 kWh, z -8.77
        self.assertTrue(rb.with_floor(r, 7.0 - b.median, self.RATE).is_anomalous)


class DailyMeanTempsTest(unittest.TestCase):
    def test_pacific_day_boundaries(self):
        # 2026-08-18 PDT runs 07:00Z .. 07:00Z next day
        pts = [(datetime(2026, 8, 18, 7, tzinfo=UTC) + timedelta(hours=h), 60.0 + h % 2)
               for h in range(24)]
        pts.append((datetime(2026, 8, 18, 6, 59, tzinfo=UTC), 99.0))   # 23:59 on 8-17
        out = rb.daily_mean_temps(pts, PT)
        self.assertAlmostEqual(out[date(2026, 8, 18)], 60.5)
        self.assertNotIn(date(2026, 8, 17), out)                       # 1 reading < 20

    def test_drops_days_with_too_few_readings(self):
        pts = [(datetime(2026, 8, 18, 7, tzinfo=UTC) + timedelta(hours=h), 50.0)
               for h in range(19)]
        self.assertEqual(rb.daily_mean_temps(pts, PT), {})
        self.assertEqual(rb.daily_mean_temps(pts, PT, min_hours=19), {date(2026, 8, 18): 50.0})

    def test_dst_fall_back_day_has_25_hours(self):
        # 2026-11-01 starts 07:00Z (PDT) and ends 08:00Z on 11-02 (PST)
        start = datetime(2026, 11, 1, 7, tzinfo=UTC)
        pts = [(start + timedelta(hours=h), 40.0) for h in range(25)]
        pts.append((datetime(2026, 11, 2, 8, tzinfo=UTC), 99.0))
        out = rb.daily_mean_temps(pts, PT, min_hours=1)
        self.assertEqual(out[date(2026, 11, 1)], 40.0)
        self.assertEqual(out[date(2026, 11, 2)], 99.0)

    def test_empty(self):
        self.assertEqual(rb.daily_mean_temps([], PT), {})


class SimilarTempDaysTest(unittest.TestCase):
    T = date(2026, 11, 19)

    def test_band_is_inclusive_and_oldest_first(self):
        d1, d2, d3 = self.T - timedelta(days=10), self.T - timedelta(days=5), self.T - timedelta(days=2)
        temps = {self.T: 50.0, d1: 53.0, d2: 47.0, d3: 53.01}
        self.assertEqual(rb.similar_temp_days(self.T, temps, {d1, d2, d3}), [d1, d2])

    def test_lookback_window_edges(self):
        d60, d61 = self.T - timedelta(days=60), self.T - timedelta(days=61)
        temps = {self.T: 50.0, d60: 50.0, d61: 50.0}
        self.assertEqual(rb.similar_temp_days(self.T, temps, {d60, d61}), [d60])

    def test_excludes_target_future_and_ineligible(self):
        prev, fut, inel = self.T - timedelta(days=1), self.T + timedelta(days=1), self.T - timedelta(days=3)
        temps = {self.T: 50.0, prev: 50.0, fut: 50.0, inel: 50.0}
        self.assertEqual(rb.similar_temp_days(self.T, temps, {self.T, prev, fut}), [prev])

    def test_target_without_temperature(self):
        prev = self.T - timedelta(days=1)
        self.assertEqual(rb.similar_temp_days(self.T, {prev: 50.0}, {prev}), [])


class WeatherMatchedBaselineTest(unittest.TestCase):
    def test_mean_center_mad_spread(self):
        b = rb.weather_matched_baseline([10.0, 12.0, 20.0])
        self.assertAlmostEqual(b.median, 14.0)          # the mean, held in .median
        self.assertAlmostEqual(b.mad, 2.9652)           # 1.4826 * median(|x - 12|)
        self.assertEqual(b.n, 3)

    def test_too_few_days(self):
        self.assertIsNone(rb.weather_matched_baseline([10.0, 12.0]))
        self.assertIsNone(rb.weather_matched_baseline([]))
```

- [ ] **Step 2: Run** `cd /Users/nico/src/span-worktrees/alert-floor/pi && uv run --python 3.11 --with pytest --with httpx --with influxdb-client --with tzdata --with matplotlib pytest -q test_report_baseline.py`. Expected: FAIL (`AttributeError: module 'report_baseline' has no attribute 'material'`).
- [ ] **Step 3: Implement** the interfaces above in `pi/report_baseline.py` (constants near the top, functions after `evaluate`). Update the module docstring's first line to mention the floor and weather matching.
- [ ] **Step 4: Run the full suite** (command in Global Constraints). Expected: 0 failed, 360 passed (343 + 17).
- [ ] **Step 5: Commit** `pi: materiality floor and weather-matching helpers in report_baseline`

---

### Task 2: Pure HVAC judgement (`judge_part`, `combine_hvac`, `judge_hvac`)

**Files:**
- Modify: `pi/report_baseline.py`
- Test: `pi/test_report_baseline.py`

**Interfaces (produces):**

```python
@dataclass
class PartJudgement:
    name: str              # "space" | "hot_water"
    value: float           # the part's kWh on the target day
    baseline: Baseline     # .median is the center (mean on the weather basis)
    basis: str             # "weather" | "weekday"
    result: AnomalyResult  # rb.evaluate(value, baseline), no floor

    @property
    def excess_kwh(self) -> float:
        return self.value - self.baseline.median


def judge_part(name: str, value: float, baseline: Baseline, basis: str) -> PartJudgement:
    return PartJudgement(name, value, baseline, basis, evaluate(value, baseline))


@dataclass
class HvacJudgement:
    space: PartJudgement | None
    hot_water: PartJudgement | None
    combined_kwh: float      # signed sum of excess over parts with result.is_anomalous
    expected_kwh: float      # sum of the present parts' centers
    temp_f: float | None     # target day's mean outdoor temperature
    result: AnomalyResult    # is_anomalous = any part counted AND material(combined_kwh)


def combine_hvac(space: PartJudgement | None, hot_water: PartJudgement | None, rate: float,
                 floor_usd: float = MATERIALITY_FLOOR_USD,
                 temp_f: float | None = None) -> HvacJudgement:
    parts = [p for p in (space, hot_water) if p is not None]
    counted = [p for p in parts if p.result.is_anomalous]
    combined = sum(p.excess_kwh for p in counted)
    expected = sum(p.baseline.median for p in parts)
    zs = [p.result.z for p in counted if p.result.z is not None]
    z = max(zs, key=abs) if zs else None
    pct = abs(combined) / expected * 100.0 if expected > 0 else None
    result = AnomalyResult(is_anomalous=bool(counted) and material(combined, rate, floor_usd),
                           z=z, pct=pct)
    return HvacJudgement(space, hot_water, combined, expected, temp_f, result)


def judge_hvac(target: date, hvac_daily: dict[date, float], hot_water_daily: dict[date, float],
               temps: dict[date, float], rate: float,
               floor_usd: float = MATERIALITY_FLOOR_USD) -> HvacJudgement | None:
    """None when the target day has no hot-water value, or when neither part has enough
    samples; the caller then judges HVAC as a whole on the weekday baseline (plus floor)."""
    if target not in hot_water_daily:
        return None
    sample_dates = trailing_same_weekday_dates(target, 8)
    hw_value = hot_water_daily[target]
    hw_samples = [hot_water_daily[d] for d in sample_dates if d in hot_water_daily]
    hot_water = (judge_part("hot_water", hw_value, compute_baseline(hw_samples), "weekday")
                 if category_coverage_ok(len(hw_samples)) else None)

    eligible = {d for d in hvac_daily if d in hot_water_daily}

    def space_of(d: date) -> float:
        return hvac_daily[d] - hot_water_daily[d]

    space_value = hvac_daily.get(target, 0.0) - hw_value
    similar = similar_temp_days(target, temps, eligible)
    wb = weather_matched_baseline([space_of(d) for d in similar])
    if wb is not None:
        space = judge_part("space", space_value, wb, "weather")
    else:
        ss = [space_of(d) for d in sample_dates if d in eligible]
        space = (judge_part("space", space_value, compute_baseline(ss), "weekday")
                 if category_coverage_ok(len(ss)) else None)
    if space is None and hot_water is None:
        return None
    return combine_hvac(space, hot_water, rate, floor_usd, temp_f=temps.get(target))
```

- [ ] **Step 1: Write the failing tests** in `pi/test_report_baseline.py`:

```python
RATE = 0.1241
WK = [9, 10, 11, 10, 9, 11, 10, 9]      # median 10, mad 1.4826
HW = [4, 5, 4, 5, 4, 5, 4, 5]           # median 4.5, mad 0.7413


def part(name, value, samples, basis="weekday"):
    return rb.judge_part(name, value, rb.compute_baseline(samples), basis)


class CombineHvacTest(unittest.TestCase):
    def test_two_sub_floor_excesses_add_up_to_an_alert(self):
        j = rb.combine_hvac(part("space", 16.0, WK), part("hot_water", 11.5, HW), RATE)
        self.assertAlmostEqual(j.combined_kwh, 13.0)          # 6 + 7, each under $1.50
        self.assertTrue(j.result.is_anomalous)                # $1.61
        self.assertAlmostEqual(j.result.z, 9.4429, places=3)  # hot water has the larger |z|
        self.assertAlmostEqual(j.expected_kwh, 14.5)
        self.assertAlmostEqual(j.result.pct, 13.0 / 14.5 * 100)

    def test_only_anomalous_parts_count(self):
        # space +1 is normal and contributes nothing: 7 kWh, $0.87, no alert
        j = rb.combine_hvac(part("space", 11.0, WK), part("hot_water", 11.5, HW), RATE)
        self.assertAlmostEqual(j.combined_kwh, 7.0)
        self.assertFalse(j.result.is_anomalous)

    def test_a_noisy_normal_part_cannot_push_the_sum_over_the_floor(self):
        wide = [5, 15, 5, 15, 5, 15, 5, 15]   # median 10, mad 7.413: +15 is z 2.02, normal
        j = rb.combine_hvac(part("space", 25.0, wide), part("hot_water", 11.5, HW), RATE)
        self.assertFalse(j.space.result.is_anomalous)
        self.assertAlmostEqual(j.combined_kwh, 7.0)           # not 22
        self.assertFalse(j.result.is_anomalous)

    def test_single_part_over_the_floor(self):
        j = rb.combine_hvac(part("space", 23.0, WK), part("hot_water", 4.5, HW), RATE)
        self.assertAlmostEqual(j.combined_kwh, 13.0)
        self.assertTrue(j.result.is_anomalous)

    def test_neither_part_anomalous(self):
        j = rb.combine_hvac(part("space", 12.9, WK), part("hot_water", 5.9, HW), RATE)
        self.assertEqual(j.combined_kwh, 0.0)
        self.assertFalse(j.result.is_anomalous)
        self.assertIsNone(j.result.z)

    def test_opposite_signs_net_out(self):
        # space +14 (anomalous), hot water -3 (anomalous): +11 kWh, $1.37, no alert
        j = rb.combine_hvac(part("space", 24.0, WK), part("hot_water", 1.5, HW), RATE)
        self.assertAlmostEqual(j.combined_kwh, 11.0)
        self.assertFalse(j.result.is_anomalous)

    def test_below_normal_alert(self):
        low = [19, 20, 21, 20, 19, 21, 20, 19]
        j = rb.combine_hvac(part("space", 7.0, low), None, RATE)
        self.assertAlmostEqual(j.combined_kwh, -13.0)
        self.assertTrue(j.result.is_anomalous)
        self.assertLess(j.result.z, 0)

    def test_no_parts(self):
        j = rb.combine_hvac(None, None, RATE)
        self.assertFalse(j.result.is_anomalous)
        self.assertIsNone(j.result.pct)


def hvac_fixture(target, similar=((3, 10.0), (5, 11.0), (10, 10.0), (20, 12.0), (30, 11.0)),
                 target_space=16.8, target_hw=11.5):
    """61 days ending at `target`. Default day: 60F, space 3.0 kWh. Hot water alternates
    4/5 by week, so the 8 same-weekday samples are HW-like (median 4.5). `similar` lists
    (days_before_target, space_kwh) at 43F; the target is 43F."""
    hvac, hw, temps = {}, {}, {}
    for k in range(60, 0, -1):
        d = target - timedelta(days=k)
        hw[d] = 4.0 if (k // 7) % 2 == 0 else 5.0
        hvac[d] = hw[d] + 3.0
        temps[d] = 60.0
    for k, space in similar:
        d = target - timedelta(days=k)
        hvac[d] = hw[d] + space
        temps[d] = 43.0
    hw[target], hvac[target], temps[target] = target_hw, target_hw + target_space, 43.0
    return hvac, hw, temps


class JudgeHvacTest(unittest.TestCase):
    T = date(2026, 11, 19)   # Thursday; the fixture's similar days are not Thursdays

    def test_weather_basis_and_combined_alert(self):
        hvac, hw, temps = hvac_fixture(self.T)
        j = rb.judge_hvac(self.T, hvac, hw, temps, RATE)
        self.assertEqual(j.space.basis, "weather")
        self.assertEqual(j.space.baseline.n, 5)
        self.assertAlmostEqual(j.space.baseline.median, 10.8)
        self.assertAlmostEqual(j.space.excess_kwh, 6.0)
        self.assertEqual(j.hot_water.basis, "weekday")
        self.assertAlmostEqual(j.hot_water.baseline.median, 4.5)
        self.assertAlmostEqual(j.combined_kwh, 13.0)
        self.assertTrue(j.result.is_anomalous)
        self.assertEqual(j.temp_f, 43.0)

    def test_fewer_than_three_similar_days_falls_back_to_weekday(self):
        hvac, hw, temps = hvac_fixture(self.T, similar=((3, 10.0), (5, 11.0)))
        j = rb.judge_hvac(self.T, hvac, hw, temps, RATE)
        self.assertEqual(j.space.basis, "weekday")
        self.assertEqual(j.space.baseline.n, 8)
        self.assertAlmostEqual(j.space.baseline.median, 3.0)

    def test_similar_day_without_hot_water_is_not_eligible(self):
        hvac, hw, temps = hvac_fixture(self.T)
        for k in (3, 5, 10):
            del hw[self.T - timedelta(days=k)]
        j = rb.judge_hvac(self.T, hvac, hw, temps, RATE)
        self.assertEqual(j.space.basis, "weekday")

    def test_target_without_temperature_uses_weekday(self):
        hvac, hw, temps = hvac_fixture(self.T)
        del temps[self.T]
        j = rb.judge_hvac(self.T, hvac, hw, temps, RATE)
        self.assertEqual(j.space.basis, "weekday")
        self.assertIsNone(j.temp_f)

    def test_too_few_weekday_hot_water_samples(self):
        hvac, hw, temps = hvac_fixture(self.T)
        for w in (1, 2, 3):
            del hw[self.T - timedelta(weeks=w)]
        j = rb.judge_hvac(self.T, hvac, hw, temps, RATE)
        self.assertIsNone(j.hot_water)          # 5 of 8
        self.assertEqual(j.space.basis, "weather")

    def test_no_hot_water_on_target_returns_none(self):
        hvac, hw, temps = hvac_fixture(self.T)
        del hw[self.T]
        self.assertIsNone(rb.judge_hvac(self.T, hvac, hw, temps, RATE))

    def test_hvac_missing_on_target_reads_as_zero(self):
        hvac, hw, temps = hvac_fixture(self.T)
        del hvac[self.T]
        j = rb.judge_hvac(self.T, hvac, hw, temps, RATE)
        self.assertAlmostEqual(j.space.value, -11.5)
```

- [ ] **Step 2: Run** `... pytest -q test_report_baseline.py` (full command in Global Constraints, from `pi/`). Expected: FAIL (`no attribute 'judge_part'`).
- [ ] **Step 3: Implement** the interfaces above in `pi/report_baseline.py`, after Task 1's functions.
- [ ] **Step 4: Run the full suite.** Expected: 0 failed, 375 passed.
- [ ] **Step 5: Commit** `pi: HVAC judgement — weather-matched space + weekday hot water, summed excess, floor on the sum`

---

### Task 3: Queries, `evaluate_day`, and rewiring `generate_anomaly_check`

**Files:**
- Modify: `pi/daily_report.py` (new queries after `query_mean_temp_f`; `CategoryVerdict` + `evaluate_day` just above `render_anomaly_email`; `generate_anomaly_check`)
- Create: `pi/test_anomaly_floor.py`

**Interfaces (produces), in `pi/daily_report.py`:**

```python
HW_MIN_INTERVALS = 260   # of 288 five-minute hvac_mode intervals (276 on a 23-hour day)


def _hourly_temp_flux(start: str, stop: str) -> str:
    return f'''
from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {start}, stop: {stop})
  |> filter(fn: (r) => r._measurement == "weather" and r._field == "temp_f")
  |> filter(fn: (r) => exists r._value)
  |> keep(columns: ["_time", "_value"])
'''


def query_hourly_temp_f(query_api, start: str, stop: str) -> list[tuple[datetime, float]]:
    """Raw hourly outdoor temperatures (UTC times) in [start, stop). None values skipped."""
    out = []
    for table in query_api.query(_hourly_temp_flux(start, stop), org=INFLUXDB_ORG):
        for rec in table.records:
            if rec.get_value() is not None:
                out.append((rec.get_time(), float(rec.get_value())))
    return out


def query_daily_temps_f(query_api, start: str, stop: str) -> dict[date, float]:
    """Pacific-day mean outdoor temperature; days with < 20 hourly readings omitted.
    Bucketing is done in Python (rb.daily_mean_temps) so DST days are exact and testable."""
    return rb.daily_mean_temps(query_hourly_temp_f(query_api, start, stop), LOCAL_TZ)


def _daily_hot_water_flux(start: str, stop: str, fn: str) -> str:
    """`fn` is "sum" or "count". hvac_mode is stamped at interval start; aggregateWindow
    stamps each Pacific day at its stop, which _local_day maps back to the day."""
    return f'''import "timezone"
option location = timezone.location(name: "{LOCAL_TZ_NAME}")

from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {start}, stop: {stop})
  |> filter(fn: (r) => r._measurement == "hvac_mode" and r._field == "energy_hot_water_kwh")
  |> filter(fn: (r) => exists r._value)
  |> aggregateWindow(every: 1d, fn: {fn}, createEmpty: false)
'''


def query_daily_hot_water_kwh(query_api, start: str, stop: str) -> dict[date, float]:
    """Hot-water kWh per Pacific day from hvac_mode, only for days with at least
    HW_MIN_INTERVALS classified intervals (a classifier outage would understate it)."""
    def by_day(fn: str) -> dict[date, float]:
        out = {}
        for table in query_api.query(_daily_hot_water_flux(start, stop, fn), org=INFLUXDB_ORG):
            for rec in table.records:
                out[_local_day(rec.get_time())] = float(rec.get_value() or 0.0)
        return out
    sums, counts = by_day("sum"), by_day("count")
    return {d: v for d, v in sums.items() if counts.get(d, 0) >= HW_MIN_INTERVALS}


@dataclass
class CategoryVerdict:
    category: str
    action: str                              # "skip" | "clear" | "judge"
    value: float = 0.0
    baseline: "rb.Baseline | None" = None
    result: "rb.AnomalyResult | None" = None  # floor already applied
    hvac: "rb.HvacJudgement | None" = None


def evaluate_day(target_date: date, day_cat: dict[date, dict[str, float]],
                 hot_water_daily: dict[date, float], temps: dict[date, float],
                 rate: float = ENERGY_RATE) -> list[CategoryVerdict]:
    """Pure: one verdict per category, in _all_categories() order. "skip" = too few
    baseline samples (state untouched); "clear" = Car under the full-charge cap;
    "judge" = result is final (statistical test AND $1.50 floor)."""
    sample_dates = rb.trailing_same_weekday_dates(target_date, 8)
    hvac_daily = {d: cats["HVAC"] for d, cats in day_cat.items() if "HVAC" in cats}
    out = []
    for category in _all_categories():
        samples = [day_cat[d][category] for d in sample_dates
                   if d in day_cat and category in day_cat[d]]
        if not rb.category_coverage_ok(len(samples)):
            out.append(CategoryVerdict(category, "skip"))
            continue
        value = day_cat.get(target_date, {}).get(category, 0.0)
        if category == "Car" and value <= EV_FULL_CHARGE_KWH:
            out.append(CategoryVerdict(category, "clear", value))
            continue
        if category == "HVAC":
            j = rb.judge_hvac(target_date, hvac_daily, hot_water_daily, temps, rate)
            if j is not None:
                # baseline.median = the effective expected value, so value - median = combined
                out.append(CategoryVerdict(category, "judge", value,
                                           rb.Baseline(median=value - j.combined_kwh, mad=0.0, n=0),
                                           j.result, j))
                continue
        baseline = rb.compute_baseline(samples)
        result = rb.with_floor(rb.evaluate(value, baseline), value - baseline.median, rate)
        out.append(CategoryVerdict(category, "judge", value, baseline, result))
    return out
```

**`generate_anomaly_check` after the change** (coverage guard and everything from `if not alerts:` down stay as they are, except the `render_anomaly_email` call, which Task 4 extends):

```python
    sample_dates = rb.trailing_same_weekday_dates(target_date, 8)   # keep: used nowhere else now, delete if unused
    fetch_start = flux_ts(local_day_utc_range(target_date - timedelta(days=rb.SIMILAR_LOOKBACK_DAYS))[0])
    fetch_stop = flux_ts(local_day_utc_range(target_date + timedelta(days=1))[0])
    rows = query_daily_circuit_counter_kwh(query_api, fetch_start, fetch_stop)
    day_cat = category_day_kwh(rows)
    try:
        hot_water_daily = query_daily_hot_water_kwh(query_api, fetch_start, fetch_stop)
    except Exception as e:
        logger.warning(f"{target_date}: hot-water query failed, HVAC judged as a whole: {e}")
        hot_water_daily = {}
    try:
        temps = query_daily_temps_f(query_api, fetch_start, fetch_stop)
    except Exception as e:
        logger.warning(f"{target_date}: weather query failed, HVAC space on weekday baseline: {e}")
        temps = {}

    alerts = []
    episode_since: dict[str, date] = {}
    hvac_judgement = None
    for v in evaluate_day(target_date, day_cat, hot_water_daily, temps):
        if v.action == "skip":
            logger.info(f"{v.category}: too few baseline samples, skipping")
            continue
        if v.action == "clear":
            rb.clear_state(STATE_PATH, v.category)
            continue
        state = rb.load_state(STATE_PATH, v.category)
        if v.result.is_anomalous:
            if rb.should_alert(v.result, state):
                alerts.append((v.category, v.value, v.baseline, v.result))
                if v.hvac is not None:
                    hvac_judgement = v.hvac
                rb.save_state(STATE_PATH, v.category, target_date, v.result.z)
                since = rb.load_state(STATE_PATH, v.category).since
                if since is not None:
                    episode_since[v.category] = since
        else:
            rb.clear_state(STATE_PATH, v.category)
```

(`sample_dates` is now only used inside `evaluate_day`; remove the local in `generate_anomaly_check`. `hvac_judgement` is passed to the renderer in Task 4; until then it is unused.)

- [ ] **Step 1: Write the failing tests** in a new `pi/test_anomaly_floor.py`. Header: `import sys, unittest`, `from datetime import date, datetime, timedelta, timezone`, `from unittest import mock`, `sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))`, `import daily_report as dr`, `import report_baseline as rb`, plus copies of `FakeRecord` / `FakeTable` from `pi/test_weekly_report.py`. **Do not copy the `httpx` / `influxdb_client` stub block** from `test_cool_alert.py`: this file sorts before `test_bath_detector.py` and `test_charge_detector.py`, and a stub `influxdb_client` installed here breaks their `from influxdb_client import Point` at collection (verified while writing this plan). The suite command installs the real packages; `conftest.py` already stubs matplotlib. Add:

```python
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
```

Check the weekday-median comment in the last test against the fixture before relying on it (Thursday HVAC samples alternate 7.0 / 8.0, median 7.5).

- [ ] **Step 2: Run** `... pytest -q test_anomaly_floor.py`. Expected: FAIL (`no attribute 'evaluate_day'`).
- [ ] **Step 3: Implement** the queries, `CategoryVerdict`, `evaluate_day`, and the `generate_anomaly_check` body above.
- [ ] **Step 4: Run the full suite.** Expected: 0 failed, 389 passed. In particular the unmodified `AnomalyCheckTest` and `HvacModeSplitTest` cases in `pi/test_weekly_report.py` still pass (their mock client makes both new queries raise, so HVAC takes the whole-category path; their 40-vs-10 kWh cases are $3.72, over the floor).
- [ ] **Step 5: Commit** `pi: anomaly check acts on evaluate_day verdicts (floor + weather-matched HVAC)`

---

### Task 4: HVAC email copy that says what the comparison was

**Files:**
- Modify: `pi/daily_report.py` (`render_anomaly_email`, the `render_anomaly_email(...)` call in `generate_anomaly_check`)
- Test: `pi/test_anomaly_floor.py`

**Interfaces:**
- `render_anomaly_email(target_date, alerts, top_circuits, mode_split=None, episode_since=None, hvac: rb.HvacJudgement | None = None) -> tuple[str, str]`. When `hvac` is None, or for any non-HVAC block, output is byte-identical to today.
- `generate_anomaly_check` passes `hvac=hvac_judgement`.
- When the alert category is `"HVAC"` and `hvac` is given, let `c = hvac.combined_kwh`, `usd = abs(c) * ENERGY_RATE`, `more = "more" if c > 0 else "less"`, `above = "above" if c > 0 else "below"`, `wd = target_date.strftime("%A")`:
  - single-alert subject: `f"⚡ HVAC {abs(c):.1f} kWh {above} expected (${usd:.2f})"`, plus the existing ` · day N` suffix rule. The multi-category subject is unchanged.
  - first paragraph of the block (replaces the generic "vs a normal … for a {wd}" paragraph): `f"<p>{age}HVAC used {value:.1f} kWh, {abs(c):.1f} kWh {more} than expected (${usd:.2f}).</p>"`
  - then one paragraph per present part, in order space then hot water, where `verdict = "unusual" if part.result.is_anomalous else "within the normal range, not counted"`:
    - space, weather basis: `f"<p>Heating and cooling (all HVAC except hot water): {p.value:.1f} kWh vs an average {p.baseline.median:.1f} kWh on {p.baseline.n} days at similar temperature (within {rb.SIMILAR_TEMP_F:.0f}&deg;F of {hvac.temp_f:.0f}&deg;F, last {rb.SIMILAR_LOOKBACK_DAYS} days) &mdash; {verdict}.</p>"`
    - space, weekday basis: `f"<p>Heating and cooling (all HVAC except hot water): {p.value:.1f} kWh vs a normal {p.baseline.median:.1f} kWh for a {wd} (too few days at similar temperature to compare) &mdash; {verdict}.</p>"`
    - hot water: `f"<p>Hot water: {p.value:.1f} kWh vs a normal {p.baseline.median:.1f} kWh for a {wd} &mdash; {verdict}.</p>"`
  - the existing mode-split line, "Driven by" line and dashboard link follow unchanged.

- [ ] **Step 1: Write the failing tests** in `pi/test_anomaly_floor.py`:

```python
from email_kit import html_to_text


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
```

Verify the `target_hw=20.0` case before relying on it: hot water +15.5 kWh ($1.92), space 10.8 vs mean 10.8 (excess 0, normal).

- [ ] **Step 2: Run** `... pytest -q test_anomaly_floor.py`. Expected: the new tests FAIL (`unexpected keyword argument 'hvac'`).
- [ ] **Step 3: Implement** the copy in `render_anomaly_email` and pass `hvac=hvac_judgement` from `generate_anomaly_check`.
- [ ] **Step 4: Run the full suite.** Expected: 0 failed, 395 passed. Then a render smoke check from `pi/`: `DRY_RUN=1 python3 -c "import test_anomaly_floor as t, daily_report as d; a,j=t.HvacEmailCopyTest()._alert(); print(d.render_anomaly_email(t.T,a,{},hvac=j)[0])"` prints `⚡ HVAC 13.0 kWh above expected ($1.61)` (run it with the same `uv run --python 3.11 --with …` prefix as the suite, replacing `pytest -q` with `python3 -c …`).
- [ ] **Step 5: Commit** `pi: HVAC anomaly email names its comparison (similar-temperature days / weekday)`

---

### Task 5: Read-only backtest tool and verification against the Pi's data

**Files:**
- Create: `pi/tools/alert_backtest.py`

The Pi's `daily-report` image does not contain this branch's code, and nothing may be rebuilt, restarted or deployed. So the tool bundles this worktree's `daily_report.py`, `report_baseline.py`, `email_kit.py` and `categories.json` into the program it prints, and the program writes them to a temp dir inside a throwaway container (`--rm`) and imports them ahead of `/app`. It runs only the production query functions (all reads) and the pure `evaluate_day` / `should_alert`; repeat-suppression state is simulated in memory. It never calls `generate_anomaly_check`, `save_state`, `clear_state` or `send_email`, and sets `DRY_RUN=1` as a second guard.

**Code (write it exactly; adjust only if a name differs from Tasks 1–4):**

```python
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
```

- [ ] **Step 1: Local sanity run of the bundler** (no Pi): `cd /Users/nico/src/span-worktrees/alert-floor && python3 pi/tools/alert_backtest.py --bundle | head -c 300` prints `BUNDLED = {'daily_report.py': '#!/usr/bin/env python3...`. Also `python3 pi/tools/alert_backtest.py --bundle | python3 -c "import sys, ast; ast.parse(sys.stdin.read()); print('ok')"` prints `ok`.
- [ ] **Step 2: Run the full suite** once more. Expected: 0 failed.
- [ ] **Step 3: Commit** `pi: read-only alert backtest tool (bundles this branch into a throwaway container)` before any Pi run.
- [ ] **Step 4: Verification run 1, the same 60 days as the original backtest.** This needs ssh to the Pi; if the implementing agent may not ssh, hand Nico this command instead. It runs in a throwaway container from the existing image (`--rm`, `--no-deps`, no build, no restart; reads Influx only):

==================

Run from your laptop:

```
cd /Users/nico/src/span-worktrees/alert-floor && python3 pi/tools/alert_backtest.py --bundle | ssh nico@phrpi.local 'cd /home/nico/SPAN/pi && docker compose run --rm --no-deps -T -e DRY_RUN=1 daily-report python - 2026-09-24 2026-11-22'
```

==================

  Pass: the final `ALERT DAYS` line lists at most `2026-10-26` and `2026-11-19`, and every alert is HVAC. 2026-10-26 sits almost exactly on the floor (about 12.1 kWh of combined excess, about $1.50), so either outcome for that day is a pass; report its combined $ figure. 11-19 should show both parts `unusual` and about +13 kWh / $1.62. Any other alert day is a fail: do not tune constants, report the day's line to Nico.
- [ ] **Step 5: Verification run 2, the June 2026 heat-pump fault** (CLAUDE.md "HVAC cooling watch": about 2026-06-14, auxiliary resistance firing and compressor short-cycling on a hot day). Same command with the dates `2026-06-01 2026-06-30` in place of `2026-09-24 2026-11-22`. Report: the `ALERT DAYS` line; the per-day lines for 2026-06-10 through 2026-06-18 (temperature, basis of each part, combined kWh and $); and whether 06-14 would have alerted. If it would not, say how far below $1.50 it was, and whether it would have passed the statistical test without the floor (a counted part present). This is a finding for Nico, not something to fix in this plan.
- [ ] **Step 6:** No commit (nothing changes on disk). Put both outputs in the final report.

---

### Task 6: CLAUDE.md update

**Files:**
- Modify: `/Users/nico/src/span-worktrees/alert-floor/CLAUDE.md`

`CLAUDE.md` is over its size limit: the replacement must not be longer than the text it replaces.

- [ ] **Step 1: Replace** the paragraph that begins `  **Ask Nico next session:** (a) weather-aware anomaly alerts:` and ends `(health stayed up; Pi logs clean).` (inside "Next Steps", under the 2026-11-23 decisions bullet) with the text below. Fill the `<…>` slots from Task 5's output; keep the two-space indent.

```
  **Anomaly alerts (built 2026-11-2X, branch `alert-floor`, not deployed):** no alert unless
  |excess| × `ENERGY_RATE` ≥ $1.50, every category, below-normal too. HVAC = space (HVAC minus
  `hvac_mode` hot water) vs the mean of days within ±3°F in the previous 60 (weekday fallback under
  3) plus hot water vs the weekday baseline; excesses of parts that fail their own test are summed,
  signed, and the floor applies to the sum (`report_baseline.judge_hvac`). Backtest
  (`pi/tools/alert_backtest.py`): <N> alert days in 60 (<dates>); June 2026 fault: <alerted / not,
  $X>. Deploy: rebuild `daily-report` on the Pi.
  **Ask Nico next session:** (a) order of work for the 11-23 mocks; (b) apply the car-below-zero
  split to `/trends` too? (c) Add a one-retry-on-ECONNRESET in `web/lib/influx.ts`: on 2026-11-23
  17:04Z, Vercel→Influx connections were reset for ~1 min, and the explorer SSR 500'd (health
  stayed up; Pi logs clean).
```

- [ ] **Step 2: Check length:** `git diff --stat CLAUDE.md` shows the file did not grow (insertions ≤ deletions in characters; compare `wc -c CLAUDE.md` before and after).
- [ ] **Step 3: Commit** `docs: anomaly alert floor and weather-matched HVAC built`

---

## Out of scope (separate work, needs Nico)

- **Deploying to the Pi.** After review and merge: on the Pi, `git pull` in `/home/nico/SPAN`, then from `pi/`: `docker compose build daily-report`, `docker compose up -d --no-deps daily-report`, then a `--anomaly-date` test with `DRY_RUN=1` via `docker compose run --rm --no-deps -e DRY_RUN=1 daily-report python -u daily_report.py --anomaly-date 2026-11-19`. Not part of this plan.
- **Fault alerts** (the backtest's option 3, "fault alerts only"): if Task 5 shows the June fault would not alert, a separate rule (for example aux-resistance energy on a warm day) is the follow-up, not a change to the floor.
- **TOU pricing:** the floor uses the flat `ENERGY_RATE`; if `rates.py` ever goes TOU, revisit.
- **Non-HVAC copy:** unchanged; it still prints the day's total cost, not the excess.
