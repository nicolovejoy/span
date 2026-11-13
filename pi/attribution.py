#!/usr/bin/env python3
"""Pure run-grouping over a classified hvac_mode timeline — no I/O.

An event detector is a predicate over runs. One ships today (bath);
shower / laundry hot-water predicates are future one-liners here (#14/#17)."""
from datetime import timedelta

from hvac_modes import DHW_MEAN_POWER_MIN_W, INTERVAL_MINUTES
from rates import cost_for_kwh

BATH_MIN_MINUTES = 25          # Phase 0 backtest-calibrated; see
                                # docs/superpowers/notes/2026-08-26-hvac-phase0-findings.md
BATH_MEAN_POWER_MIN_W = 2400.0  # Phase 0 backtest: see
                                 # docs/superpowers/notes/2026-08-26-hvac-phase0-findings.md
# Baths and showers overlap in duration (both start ~25 min) and in power, so
# duration/power alone can't separate them. A shower run carries about half a
# bath's energy (median 1.15 vs 2.15 kWh) -- an energy floor cuts diagonally
# across duration x power where a bound on either alone cannot, dropping
# false positives from 59 to 15 over the Phase 0 backtest period. See
# docs/superpowers/notes/2026-08-26-hvac-phase0-findings.md.
BATH_MIN_KWH = 1.5


def runs(intervals: list[dict], mode: str) -> list[list[dict]]:
    """Maximal groups of contiguous (exactly INTERVAL_MINUTES apart)
    intervals labeled `mode`. A timeline gap breaks a run."""
    out: list[list[dict]] = []
    current: list[dict] = []
    step = timedelta(minutes=INTERVAL_MINUTES)
    for i in intervals:
        if i["mode"] != mode:
            if current:
                out.append(current)
                current = []
            continue
        if current and i["start"] - current[-1]["start"] != step:
            out.append(current)
            current = []
        current.append(i)
    if current:
        out.append(current)
    return out


def _core(run: list[dict]) -> list[dict]:
    """A hot_water run without its edge fragments: at most one interval per
    end, dropped when its mean power is below the DHW shape floor."""
    lo, hi = 0, len(run)
    if hi - lo > 1 and run[lo]["hp_mean_w"] < DHW_MEAN_POWER_MIN_W:
        lo += 1
    if hi - lo > 1 and run[hi - 1]["hp_mean_w"] < DHW_MEAN_POWER_MIN_W:
        hi -= 1
    return run[lo:hi]


def bath_events(intervals: list[dict]) -> list[dict]:
    """hot_water runs meeting duration + power bounds, shaped exactly like
    bath_detector's historical event dicts so write_bath_event and the ±2h
    dedup keep working unchanged."""
    events = []
    for run in runs(intervals, "hot_water"):
        # The bath bounds were calibrated on the DHW-shaped core of a run.
        # hvac_modes now also labels the partial interval at each end as
        # hot_water (2026-11-13); judging the predicate on the whole run would
        # let those low-power fragments drag the mean under the bath floor.
        core = _core(run)
        duration_min = len(core) * INTERVAL_MINUTES
        hp_mean = sum(i["hp_mean_w"] for i in core) / len(core)
        if (duration_min < BATH_MIN_MINUTES or hp_mean < BATH_MEAN_POWER_MIN_W
                or sum(i["energy_kwh"] for i in core) < BATH_MIN_KWH):
            continue
        energy_kwh = sum(i["energy_kwh"] for i in run)
        start = run[0]["start"]
        end = run[-1]["start"] + timedelta(minutes=INTERVAL_MINUTES)
        aux_mean = sum(i["aux_mean_w"] for i in run) / len(run)
        events.append({
            "start": start,
            "end": end,
            "duration_min": float(duration_min),
            "hp_mean_power_w": round(hp_mean, 1),
            "hp_max_power_w": round(max(i["hp_max_w"] for i in run), 1),
            "aux_active": any(i["aux_mean_w"] > 50.0 for i in run),
            "aux_mean_power_w": round(aux_mean, 1),
            "aux_max_power_w": round(max(i["aux_max_w"] for i in run), 1),
            "energy_kwh": round(energy_kwh, 3),
            "cost_dollars": round(cost_for_kwh(energy_kwh, start), 2),
        })
    return events
