#!/usr/bin/env python3
"""Pure baseline math for the daily anomaly check: median/MAD, weekday
bucketing, the anomaly trigger, the $ materiality floor, and weather-matched
(similar outdoor temperature) baselines. No Influx, no email — daily_report.py owns
all I/O and calls into this module. See
docs/superpowers/specs/2026-08-21-weekly-energy-report-design.md ("The anomaly
email")."""

import json
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, tzinfo
from pathlib import Path

MATERIALITY_FLOOR_USD = 1.50
SIMILAR_TEMP_F = 3.0          # ± band, inclusive
SIMILAR_LOOKBACK_DAYS = 60    # target-60 .. target-1
SIMILAR_MIN_DAYS = 3
MIN_TEMP_HOURS = 20           # hourly readings needed for a day's mean


def median(values: list[float]) -> float:
    s = sorted(values)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def mad(values: list[float], m: float | None = None) -> float:
    """Median absolute deviation, scaled by 1.4826 so it's comparable to a
    standard deviation for a roughly-normal sample."""
    if m is None:
        m = median(values)
    return 1.4826 * median([abs(v - m) for v in values])


@dataclass
class Baseline:
    median: float
    mad: float   # already scaled by 1.4826
    n: int       # samples the baseline was computed from


def compute_baseline(samples: list[float]) -> Baseline:
    m = median(samples)
    return Baseline(median=m, mad=mad(samples, m), n=len(samples))


@dataclass
class AnomalyResult:
    is_anomalous: bool
    z: float | None    # None when mad == 0 and the percentage fallback fired instead
    pct: float | None  # |value - median| / median * 100, for the email copy.
                       # None when the baseline median is 0 and value != 0 (a
                       # percentage vs. zero is undefined, not infinite).


def evaluate(value: float, baseline: Baseline) -> AnomalyResult:
    """Both conditions must hold:  |z| > 3  and  |value - m| > max(0.20*m, 1.0)
    Degenerate fallback when mad == 0 (a perfectly regular category):
    |value - m| > max(0.50*m, 1.0)."""
    m = baseline.median
    diff = abs(value - m)
    pct = (diff / m * 100.0) if m > 0 else (0.0 if diff == 0 else None)
    if baseline.mad == 0:
        floor = max(0.50 * m, 1.0)
        return AnomalyResult(is_anomalous=diff > floor, z=None, pct=pct)
    z = (value - m) / baseline.mad
    floor = max(0.20 * m, 1.0)
    return AnomalyResult(is_anomalous=(abs(z) > 3 and diff > floor), z=z, pct=pct)


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


@dataclass
class PartJudgement:
    name: str              # "space" | "hot_water"
    value: float           # the part's kWh on the target day
    baseline: Baseline     # .median is the center (mean on the weather basis)
    basis: str             # "weather" | "weekday"
    result: AnomalyResult  # evaluate(value, baseline), no floor

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
    """None when the target day has no hot-water value, or when either part lacks enough
    samples (judging one part alone would leave the other's usage unjudged); the caller then
    judges HVAC as a whole on the weekday baseline (plus floor)."""
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
    if space is None or hot_water is None:
        return None
    return combine_hvac(space, hot_water, rate, floor_usd, temp_f=temps.get(target))


def trailing_same_weekday_dates(target: date, n: int = 8) -> list[date]:
    """The n dates before `target` sharing its weekday, oldest first — e.g. the
    trailing 8 Tuesdays before a Tuesday target. Plain calendar-week
    arithmetic (timedelta weeks), so it is unaffected by DST boundaries."""
    return [target - timedelta(weeks=i) for i in range(n, 0, -1)]


def day_coverage_ok(fraction_present: float, threshold: float = 0.90) -> bool:
    """≥90% of a day's expected circuit_1h hours must be present, or the
    caller suppresses all alerting for that day (spec: coverage guard)."""
    return fraction_present >= threshold


def category_coverage_ok(samples_present: int, required: int = 6) -> bool:
    """≥6 of the 8 trailing same-weekday samples must be present, or the
    caller skips that category for the day."""
    return samples_present >= required


@dataclass
class SuppressionState:
    last_alert_date: date | None
    last_z: float | None
    since: date | None = None   # episode start; None only when there is no entry


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def load_state(path: Path, category: str) -> SuppressionState:
    entry = _load_json(path).get(category)
    if not entry:
        return SuppressionState(None, None)
    last = date.fromisoformat(entry["date"]) if entry.get("date") else None
    # Entries written before episode tracking have no "since"; the last alert
    # date is the best available estimate of the episode start.
    since = date.fromisoformat(entry["since"]) if entry.get("since") else last
    return SuppressionState(last_alert_date=last, last_z=entry.get("z"), since=since)


def save_state(path: Path, category: str, alert_date: date, z: float | None) -> None:
    """Records an alert. An existing entry means the episode is ongoing, so its
    start (`since`) is kept; clear_state() is what ends an episode."""
    data = _load_json(path)
    prior = data.get(category) or {}
    since = prior.get("since") or prior.get("date") or alert_date.isoformat()
    data[category] = {"date": alert_date.isoformat(), "z": z, "since": since}
    path.write_text(json.dumps(data))


def clear_state(path: Path, category: str) -> None:
    data = _load_json(path)
    if category in data:
        del data[category]
        path.write_text(json.dumps(data))


def should_alert(result: AnomalyResult, state: SuppressionState,
                 worsen_pct: float = 0.25) -> bool:
    """Repeat-suppression guard. Fires when the category is newly anomalous, or
    when a currently-suppressed anomaly has materially worsened (|z| grows by
    more than worsen_pct) since the last alert. A continuous anomaly of
    constant severity — a heat wave — alerts exactly once and then stays
    suppressed indefinitely, by design: nothing here re-triggers on elapsed
    time alone. The caller is responsible for calling clear_state() once a
    category returns to normal, which is what lets a *later, separate*
    anomalous episode alert immediately rather than staying suppressed by a
    stale prior episode."""
    if not result.is_anomalous:
        return False
    if state.last_alert_date is None:
        return True
    if state.last_z is not None and result.z is not None:
        return abs(result.z) > abs(state.last_z) * (1 + worsen_pct)
    return False
