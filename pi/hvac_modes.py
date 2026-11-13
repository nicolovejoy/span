#!/usr/bin/env python3
"""Pure HVAC mode classification — no I/O, no env, no influx imports.

Turns raw 30s HP + aux power samples plus hourly outdoor temperature into a
labeled 5-minute timeline: heat / cool / hot_water / idle / ambiguous.
Thresholds below are Phase 0-calibrated against 2026-01-04 -> 2026-08-26
production data; see docs/superpowers/notes/2026-08-26-hvac-phase0-findings.md
for the backtest that set each tuned constant.
"""
from datetime import datetime, timedelta, timezone

INTERVAL_MINUTES = 5
IDLE_POWER_W = 50.0            # on/off boundary, same as bath_detector's POWER_THRESHOLD

# --- DHW (hot water) signature, season-invariant ---
DHW_MEAN_POWER_MIN_W = 2100.0  # Phase 0 backtest: seed 2500 clipped the reheat ramp's
                                # early minutes (2020->3606 W over 45 min); see
                                # docs/superpowers/notes/2026-08-26-hvac-phase0-findings.md
DHW_DUTY_MIN = 0.65            # Phase 0 backtest: seed 0.85 dropped ramp-tail intervals
                                # closing a draw at ~0.70 duty; see
                                # docs/superpowers/notes/2026-08-26-hvac-phase0-findings.md
DHW_MAX_TRANSITIONS = 2        # seeded from bath_detector.MAX_TRANSITIONS
DHW_RUN_MIN_MINUTES = 10       # shorter high-power runs -> not a reheat
DHW_RUN_MAX_MINUTES = 120      # longer -> sustained space conditioning

# --- heat vs cool temperature bands (deg F), Phase 0-tunable ---
HEAT_MAX_TEMP_F = 58.0
COOL_MIN_TEMP_F = 68.0
WEATHER_MAX_STALENESS_MIN = 90


def _floor_to_interval(dt: datetime) -> datetime:
    epoch = int(dt.timestamp())
    return datetime.fromtimestamp(epoch - epoch % (INTERVAL_MINUTES * 60), tz=timezone.utc)


def _stats(powers: list[float]) -> dict:
    above = [p > IDLE_POWER_W for p in powers]
    transitions = sum(1 for i in range(1, len(above)) if above[i] != above[i - 1])
    return {
        "mean": sum(powers) / len(powers) if powers else 0.0,
        "max": max(powers) if powers else 0.0,
        "duty": sum(above) / len(above) if above else 0.0,
        "transitions": transitions,
    }


def bucket_intervals(hp_samples: list[dict], aux_samples: list[dict],
                     start: datetime, stop: datetime) -> list[dict]:
    """Aggregate raw samples into aligned 5-min interval stats. Intervals with
    zero HP samples are omitted: a collector gap must surface as a timeline
    gap, never as invented zeros."""
    width = timedelta(minutes=INTERVAL_MINUTES)
    hp_by_bucket: dict[datetime, list[float]] = {}
    aux_by_bucket: dict[datetime, list[float]] = {}
    for target, source in ((hp_by_bucket, hp_samples), (aux_by_bucket, aux_samples)):
        for s in source:
            if start <= s["time"] < stop:
                target.setdefault(_floor_to_interval(s["time"]), []).append(abs(s["power"]))

    out = []
    b = _floor_to_interval(start)
    while b < stop:
        hp = hp_by_bucket.get(b, [])
        if hp:
            h, a = _stats(hp), _stats(aux_by_bucket.get(b, []))
            out.append({
                "start": b,
                "hp_mean_w": h["mean"], "hp_max_w": h["max"],
                "hp_duty": h["duty"], "hp_transitions": h["transitions"],
                "aux_mean_w": a["mean"], "aux_max_w": a["max"],
                "energy_kwh": (h["mean"] + a["mean"]) * INTERVAL_MINUTES / 60 / 1000,
                "n_samples": len(hp),
            })
        b += width
    return out


def temp_at(weather_points: list[dict], dt: datetime) -> float | None:
    """Nearest hourly reading within WEATHER_MAX_STALENESS_MIN, else None."""
    best, best_gap = None, None
    for w in weather_points:
        gap = abs((w["time"] - dt).total_seconds())
        if best_gap is None or gap < best_gap:
            best, best_gap = w, gap
    if best is None or best_gap > WEATHER_MAX_STALENESS_MIN * 60:
        return None
    return best["temp_f"]


def _is_dhw_shaped(interval: dict) -> bool:
    return (interval["hp_mean_w"] >= DHW_MEAN_POWER_MIN_W
            and interval["hp_duty"] >= DHW_DUTY_MIN
            and interval["hp_transitions"] <= DHW_MAX_TRANSITIONS)


def _mark_hot_water(intervals: list[dict]) -> set[datetime]:
    """Group consecutive DHW-shaped intervals; runs whose duration lands in
    [DHW_RUN_MIN_MINUTES, DHW_RUN_MAX_MINUTES] are hot water. 'Consecutive'
    means exactly INTERVAL_MINUTES apart — a timeline gap breaks the run.
    Over-long runs fall through to temperature classification (sustained
    space conditioning)."""
    starts: set[datetime] = set()
    run: list[dict] = []

    def flush():
        if run:
            minutes = len(run) * INTERVAL_MINUTES
            if DHW_RUN_MIN_MINUTES <= minutes <= DHW_RUN_MAX_MINUTES:
                starts.update(i["start"] for i in run)
        run.clear()

    prev = None
    for i in intervals:
        contiguous = prev is not None and (i["start"] - prev) == timedelta(minutes=INTERVAL_MINUTES)
        if _is_dhw_shaped(i):
            if not contiguous:
                flush()
            run.append(i)
        else:
            flush()
        prev = i["start"]
    flush()
    return starts


def _is_active(interval: dict | None) -> bool:
    return (interval is not None
            and interval["hp_mean_w"] + interval["aux_mean_w"] >= IDLE_POWER_W)


def _extend_hot_water_edges(intervals: list[dict], hot_water: set[datetime]) -> set[datetime]:
    """Attach a reheat's first and last fragment to its run.

    A reheat rarely starts or stops on a 5-min boundary, so the interval on
    either side of an accepted run holds a partial minute or two of the same
    compressor run: too little mean power (or duty) to be DHW-shaped, so it
    used to fall through to temperature -- `ambiguous` in mild weather, `heat`
    in cold. Those fragments were ~17% of all ambiguous energy (2026-11-13).

    One interval per side, and only when the interval beyond it is idle or
    missing: that is what makes it the run's own edge. A reheat followed
    directly by sustained space conditioning has an active interval beyond,
    so nothing is absorbed from it."""
    by_start = {i["start"]: i for i in intervals}
    step = timedelta(minutes=INTERVAL_MINUTES)
    extra: set[datetime] = set()
    for start in hot_water:
        for direction in (-1, 1):
            edge = by_start.get(start + direction * step)
            if edge is None or edge["start"] in hot_water or not _is_active(edge):
                continue
            if _is_active(by_start.get(edge["start"] + direction * step)):
                continue
            extra.add(edge["start"])
    return hot_water | extra


def classify(intervals: list[dict], weather_points: list[dict]) -> list[dict]:
    """Label each interval with its mode. Stage 1: season-invariant DHW shape,
    plus each accepted run's edge fragments. Stage 2: remaining active
    intervals split by outdoor temperature."""
    hot_water = _extend_hot_water_edges(intervals, _mark_hot_water(intervals))
    out = []
    for i in intervals:
        total = i["hp_mean_w"] + i["aux_mean_w"]
        if total < IDLE_POWER_W:
            mode = "idle"
        elif i["start"] in hot_water:
            mode = "hot_water"
        else:
            t = temp_at(weather_points, i["start"])
            if t is None:
                mode = "ambiguous"
            elif t <= HEAT_MAX_TEMP_F:
                mode = "heat"
            elif t >= COOL_MIN_TEMP_F:
                mode = "cool"
            else:
                mode = "ambiguous"
        out.append({**i, "mode": mode})
    return out
