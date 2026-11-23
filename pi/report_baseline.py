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
