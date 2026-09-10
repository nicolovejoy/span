#!/usr/bin/env python3
"""Daily energy report — queries InfluxDB, sends HTML email via Resend."""

import argparse
import base64
import calendar
import io
import json
import os
import re
import time
import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker
from influxdb_client import InfluxDBClient

from rates import ENERGY_RATE, BASE_CHARGE_DAILY
import report_baseline as rb
import collector_health as ch
import attribution
from hvac_modes import COOL_MIN_TEMP_F

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

INFLUXDB_URL = os.getenv("INFLUXDB_URL", "http://localhost:8086")
INFLUXDB_TOKEN = os.getenv("INFLUXDB_TOKEN")
INFLUXDB_ORG = os.getenv("INFLUXDB_ORG", "home")
INFLUXDB_BUCKET = os.getenv("INFLUXDB_BUCKET", "span")
RESEND_API_KEY = os.getenv("RESEND_API_KEY")
REPORT_EMAIL = os.getenv("REPORT_EMAIL")
REPORT_FROM = os.getenv("REPORT_FROM", "SPAN Monitor <energy@span.pianohouseproject.org>")
REPORT_HOUR = int(os.getenv("REPORT_HOUR", "7"))
LOCAL_TZ_NAME = os.getenv("TZ", "America/Los_Angeles")
LOCAL_TZ = ZoneInfo(LOCAL_TZ_NAME)
STATE_PATH = Path(os.getenv("REPORT_STATE_PATH", "/app/state/anomaly_state.json"))
# A full charge on the largest common EV pack (~100 kWh) plus AC charging
# losses; any single day's Car usage under this is normal EV behavior, not an
# anomaly, regardless of how irregular the historical baseline looks.
EV_FULL_CHARGE_KWH = float(os.getenv("EV_FULL_CHARGE_KWH", "120"))
# Daily "the heat pump cooled yesterday" alert off the hvac_mode timeline.
# Off by default: in cooling season it would fire every warm day. Flip it on
# for heating season, when any `cool` interval means the Stiebel ran cooling
# on its own setpoint while the thermostats sat on heat (2026-09-10).
HVAC_COOL_ALERT = os.getenv("HVAC_COOL_ALERT", "0").lower() in ("1", "true", "yes")
HVAC_COOL_ALERT_MIN_MINUTES = int(os.getenv("HVAC_COOL_ALERT_MIN_MINUTES", "15"))


def flux_ts(dt: datetime) -> str:
    """Format datetime as Flux-compatible UTC timestamp."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_day_utc_range(d: date) -> tuple[datetime, datetime]:
    """Convert a local date to UTC start/end datetimes."""
    start = datetime(d.year, d.month, d.day, tzinfo=LOCAL_TZ)
    end = start + timedelta(days=1)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


# ---------- circuit source routing (issue #9) ----------
#
# The collector writes raw 30s `circuit`/`power_w`; InfluxDB tasks derive
# `circuit_5m` / `circuit_1h`, each bucket carrying `energy_wh` (integral of
# |power_w| over the bucket, in Wh), `energy_wh_counter` (delta of SPAN's own
# cumulative meter — authoritative for energy since #15: the 30s power integral
# undercounts burst/impulse loads (EV charger above all) that pulse faster than
# our poll cadence; the counter is also immune to missed polls, a smaller effect)
# and `power_w_mean`. Summing energy_wh_counter costs
# one row per bucket instead of 120 raw points per hour — that's the whole win.
#
# Every circuit query below goes through _run_segments(), which splits the
# requested window into (measurement, start, stop) segments: raw for anything
# older than the backfill reaches, the rollup for the stretch it covers, raw
# again for the fresh tail the rollup task hasn't written yet. Cuts land on the
# aggregation grid so no output window straddles a segment boundary, and with no
# rollups present at all the plan degrades to a single raw segment — i.e. exactly
# the queries this file ran before #9. Panel queries have no rollup and are
# untouched.

MEAS_RAW = "circuit"
MEAS_5M = "circuit_5m"
MEAS_1H = "circuit_1h"
ROLLUP_PERIOD = {MEAS_5M: timedelta(minutes=5), MEAS_1H: timedelta(hours=1)}
ROLLUP_EVERY = {MEAS_5M: "5m", MEAS_1H: "1h"}

# Kill switch — USE_ROLLUPS=0 forces the pre-#9 raw queries.
USE_ROLLUPS = os.getenv("USE_ROLLUPS", "1").lower() not in ("0", "false", "no")
# Which end of its bucket a rollup point is stamped at. Auto-detected per run;
# this only settles a tie (aggregateWindow's own default is the window stop).
ROLLUP_STAMP = os.getenv("ROLLUP_STAMP", "stop")

_EVERY_RE = re.compile(r"^(\d+)(m|h)$")
_SUM_TAIL = '  |> group(columns: ["_time"])\n  |> sum()\n'


def _parse_flux_ts(s: str) -> datetime:
    """Inverse of flux_ts()."""
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _shift_ts(s: str, delta: timedelta) -> str:
    return flux_ts(_parse_flux_ts(s) + delta)


def _flux_dur(delta: timedelta) -> str:
    return f"{int(delta.total_seconds())}s"


def _every_minutes(every: str | None) -> int | None:
    """Minutes in a sub-day `every` literal ("15m", "2h"). None for 1d/1mo."""
    m = _EVERY_RE.match(every) if every else None
    return int(m.group(1)) * (60 if m.group(2) == "h" else 1) if m else None


def _grid_floor(dt: datetime, every: str | None) -> datetime:
    """Largest aggregateWindow boundary <= dt. Sub-day windows are anchored to
    the Unix epoch (verified against Influx); 1d/1mo follow the local calendar,
    matching `option location`."""
    if every is None:
        return dt
    mins = _every_minutes(every)
    if mins:
        step = mins * 60
        return datetime.fromtimestamp(int(dt.timestamp()) // step * step, tz=timezone.utc)
    lt = dt.astimezone(LOCAL_TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    if every == "1mo":
        lt = lt.replace(day=1)
    return lt.astimezone(timezone.utc)


def _grid_ceil(dt: datetime, every: str | None) -> datetime:
    """Smallest aggregateWindow boundary >= dt."""
    floor = _grid_floor(dt, every)
    if every is None or floor == dt:
        return floor
    mins = _every_minutes(every)
    if mins:
        return floor + timedelta(minutes=mins)
    lt = floor.astimezone(LOCAL_TZ)
    if every == "1mo":
        y, m = add_months(lt.year, lt.month, 1)
        lt = lt.replace(year=y, month=m)
    else:
        lt = lt + timedelta(days=1)   # wall-clock, so DST days stay whole
    return lt.astimezone(timezone.utc)


def _rollup_src(every: str | None) -> str:
    """Coarsest rollup whose buckets tile `every` exactly."""
    mins = _every_minutes(every)
    if mins is not None and mins < 60:
        return MEAS_5M if mins % 5 == 0 else MEAS_RAW
    return MEAS_1H


_ROLLUP_SPAN: dict[str, tuple[datetime, datetime] | None] = {}
_ROLLUP_STAMP_AT: dict[str, str] = {MEAS_RAW: "stop"}   # raw ignores it


def rollup_span(query_api, src: str) -> tuple[datetime, datetime] | None:
    """(oldest, newest) timestamp in rollup measurement `src`, or None when it
    holds nothing yet (tasks/backfill not run). Probed once per process; it only
    touches one row per bucket, so it is cheap even unbounded."""
    if src in _ROLLUP_SPAN:
        return _ROLLUP_SPAN[src]
    flux = f'''
base = from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: 0)
  |> filter(fn: (r) => r._measurement == "{src}" and r._field == "energy_wh")
  |> keep(columns: ["_time"])
  |> group()

union(tables: [base |> min(column: "_time"), base |> max(column: "_time")])
'''
    span = None
    try:
        times = sorted(rec.get_time()
                       for table in query_api.query(flux, org=INFLUXDB_ORG)
                       for rec in table.records)
        if times:
            span = (times[0], times[-1])
    except Exception as e:   # an empty measurement is fine; a broken query is not
        logger.warning(f"rollup probe for {src} failed, staying on raw: {e}")
    _ROLLUP_SPAN[src] = span
    logger.info(f"rollup {src}: {'absent' if span is None else f'{span[0]} .. {span[1]}'}")
    return span


def _rollup_stamp(query_api, src: str) -> str:
    """"stop" or "start" — which end of its bucket a rollup point is stamped at.
    aggregateWindow stamps the stop by default, but a task written with
    timeSrc: "_start" does the opposite and guessing wrong shifts every window by
    a whole bucket. Detected once by matching rollup buckets against raw energy
    over a recent 6h window; falls back to ROLLUP_STAMP when the window is too
    quiet to tell the two apart."""
    if src in _ROLLUP_STAMP_AT:
        return _ROLLUP_STAMP_AT[src]
    stamp = ROLLUP_STAMP
    period, every = ROLLUP_PERIOD[src], ROLLUP_EVERY[src]
    span = rollup_span(query_api, src)
    if span is None:
        return stamp
    try:
        end = _grid_floor(span[1], "1h") - period      # one bucket of slack
        begin = max(end - timedelta(hours=6), _grid_ceil(span[0], "1h"))
        if begin < end:
            raw = dict(_summed_rows(query_api, MEAS_RAW, flux_ts(begin), flux_ts(end), every))
            # rollup buckets as stored, unshifted — stamps either end of [begin, end)
            probe = f'''from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {flux_ts(begin)}, stop: {flux_ts(end + period)})
  |> filter(fn: (r) => r._measurement == "{src}" and r._field == "energy_wh")
  |> filter(fn: (r) => exists r._value)
  |> map(fn: (r) => ({{r with _value: r._value / 1000.0}}))
''' + _SUM_TAIL
            roll = [(rec.get_time(), rec.get_value() or 0.0)
                    for table in query_api.query(probe, org=INFLUXDB_ORG)
                    for rec in table.records]
            energy = sum(raw.values())
            if raw and roll and energy > 0:
                err = {
                    # stop-stamped: point at t is the window ending at t
                    "stop": sum(abs(v - raw[t]) for t, v in roll if t in raw),
                    # start-stamped: point at t is the window ending at t + period
                    "start": sum(abs(v - raw[t + period]) for t, v in roll
                                 if t + period in raw),
                }
                best = min(err, key=err.get)
                if abs(err["stop"] - err["start"]) > 0.01 * energy:
                    stamp = best
                else:
                    logger.warning(f"{src} stamp detection ambiguous "
                                   f"({err}); assuming {stamp}")
    except Exception as e:
        logger.warning(f"{src} stamp detection failed, assuming {stamp}: {e}")
    _ROLLUP_STAMP_AT[src] = stamp
    logger.info(f"rollup {src} stamped at bucket {stamp}")
    return stamp


def _circuit_kwh_flux(src: str, start: str, stop: str, every: str | None,
                      name_filter: str | None = None, mode: str = "energy",
                      stamp: str = "stop") -> str:
    """Pipeline yielding circuit energy in kWh — one value per `every`-window, or
    one per series when `every` is None. Raw integrates 30s power exactly as
    before #9; a rollup just sums its precomputed energy_wh_counter — SPAN's own
    meter delta, which avoids the raw integral's under-count of pulse-fast burst
    loads like the EV charger (#15). `mode="mean"`
    reproduces the mean-power-times-window form the hourly query has always used.

    Rollup rows are re-stamped to their bucket midpoint (and the range shifted to
    match) so a bucket can never land in the neighbouring output window."""
    raw = src == MEAS_RAW
    field = "power_w" if raw else ("energy_wh_counter" if mode == "energy" else "power_w_mean")
    nf = f'  |> filter(fn: (r) => r.name =~ /(?i){name_filter}/)\n' if name_filter else ''
    # rollup buckets can be null where the source had no points; raw never is
    nn = '' if raw else '  |> filter(fn: (r) => exists r._value)\n'
    shift = ''
    if raw:
        rng_start, rng_stop = start, stop
    else:
        period = ROLLUP_PERIOD[src]
        mid = -period / 2 if stamp == "stop" else period / 2
        offset = period / 2 - mid          # timedelta(0) or one period
        rng_start, rng_stop = _shift_ts(start, offset), _shift_ts(stop, offset)
        if every:
            shift = f'  |> timeShift(duration: {_flux_dur(mid)})\n'

    if every is None:
        agg = '  |> integral(unit: 1h)\n' if raw else '  |> sum()\n'
    elif mode == "mean":
        agg = f'  |> aggregateWindow(every: {every}, fn: mean, createEmpty: false)\n'
    elif raw:
        agg = (f'  |> aggregateWindow(\n'
               f'       every: {every},\n'
               f'       fn: (column, tables=<-) => tables |> integral(unit: 1h, column: column),\n'
               f'       createEmpty: false)\n')
    else:
        agg = f'  |> aggregateWindow(every: {every}, fn: sum, createEmpty: false)\n'

    loc = (f'import "timezone"\noption location = timezone.location(name: "{LOCAL_TZ_NAME}")\n\n'
           if every in ("1d", "1mo") else '')
    return f'''{loc}from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {rng_start}, stop: {rng_stop})
  |> filter(fn: (r) => r._measurement == "{src}" and r._field == "{field}")
{nf}{nn}{shift}  |> map(fn: (r) => ({{r with _value: if r._value < 0.0 then -r._value else r._value}}))
{agg}  |> map(fn: (r) => ({{r with _value: r._value / 1000.0}}))
'''


def _circuit_records(query_api, src: str, start: str, stop: str, every: str | None,
                     name_filter: str | None = None, mode: str = "energy",
                     tail: str = "") -> list:
    """Run one segment's circuit query and return its Flux records."""
    flux = _circuit_kwh_flux(src, start, stop, every, name_filter, mode,
                             _rollup_stamp(query_api, src)) + tail
    return [rec for table in query_api.query(flux, org=INFLUXDB_ORG)
            for rec in table.records]


def _summed_rows(query_api, src: str, start: str, stop: str, every: str | None,
                 name_filter: str | None = None,
                 mode: str = "energy") -> list[tuple[datetime, float]]:
    """(utc_window_stop, kWh) summed across every circuit matching name_filter."""
    return [(rec.get_time(), rec.get_value() or 0.0)
            for rec in _circuit_records(query_api, src, start, stop, every,
                                        name_filter, mode, tail=_SUM_TAIL)]


def _circuit_segments(query_api, start: str, stop: str,
                      every: str | None) -> list[tuple[str, str, str]]:
    """(measurement, start, stop) segments tiling [start, stop) — see the note at
    the top of this section. Always at least one segment; a lone raw one whenever
    the rollup can't help."""
    src = _rollup_src(every)
    span = rollup_span(query_api, src) if USE_ROLLUPS and src != MEAS_RAW else None
    if span is None:
        return [(MEAS_RAW, start, stop)]
    start_dt, stop_dt = _parse_flux_ts(start), _parse_flux_ts(stop)
    # Snap the rollup segment inwards to whole aggregation windows: conservative
    # under either stamping convention, and it keeps every truncated edge window
    # (whose stamp is clamped to the range bound) on the raw side, where it
    # stamps exactly as it always has.
    lo = _grid_ceil(max(start_dt, span[0]), every)
    hi = _grid_floor(min(stop_dt, span[1]), every)
    if hi <= lo:
        return [(MEAS_RAW, start, stop)]
    segments = [(src, flux_ts(lo), flux_ts(hi))]
    if start_dt < lo:
        segments.insert(0, (MEAS_RAW, start, flux_ts(lo)))
    if hi < stop_dt:
        segments.append((MEAS_RAW, flux_ts(hi), stop))
    return segments


def _run_segments(query_api, start: str, stop: str, every: str | None, run) -> list:
    """Concatenate run(measurement, start, stop) over each segment. A rollup
    segment that comes back empty is re-run against raw: a slow report beats one
    full of zeros."""
    rows: list = []
    for src, seg_start, seg_stop in _circuit_segments(query_api, start, stop, every):
        part = run(src, seg_start, seg_stop)
        if not part and src != MEAS_RAW:
            logger.warning(f"{src} empty over {seg_start}..{seg_stop}; falling back to raw")
            part = run(MEAS_RAW, seg_start, seg_stop)
        rows.extend(part)
    return rows


# ---------- weekly report + anomaly check: energy_wh_counter query layer ----------
#
# Deliberately narrower than the #9 segment router above: the weekly briefing and
# the daily anomaly check both read circuit_1h.energy_wh_counter only, never raw
# and never circuit_5m (design doc "Data source"). Every window this code asks
# for ends at least a day in the past, well past circuit_1h's 5-65 min tail lag,
# so there is no fresh-tail case to handle and no raw fallback is needed.
# circuit_1h is stop-stamped (verified invariant, influx_tasks/README.md) — that
# is hard-coded below rather than detected at runtime.

COUNTER_FIELD = "energy_wh_counter"


def _counter_kwh_flux(start: str, stop: str, every: str,
                      name_filter: str | None = None) -> str:
    """circuit_1h.energy_wh_counter summed into `every`-windows, in kWh.
    Pacific-aligned for 1d/1mo grids. Re-centred from its stop stamp to the
    bucket midpoint (shift range forward one period, then timeShift back half a
    period) so a bucket can never land in the neighbouring output window —
    the same recentring _circuit_kwh_flux does for stamp="stop"."""
    period = ROLLUP_PERIOD[MEAS_1H]
    mid = -period / 2
    rng_start, rng_stop = _shift_ts(start, period), _shift_ts(stop, period)
    nf = f'  |> filter(fn: (r) => r.name =~ /(?i){name_filter}/)\n' if name_filter else ''
    loc = (f'import "timezone"\noption location = timezone.location(name: "{LOCAL_TZ_NAME}")\n\n'
           if every in ("1d", "1mo") else '')
    return f'''{loc}from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {rng_start}, stop: {rng_stop})
  |> filter(fn: (r) => r._measurement == "{MEAS_1H}" and r._field == "{COUNTER_FIELD}")
  |> filter(fn: (r) => exists r._value)
{nf}  |> timeShift(duration: {_flux_dur(mid)})
  |> aggregateWindow(every: {every}, fn: sum, createEmpty: false)
  |> map(fn: (r) => ({{r with _value: r._value / 1000.0}}))
'''


def query_daily_circuit_counter_kwh(query_api, start: str, stop: str) -> list[tuple[str, date, float]]:
    """(circuit_name, local_date, kwh) via circuit_1h.energy_wh_counter — one row
    per circuit per Pacific day covered by [start, stop). The single workhorse
    query for the weekly briefing and the anomaly check: everything else (week
    totals, month totals, category rollups) is derived from these rows in pure
    Python — see the grouping helpers below."""
    flux = _counter_kwh_flux(start, stop, "1d")
    out: list[tuple[str, date, float]] = []
    for table in query_api.query(flux, org=INFLUXDB_ORG):
        for rec in table.records:
            out.append((rec.values.get("name", "Unknown"), _local_day(rec.get_time()),
                       rec.get_value() or 0.0))
    return out


# ---------- Task 2: Pure date/grouping helpers ----------


def local_week_start(d: date) -> date:
    """Monday on or before `d` — report weeks run Monday-Sunday."""
    return d - timedelta(days=d.weekday())


def category_day_kwh(rows: list[tuple[str, date, float]]) -> dict[date, dict[str, float]]:
    """rows -> {local_date: {category: kwh}}, circuits rolled up via display_bucket."""
    out: dict[date, dict[str, float]] = {}
    for name, day, kwh in rows:
        cat = display_bucket(name)
        day_map = out.setdefault(day, {})
        day_map[cat] = day_map.get(cat, 0.0) + kwh
    return out


def week_totals(day_cat: dict[date, dict[str, float]], week_start: date) -> dict[str, float]:
    """Sum category kWh over [week_start, week_start+7)."""
    week_end = week_start + timedelta(days=7)
    out: dict[str, float] = {}
    for day, cats in day_cat.items():
        if week_start <= day < week_end:
            for cat, kwh in cats.items():
                out[cat] = out.get(cat, 0.0) + kwh
    return out


def circuit_week_totals(rows: list[tuple[str, date, float]], week_start: date) -> dict[str, float]:
    """Per-circuit (not per-category) kWh over [week_start, week_start+7)."""
    week_end = week_start + timedelta(days=7)
    out: dict[str, float] = {}
    for name, day, kwh in rows:
        if week_start <= day < week_end:
            out[name] = out.get(name, 0.0) + kwh
    return out


def category_top_circuits(rows: list[tuple[str, date, float]], week_start: date,
                          category: str, n: int = 5) -> list[tuple[str, float]]:
    """Top-n circuits by kWh within `category`, for the usage table's nested rows."""
    totals = circuit_week_totals(rows, week_start)
    names = [name for name in totals if display_bucket(name) == category]
    return sorted(((name, totals[name]) for name in names), key=lambda x: -x[1])[:n]


def trailing_week_starts(target_week_start: date, n: int) -> list[date]:
    """The n Mondays strictly before target_week_start, oldest first."""
    return [target_week_start - timedelta(days=7 * i) for i in range(n, 0, -1)]


def trailing_month_starts(target_month_start: date, n: int) -> list[date]:
    """The n calendar-month starts strictly before target_month_start, oldest first."""
    starts = []
    for i in range(n, 0, -1):
        y, m = add_months(target_month_start.year, target_month_start.month, -i)
        starts.append(date(y, m, 1))
    return starts


def month_totals(day_cat: dict[date, dict[str, float]], month_start: date) -> dict[str, float]:
    """Sum category kWh over the calendar month starting at month_start."""
    month_end = _month_end_exclusive(month_start)
    out: dict[str, float] = {}
    for day, cats in day_cat.items():
        if month_start <= day < month_end:
            for cat, kwh in cats.items():
                out[cat] = out.get(cat, 0.0) + kwh
    return out


def circuit_month_totals(rows: list[tuple[str, date, float]], month_start: date) -> dict[str, float]:
    """Per-circuit (not per-category) kWh over the calendar month starting at month_start."""
    month_end = _month_end_exclusive(month_start)
    out: dict[str, float] = {}
    for name, day, kwh in rows:
        if month_start <= day < month_end:
            out[name] = out.get(name, 0.0) + kwh
    return out


def _sum_days(daily: dict[date, float], lo: date, hi_exclusive: date) -> float:
    return sum(v for d, v in daily.items() if lo <= d < hi_exclusive)


def unmonitored_kwh(panel_kwh: float, circuit_totals: dict[str, float]) -> float:
    """Panel total minus every known circuit — the energy the panel meters but no
    circuit sensor does (no washer/dryer/water-heater circuit; see #17). Floored
    at zero: circuit-level counter noise can occasionally exceed a noisy panel
    integral over a short window, and a negative "unmonitored" number is never
    meaningful. Period-agnostic — used for both week and month totals."""
    return max(0.0, panel_kwh - sum(circuit_totals.values()))


def _all_categories() -> list[str]:
    """Category display order: categories.json rules, then its default bucket."""
    rules, default = _load_bucket_rules()
    return [c for c, _ in rules] + [default]


# ---------- Task 3: Headline computation ----------


def _pct_delta(current: float, baseline: float) -> float | None:
    """Percentage change from baseline to current. Returns None if baseline <= 0."""
    return None if baseline <= 0 else (current - baseline) / baseline * 100.0


def headline_stats(week_kwh: float, last_week_kwh: float, trailing12_avg_kwh: float,
                   trailing12mo_avg_kwh: float,
                   week_cat: dict[str, float], last_week_cat: dict[str, float]) -> dict:
    """Block 1's numbers. Largest mover excludes "Unmonitored" — it's a metering
    accounting row, not a category a reader can act on."""
    movers = {c: week_cat.get(c, 0.0) - last_week_cat.get(c, 0.0)
             for c in (set(week_cat) | set(last_week_cat)) - {"Unmonitored"}}
    top_mover = max(movers, key=lambda c: abs(movers[c])) if movers else None
    if top_mover is not None and movers[top_mover] == 0.0:
        top_mover = None   # a flat week — nothing actually moved, don't name one arbitrarily
    return {
        "kwh": week_kwh,
        "cost": cost_n_days(week_kwh, 7),
        "delta_vs_last_week_pct": _pct_delta(week_kwh, last_week_kwh),
        "delta_vs_12wk_pct": _pct_delta(week_kwh, trailing12_avg_kwh),
        "delta_vs_12mo_pct": _pct_delta(week_kwh, trailing12mo_avg_kwh),
        "top_mover": top_mover,
        "top_mover_delta_kwh": movers.get(top_mover, 0.0) if top_mover else 0.0,
    }


# ---------- Task 4: WeeklyContext orchestration ----------


@dataclass
class WeeklyContext:
    """Everything the weekly-briefing renders need. `week_start` is the target
    week's Monday; `rows`/`panel_daily` span the full fetch window (98 days, or
    12 months back from the target week's month if that's earlier) so the
    12-week trend, 12-month trend, and HVAC's month-over-month (Task 7) can all
    be derived without a second Influx round trip."""
    week_start: date
    rows: list[tuple[str, date, float]]
    panel_daily: dict[date, float]
    day_cat: dict[date, dict[str, float]]
    categories: list[str]
    headline: dict
    usage_rows: list[dict]
    week_by_day: list[tuple[date, dict[str, float]]]
    trend: list[tuple[date, dict[str, float]]]
    month_trend: list[tuple[date, dict[str, float]]]

    @property
    def date_str(self) -> str:
        week_end = self.week_start + timedelta(days=6)
        return f'{self.week_start.strftime("%b %-d")}–{week_end.strftime("%b %-d, %Y")}'


def build_weekly_context(query_api, week_start: date) -> WeeklyContext:
    """Window conventions:
      TARGET WEEK  = [week_start, week_start+7)              Monday-Sunday
      TARGET MONTH = the calendar month containing the target week's Sunday
                    (matches mom_comparison's anchor in the HVAC block)
      FETCH        = [min(week_start-98, target_month_start-12mo), week_start+7)
                    14 weeks back covers the 12-week trend (block 3) and the
                    2-month look-back for HVAC month-over-month (Task 7); 12
                    months back covers the 12-month trend (block 3b) — whichever
                    reaches further is the actual fetch start
    """
    week_end = week_start + timedelta(days=6)
    target_month_start = date(week_end.year, week_end.month, 1)
    trailing12_month_starts = trailing_month_starts(target_month_start, 12)

    fetch_start_date = min(week_start - timedelta(days=98), trailing12_month_starts[0])
    fetch_start = flux_ts(local_day_utc_range(fetch_start_date)[0])
    fetch_stop = flux_ts(local_day_utc_range(week_start + timedelta(days=7))[0])

    rows = query_daily_circuit_counter_kwh(query_api, fetch_start, fetch_stop)
    panel_daily = dict(query_daily_panel_kwh(query_api, fetch_start, fetch_stop))
    day_cat = category_day_kwh(rows)
    categories = _all_categories()

    last_week_start = week_start - timedelta(days=7)
    this_week_cat = week_totals(day_cat, week_start)
    last_week_cat = week_totals(day_cat, last_week_start)
    trailing12_starts = trailing_week_starts(week_start, 12)

    week_panel_kwh = _sum_days(panel_daily, week_start, week_start + timedelta(days=7))
    last_week_panel_kwh = _sum_days(panel_daily, last_week_start, week_start)
    trailing12_panel = [_sum_days(panel_daily, ws, ws + timedelta(days=7))
                        for ws in trailing12_starts]
    trailing12_avg_panel = sum(trailing12_panel) / len(trailing12_panel) if trailing12_panel else 0.0

    trailing12mo_panel = [_sum_days(panel_daily, ms, _month_end_exclusive(ms))
                          for ms in trailing12_month_starts]
    trailing12mo_avg_panel = sum(trailing12mo_panel) / len(trailing12mo_panel) if trailing12mo_panel else 0.0

    headline = headline_stats(week_panel_kwh, last_week_panel_kwh, trailing12_avg_panel,
                              trailing12mo_avg_panel, this_week_cat, last_week_cat)

    circuit_totals = circuit_week_totals(rows, week_start)
    usage_rows = []
    for cat in categories:
        kwh = this_week_cat.get(cat, 0.0)
        wk12 = [week_totals(day_cat, ws).get(cat, 0.0) for ws in trailing12_starts]
        avg12 = sum(wk12) / len(wk12) if wk12 else 0.0
        mo12 = [month_totals(day_cat, ms).get(cat, 0.0) for ms in trailing12_month_starts]
        avg12mo = sum(mo12) / len(mo12) if mo12 else 0.0
        usage_rows.append({
            "category": cat,
            "kwh": kwh,
            "cost": round(kwh * ENERGY_RATE, 2),
            "delta_week_pct": _pct_delta(kwh, last_week_cat.get(cat, 0.0)),
            "delta_12wk_pct": _pct_delta(kwh, avg12),
            "delta_12mo_pct": _pct_delta(kwh, avg12mo),
            "top_circuits": category_top_circuits(rows, week_start, cat),
        })

    unmon = unmonitored_kwh(week_panel_kwh, circuit_totals)
    last_unmon = unmonitored_kwh(last_week_panel_kwh, circuit_week_totals(rows, last_week_start))
    unmon_wk12 = [unmonitored_kwh(_sum_days(panel_daily, ws, ws + timedelta(days=7)),
                                  circuit_week_totals(rows, ws))
                 for ws in trailing12_starts]
    unmon_avg12 = sum(unmon_wk12) / len(unmon_wk12) if unmon_wk12 else 0.0
    unmon_mo12 = [unmonitored_kwh(_sum_days(panel_daily, ms, _month_end_exclusive(ms)),
                                  circuit_month_totals(rows, ms))
                 for ms in trailing12_month_starts]
    unmon_avg12mo = sum(unmon_mo12) / len(unmon_mo12) if unmon_mo12 else 0.0
    usage_rows.append({
        "category": "Unmonitored",
        "kwh": unmon,
        "cost": round(unmon * ENERGY_RATE, 2),
        "delta_week_pct": _pct_delta(unmon, last_unmon),
        "delta_12wk_pct": _pct_delta(unmon, unmon_avg12),
        "delta_12mo_pct": _pct_delta(unmon, unmon_avg12mo),
        "top_circuits": [],
    })

    week_by_day = [
        (week_start + timedelta(days=i),
         {c: day_cat.get(week_start + timedelta(days=i), {}).get(c, 0.0) for c in categories})
        for i in range(7)
    ]
    trend = [(ws, week_totals(day_cat, ws)) for ws in trailing12_starts + [week_start]]
    month_trend = [(ms, month_totals(day_cat, ms))
                   for ms in trailing12_month_starts + [target_month_start]]

    return WeeklyContext(
        week_start=week_start, rows=rows, panel_daily=panel_daily, day_cat=day_cat,
        categories=categories, headline=headline, usage_rows=usage_rows,
        week_by_day=week_by_day, trend=trend, month_trend=month_trend,
    )


def _merge_keyed(rows) -> list[tuple]:
    """Sum values sharing a key, ascending by key. Segment cuts land on window
    boundaries so collisions shouldn't arise — but sum rather than silently drop
    a day if one ever does."""
    acc: dict = {}
    for k, v in rows:
        acc[k] = acc.get(k, 0.0) + v
    return sorted(acc.items())


def _local_day(t: datetime) -> date:
    # aggregateWindow stamps each window at its STOP, i.e. local midnight of the next day
    return (t.astimezone(LOCAL_TZ) - timedelta(seconds=1)).date()


def query_total_kwh(query_api, start: str, stop: str) -> float:
    """Total grid consumption in kWh for the given range."""
    flux = f'''
from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {start}, stop: {stop})
  |> filter(fn: (r) => r._measurement == "panel" and r._field == "grid_power_w")
  |> integral(unit: 1h)
  |> map(fn: (r) => ({{r with _value: r._value / 1000.0}}))
'''
    for table in query_api.query(flux, org=INFLUXDB_ORG):
        for record in table.records:
            return round(record.get_value(), 2)
    return 0.0


_BUCKET_RULES: list[tuple[str, re.Pattern]] | None = None
_BUCKET_DEFAULT: str = "Else"

_FALLBACK_RULES = [
    ("Lights",     r"Light"),
    ("HVAC",       r"Heat pump|Auxiliary"),
    ("Car",        r"Tesla|Car Charger|\bEV\b"),
    ("Appliances", r"Kitchen|Oven|Dishwasher|Refrigerator|Fridge|Microwave|Range|Washer|Dryer|Laundry|Beverage|Freezer"),
]


def _load_bucket_rules() -> tuple[list[tuple[str, re.Pattern]], str]:
    """Load (compiled) bucket rules from categories.json, with a fallback."""
    global _BUCKET_RULES, _BUCKET_DEFAULT
    if _BUCKET_RULES is not None:
        return _BUCKET_RULES, _BUCKET_DEFAULT
    cats_path = Path(__file__).parent / "categories.json"
    try:
        cfg = json.loads(cats_path.read_text())
        _BUCKET_DEFAULT = cfg.get("default", "Else")
        _BUCKET_RULES = [
            (r["category"], re.compile(r["pattern"], re.IGNORECASE))
            for r in cfg.get("rules", [])
        ]
    except (OSError, json.JSONDecodeError, KeyError) as e:
        logger.warning(f"categories.json unavailable, using fallback buckets: {e}")
        _BUCKET_RULES = [(c, re.compile(p, re.IGNORECASE)) for c, p in _FALLBACK_RULES]
    return _BUCKET_RULES, _BUCKET_DEFAULT


def query_daily_panel_kwh(query_api, start: str, stop: str) -> list[tuple[date, float]]:
    """Daily grid kWh via per-local-day integral. One record per local calendar day."""
    flux = f'''
import "timezone"
option location = timezone.location(name: "{LOCAL_TZ_NAME}")

from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {start}, stop: {stop})
  |> filter(fn: (r) => r._measurement == "panel" and r._field == "grid_power_w")
  |> aggregateWindow(
       every: 1d,
       fn: (column, tables=<-) => tables |> integral(unit: 1h, column: column),
       createEmpty: true)
  |> map(fn: (r) => ({{r with _value: (if exists r._value then r._value else 0.0) / 1000.0}}))
'''
    out: list[tuple[date, float]] = []
    for table in query_api.query(flux, org=INFLUXDB_ORG):
        for record in table.records:
            t = record.get_time().astimezone(LOCAL_TZ)
            # aggregateWindow stamps each window at its STOP, i.e. local midnight of the next day
            day = (t - timedelta(seconds=1)).date()
            out.append((day, record.get_value() or 0.0))
    return out


def add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    """Add `delta` calendar months to (year, month). Handles negative deltas."""
    total = year * 12 + (month - 1) + delta
    return total // 12, total % 12 + 1


def _month_end_exclusive(month_start: date) -> date:
    """First day of the month after month_start."""
    y, m = add_months(month_start.year, month_start.month, 1)
    return date(y, m, 1)


# ---------- retained utilities from the old daily report (used by the
# category/headline grouping helpers above and by the render functions below;
# the rest of the old daily-report pipeline was retired in Task 5) ----------


def cost_n_days(kwh: float, days: int) -> float:
    """Total cost for `days` days at `kwh` energy (energy + N × base)."""
    return round(kwh * ENERGY_RATE + days * BASE_CHARGE_DAILY, 2)


def display_bucket(name: str) -> str:
    """Roll up raw circuit name into a coarse display bucket (categories.json)."""
    rules, default = _load_bucket_rules()
    for category, pat in rules:
        if pat.search(name):
            return category
    return default


def _add_cost_axis(ax, label: str) -> None:
    """Add a secondary $ y-axis mirroring `ax`'s primary kWh axis, using the
    flat SCL rate (energy-only, no base charge). Call after the primary
    axis's data/margins are final so the twin's limits line up. Only calls
    methods on `ax` — matplotlib-agnostic, so a plain mock works in tests."""
    lo, hi = ax.get_ylim()
    ax2 = ax.twinx()
    ax2.set_ylim(lo * ENERGY_RATE, hi * ENERGY_RATE)
    ax2.set_ylabel(label)
    ax2.yaxis.set_major_formatter(matplotlib.ticker.StrMethodFormatter("${x:,.2f}"))
    ax2.grid(False)


def _fig_to_b64(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _chart_img(b64: str, alt: str) -> str:
    return (f'<img src="data:image/png;base64,{b64}" alt="{alt}" '
            f'style="width:100%;max-width:560px;display:block;margin:8px 0;">')


def _delta_arrow(current: float, baseline: float) -> str:
    if baseline == 0 or current == 0:
        return ""
    pct = (current - baseline) / baseline * 100
    arrow, color = ("&uarr;", "#e74c3c") if pct > 0 else ("&darr;", "#27ae60")
    return (f' <span style="color:{color};font-size:12px;font-weight:500;">'
            f'{arrow}{abs(pct):.0f}% vs yesterday</span>')


def seconds_until_hour(hour: int) -> float:
    """Seconds until the next occurrence of `hour` in local time."""
    now = datetime.now()
    target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return (target - now).total_seconds()


CSS = """
body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; }
h2 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 8px; }
h3 { color: #2c3e50; margin-top: 24px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
th, td { padding: 6px 12px; text-align: left; border-bottom: 1px solid #eee; }
th { background: #f8f9fa; font-weight: 600; }
table.summary td { text-align: right; }
table.summary th:first-child, table.summary td:first-child { text-align: left; }
"""


def send_email(html: str, subject: str):
    """Send report email via Resend API. DRY_RUN=1 logs instead of sending —
    used for read-only dry-runs against real data (#16 gap check) and is
    useful permanently for any manual on-demand run."""
    if os.getenv("DRY_RUN", "0").lower() not in ("0", "false", "no"):
        logger.info(f"DRY_RUN: would send '{subject}' ({len(html)} chars html)")
        return
    resp = httpx.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
        json={
            "from": REPORT_FROM,
            "to": [REPORT_EMAIL],
            "subject": subject,
            "html": html,
        },
        timeout=30.0,
    )
    resp.raise_for_status()
    logger.info(f"Email sent to {REPORT_EMAIL}: {resp.json().get('id')}")


# ---------- Task 5: weekly briefing blocks 1-4, wiring ----------


CATEGORY_COLORS = {
    "Lights": "#f1c40f", "HVAC": "#e74c3c", "Car": "#3498db",
    "Appliances": "#e67e22", "Else": "#16a085", "Unmonitored": "#95a5a6",
}


def render_headline(ctx: WeeklyContext) -> str:
    h = ctx.headline
    week_delta = _delta_arrow_pct(h["delta_vs_last_week_pct"], " vs last week")
    avg_delta = _delta_arrow_pct(h["delta_vs_12wk_pct"], " vs 12-wk avg")
    mo_delta = _delta_arrow_pct(h["delta_vs_12mo_pct"], " vs 12-mo avg")
    mover = (f' The biggest mover was <strong>{h["top_mover"]}</strong> '
            f'({h["top_mover_delta_kwh"]:+.1f} kWh vs last week).'
            if h["top_mover"] else "")
    return f'''<h2>Weekly Energy Report &mdash; {ctx.date_str}</h2>
<p style="font-size:15px;">
<strong>{h["kwh"]:.1f} kWh</strong> (${h["cost"]:.2f}){week_delta}{avg_delta}{mo_delta}.{mover}
</p>'''


def _delta_arrow_pct(pct: float | None, suffix: str) -> str:
    if pct is None:
        return ""
    arrow, color = ("&uarr;", "#e74c3c") if pct > 0 else ("&darr;", "#27ae60")
    return (f' <span style="color:{color};font-size:13px;font-weight:500;">'
           f'{arrow}{abs(pct):.0f}%{suffix}</span>')


def render_week_by_day_chart(ctx: WeeklyContext) -> str:
    """Block 2 — 7 bars stacked by category."""
    if not ctx.week_by_day:
        return ""
    labels = [d.strftime("%a %-m/%-d") for d, _ in ctx.week_by_day]
    fig, ax = plt.subplots(figsize=(7, 3.4), dpi=120)
    bottom = [0.0] * len(labels)
    for cat in ctx.categories:
        vals = [cats.get(cat, 0.0) for _, cats in ctx.week_by_day]
        ax.bar(labels, vals, bottom=bottom, width=0.6,
              color=CATEGORY_COLORS.get(cat, "#888"), label=cat)
        bottom = [b + v for b, v in zip(bottom, vals)]
    ax.set_ylabel("kWh")
    ax.grid(True, alpha=0.3, axis="y")
    ax.legend(loc="upper left", fontsize=8, ncol=3)
    _add_cost_axis(ax, "$")
    fig.autofmt_xdate()
    fig.tight_layout()
    b64 = _fig_to_b64(fig)
    return f'<h3>This week by day</h3>\n{_chart_img(b64, "This week by day, by category")}'


def render_12wk_trend_chart(ctx: WeeklyContext) -> str:
    """Block 3 — stacked histogram of weekly totals by category, 13 weeks
    (12 trailing + the target week) so direction and composition read in one
    image."""
    if not ctx.trend:
        return ""
    labels = [ws.strftime("%-m/%-d") for ws, _ in ctx.trend]
    fig, ax = plt.subplots(figsize=(7, 3.2), dpi=120)
    bottom = [0.0] * len(labels)
    for cat in ctx.categories:
        vals = [totals.get(cat, 0.0) for _, totals in ctx.trend]
        ax.bar(labels, vals, bottom=bottom, width=0.7,
              color=CATEGORY_COLORS.get(cat, "#888"), label=cat)
        bottom = [b + v for b, v in zip(bottom, vals)]
    ax.set_xticklabels(labels, fontsize=8, rotation=45, ha="right")
    ax.set_ylabel("kWh / week")
    ax.grid(True, alpha=0.3, axis="y")
    ax.legend(loc="upper left", fontsize=8, ncol=3)
    _add_cost_axis(ax, "$ / week")
    fig.tight_layout()
    b64 = _fig_to_b64(fig)
    return f'<h3>12-week trend</h3>\n{_chart_img(b64, "12-week trend by category")}'


def render_12mo_trend_chart(ctx: WeeklyContext) -> str:
    """Block 3b — stacked histogram of monthly totals by category, 13 months
    (12 trailing + the calendar month containing the target week) so long-run
    direction and composition read in one image. Early months read as
    near-zero/zero until a full year of collector history accrues (collection
    started 2025-12-26). The rightmost bar is labeled "(MTD)" when the target
    week doesn't reach the end of its calendar month, so a partial month never
    reads as a real dip."""
    if not ctx.month_trend:
        return ""
    target_month_start, _ = ctx.month_trend[-1]
    target_month_end = _month_end_exclusive(target_month_start) - timedelta(days=1)
    is_partial = (ctx.week_start + timedelta(days=6)) < target_month_end
    labels = [ms.strftime("%b '%y") for ms, _ in ctx.month_trend]
    if is_partial:
        labels[-1] += " (MTD)"
    fig, ax = plt.subplots(figsize=(7, 3.2), dpi=120)
    bottom = [0.0] * len(labels)
    for cat in ctx.categories:
        vals = [totals.get(cat, 0.0) for _, totals in ctx.month_trend]
        ax.bar(labels, vals, bottom=bottom, width=0.7,
              color=CATEGORY_COLORS.get(cat, "#888"), label=cat)
        bottom = [b + v for b, v in zip(bottom, vals)]
    ax.set_xticklabels(labels, fontsize=8, rotation=45, ha="right")
    ax.set_ylabel("kWh / month")
    ax.grid(True, alpha=0.3, axis="y")
    ax.legend(loc="upper left", fontsize=8, ncol=3)
    _add_cost_axis(ax, "$ / month")
    fig.tight_layout()
    b64 = _fig_to_b64(fig)
    return f'<h3>12-month trend</h3>\n{_chart_img(b64, "12-month trend by category")}'


def render_usage_table(ctx: WeeklyContext) -> str:
    """Block 4 — one table replacing the old cost-breakdown + top-circuits
    sections. Per-category cost is energy-only (kWh * ENERGY_RATE); the base
    service charge isn't attributable to a category and only appears in the
    headline's whole-week cost."""
    def pct_cell(pct: float | None) -> str:
        if pct is None:
            return "&mdash;"
        arrow, color = ("&uarr;", "#e74c3c") if pct > 0 else ("&darr;", "#27ae60")
        return f'<span style="color:{color};">{arrow}{abs(pct):.0f}%</span>'

    rows_html = []
    for r in ctx.usage_rows:
        rows_html.append(
            f'<tr><td>{r["category"]}</td><td>{r["kwh"]:.1f}</td><td>${r["cost"]:.2f}</td>'
            f'<td>{pct_cell(r["delta_week_pct"])}</td><td>{pct_cell(r["delta_12wk_pct"])}</td>'
            f'<td>{pct_cell(r["delta_12mo_pct"])}</td></tr>'
        )
        if r["top_circuits"]:
            nested = ", ".join(f'{name} ({kwh:.1f} kWh)' for name, kwh in r["top_circuits"])
            rows_html.append(
                f'<tr><td colspan="6" style="font-size:11px;color:#888;padding-left:24px;">'
                f'{nested}</td></tr>'
            )
    return f'''<h3>Usage by category</h3>
<table>
<tr><th>Category</th><th>kWh</th><th>Cost</th><th>vs last wk</th><th>vs 12-wk avg</th><th>vs 12-mo avg</th></tr>
{"".join(rows_html)}
</table>'''


def mom_comparison(day_cat: dict[date, dict[str, float]], as_of: date,
                   category: str) -> tuple[float, float]:
    """(this-month-to-date, same-cutoff last month) kWh for `category` — both
    covering day 1 through as_of.day of their respective months, so a
    16-days-in month compares fairly against a full 30-day one instead of
    against a partial vs. complete mismatch."""
    this_start = as_of.replace(day=1)

    def total(lo: date, hi: date) -> float:
        return sum(cats.get(category, 0.0) for d, cats in day_cat.items() if lo <= d <= hi)

    this_month = total(this_start, as_of)

    prev_y, prev_m = add_months(as_of.year, as_of.month, -1)
    prev_start = date(prev_y, prev_m, 1)
    prev_cutoff = min(as_of.day, calendar.monthrange(prev_y, prev_m)[1])
    prev_end = date(prev_y, prev_m, prev_cutoff)
    last_month = total(prev_start, prev_end)

    return this_month, last_month


def render_hvac_block(ctx: WeeklyContext) -> str:
    """Block 5 — HVAC by day (this week), week-over-week, month-over-month.
    Renders without a hot-water/space-conditioning split; gains a row when
    that detector work (out of scope here) lands."""
    hvac_by_day = [cats.get("HVAC", 0.0) for _, cats in ctx.week_by_day]
    if not any(hvac_by_day):
        return ""
    labels = [d.strftime("%a") for d, _ in ctx.week_by_day]
    fig, ax = plt.subplots(figsize=(7, 2.8), dpi=120)
    ax.bar(labels, hvac_by_day, width=0.6, color=CATEGORY_COLORS["HVAC"])
    ax.set_ylabel("kWh")
    ax.grid(True, alpha=0.3, axis="y")
    _add_cost_axis(ax, "$")
    fig.tight_layout()
    b64 = _fig_to_b64(fig)

    week_end = ctx.week_start + timedelta(days=6)
    this_week = sum(hvac_by_day)
    last_week = week_totals(ctx.day_cat, ctx.week_start - timedelta(days=7)).get("HVAC", 0.0)
    this_month, last_month = mom_comparison(ctx.day_cat, week_end, "HVAC")

    wow = _delta_arrow_pct(_pct_delta(this_week, last_week), " vs last week")
    mom = _delta_arrow_pct(_pct_delta(this_month, last_month), " vs last month")
    return f'''<h3>HVAC</h3>
{_chart_img(b64, "HVAC by day this week")}
<p style="font-size:13px;color:#444;">
{this_week:.1f} kWh this week{wow} &middot; {this_month:.1f} kWh this month{mom}
</p>'''


WEEKLY_SECTIONS = [render_headline, render_week_by_day_chart, render_12wk_trend_chart,
                  render_12mo_trend_chart, render_usage_table, render_hvac_block]


def build_weekly_html(ctx: WeeklyContext) -> str:
    body = "\n\n".join(s for s in (section(ctx) for section in WEEKLY_SECTIONS) if s)
    return f'''<!DOCTYPE html>
<html><head><style>{CSS}</style></head>
<body>
{body}
</body></html>'''


def generate_weekly_report(client: InfluxDBClient, week_start: date):
    """Build and send the Monday briefing for the week starting `week_start`."""
    ctx = build_weekly_context(client.query_api(), week_start)
    send_email(build_weekly_html(ctx), f"Weekly Energy Report — {ctx.date_str}")


# ---------- Task 10: daily anomaly check — wiring report_baseline into I/O ----------


def _day_coverage_flux(target_date: date) -> str:
    """circuit_1h is stop-stamped — a bucket at time T covers [T-1h, T) — so the
    query range must be shifted forward by one bucket period (same shift
    _counter_kwh_flux applies) for the 24 stamps counted here to actually cover
    [local midnight, local midnight+1d) for `target_date`.

    `distinct(column: "_time") |> count()` errors in real Influx ("count:
    unsupported aggregate column type time") -- map each distinct time to a
    plain int 1 and sum those instead (#16 Task 3b). `distinct(column:
    "_time")` also drops the `_time` column itself (the distinct values land
    in `_value`, time-typed), so the map must restore `_time` explicitly
    (`_time: r._value`) -- verified against real data: `{r with _value: 1}`
    (which relies on `_time` still being present) silently produced zero
    output rows for this measurement/field, even though the same pattern
    happened to work for status.sh's circuit/power_w query. Restoring `_time`
    explicitly is correct and non-empty in both cases."""
    period = ROLLUP_PERIOD[MEAS_1H]
    start, stop = local_day_utc_range(target_date)
    rng_start, rng_stop = _shift_ts(flux_ts(start), period), _shift_ts(flux_ts(stop), period)
    return f'''
from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {rng_start}, stop: {rng_stop})
  |> filter(fn: (r) => r._measurement == "{MEAS_1H}" and r._field == "{COUNTER_FIELD}")
  |> filter(fn: (r) => exists r._value)
  |> group()
  |> distinct(column: "_time")
  |> map(fn: (r) => ({{_time: r._value, _value: 1}}))
  |> group()
  |> sum()
'''


def query_day_coverage(query_api, target_date: date) -> float:
    """Fraction of the 24 expected circuit_1h hours present for `target_date`
    (Pacific), across any circuit. Gates all anomaly alerting for the day —
    see report_baseline.day_coverage_ok."""
    for table in query_api.query(_day_coverage_flux(target_date), org=INFLUXDB_ORG):
        for rec in table.records:
            return min(1.0, (rec.get_value() or 0) / 24.0)
    return 0.0


def render_anomaly_email(target_date: date,
                         alerts: list[tuple[str, float, "rb.Baseline", "rb.AnomalyResult"]],
                         top_circuits: dict[str, list[tuple[str, float]]]) -> tuple[str, str]:
    """(subject, html). Subject carries the whole message — most days it's
    actionable without opening (spec: 'The anomaly email' > Content)."""
    if len(alerts) == 1:
        cat, value, baseline, result = alerts[0]
        if result.pct is None:
            # Baseline median is 0 (e.g. a circuit that's normally idle on this
            # weekday) — a percentage vs. zero is undefined, so fall back to an
            # absolute comparison instead of rendering "inf%".
            subject = (f"⚡ {cat} {value:.1f} kWh vs a normal {baseline.median:.1f} kWh "
                      f"for a {target_date.strftime('%A')}")
        else:
            direction = "above" if value > baseline.median else "below"
            subject = (f"⚡ {cat} {result.pct:.0f}% {direction} normal for a "
                      f"{target_date.strftime('%A')}")
    else:
        subject = f"⚡ Unusual usage: {', '.join(c for c, *_ in alerts)}"

    blocks = []
    for cat, value, baseline, result in alerts:
        circuits = ", ".join(f"{n} ({k:.1f} kWh)" for n, k in top_circuits.get(cat, [])[:3])
        blocks.append(f'''<h3>{cat}</h3>
<p>{value:.1f} kWh vs a normal {baseline.median:.1f} kWh for a
{target_date.strftime("%A")} (${value * ENERGY_RATE:.2f}).</p>
<p style="font-size:13px;color:#666;">Driven by: {circuits or "no single circuit stands out"}</p>''')

    html = f'''<!DOCTYPE html>
<html><head><style>{CSS}</style></head>
<body>
<h2>Unusual usage &mdash; {target_date.strftime("%A, %B %-d")}</h2>
{"".join(blocks)}
</body></html>'''
    return subject, html


def generate_anomaly_check(client: InfluxDBClient, target_date: date):
    """Runs daily for `target_date` (the previous local day, at 07:00). Sends
    nothing on a normal day."""
    query_api = client.query_api()
    coverage = query_day_coverage(query_api, target_date)
    if not rb.day_coverage_ok(coverage):
        logger.warning(f"{target_date}: coverage {coverage:.0%} < 90%, suppressing all alerts")
        return

    sample_dates = rb.trailing_same_weekday_dates(target_date, 8)
    fetch_start = flux_ts(local_day_utc_range(sample_dates[0])[0])
    fetch_stop = flux_ts(local_day_utc_range(target_date + timedelta(days=1))[0])
    rows = query_daily_circuit_counter_kwh(query_api, fetch_start, fetch_stop)
    day_cat = category_day_kwh(rows)

    alerts = []
    for category in _all_categories():
        samples = [day_cat[d][category] for d in sample_dates
                  if d in day_cat and category in day_cat[d]]
        if not rb.category_coverage_ok(len(samples)):
            logger.info(f"{category}: only {len(samples)}/8 baseline samples, skipping")
            continue
        value = day_cat.get(target_date, {}).get(category, 0.0)
        if category == "Car" and value <= EV_FULL_CHARGE_KWH:
            # EV charging is legitimately irregular day-to-day (the weekly
            # report excludes it from comparisons for the same reason) -- up
            # to a full charge's worth is normal any day, not an anomaly.
            rb.clear_state(STATE_PATH, category)
            continue
        baseline = rb.compute_baseline(samples)
        result = rb.evaluate(value, baseline)
        state = rb.load_state(STATE_PATH, category)
        if result.is_anomalous:
            if rb.should_alert(result, state):
                alerts.append((category, value, baseline, result))
                rb.save_state(STATE_PATH, category, target_date, result.z)
        else:
            rb.clear_state(STATE_PATH, category)

    if not alerts:
        return

    day_rows = [r for r in rows if r[1] == target_date]
    top_circuits = {cat: category_top_circuits(day_rows, target_date, cat, n=3)
                    for cat, *_ in alerts}
    subject, html = render_anomaly_email(target_date, alerts, top_circuits)
    send_email(html, subject)


# ---------- Task 3: daily data-gap check (#16) ----------
#
# Independent of the anomaly check above: this measures the collector's own
# polling coverage (did it poll every 30s?) rather than energy values. Reads
# raw `circuit`/`power_w` timestamps directly -- never the rollups, which
# smooth over exactly the gaps this is trying to catch -- plus the
# `collector_poll` measurement (#16 Task 2) for a per-error-type breakdown.
# `collector_poll` may have no rows at all before that deploy; every query
# here degrades gracefully to "no data" rather than raising.


def _poll_timestamps_flux(start: str, stop: str) -> str:
    return f'''
from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {start}, stop: {stop})
  |> filter(fn: (r) => r._measurement == "{MEAS_RAW}" and r._field == "power_w")
  |> group()
  |> distinct(column: "_time")
'''


def query_poll_timestamps(query_api, start: str, stop: str) -> list[datetime]:
    """One timestamp per collector iteration in [start, stop), deduped across
    circuits -- circuit-agnostic so a single circuit's own dropout doesn't
    read as a collector-wide gap. `distinct(column: "_time")` moves the
    distinct timestamps into `_value` (and drops the `_time` column itself),
    so the values -- not get_time() -- carry the timestamps here."""
    out: list[datetime] = []
    for table in query_api.query(_poll_timestamps_flux(start, stop), org=INFLUXDB_ORG):
        for rec in table.records:
            out.append(rec.get_value())
    return out


def _poll_failures_flux(start: str, stop: str) -> str:
    return f'''
from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {start}, stop: {stop})
  |> filter(fn: (r) => r._measurement == "collector_poll" and r._field == "points")
  |> filter(fn: (r) => r.result != "ok")
  |> group(columns: ["error"])
  |> count()
'''


def query_poll_failures(query_api, start: str, stop: str) -> dict[str, int]:
    """{error_tag: count} for [start, stop). Empty when collector_poll has no
    data yet (pre-#16 deploy) or the day had zero non-ok polls."""
    out: dict[str, int] = {}
    for table in query_api.query(_poll_failures_flux(start, stop), org=INFLUXDB_ORG):
        for rec in table.records:
            error = rec.values.get("error", "unknown")
            out[error] = out.get(error, 0) + int(rec.get_value() or 0)
    return out


def _fmt_duration(seconds: int) -> str:
    """10200 -> '2h50m', 60 -> '1m' -- used in both the alert subject and the
    always-on log line."""
    total_min = round(seconds / 60)
    h, m = divmod(total_min, 60)
    return f"{h}h{m}m" if h else f"{m}m"


def render_gap_email(target_date: date, stats: ch.GapStats,
                     breakdown: dict[str, int]) -> tuple[str, str]:
    """(subject, html) for a daily poll-coverage gap alert. Subject carries
    the whole message; the "longest gap" clause is omitted for a
    scattered-loss day with no single gap >= 5 min (longest_gap_s < 300)."""
    missed = stats.expected - stats.present
    pct = (missed / stats.expected * 100.0) if stats.expected else 0.0
    subject = f"⚠️ Collector missed {missed} polls yesterday ({pct:.1f}%)"

    gap_line = ""
    if stats.longest_gap_s >= 300 and stats.longest_gap_start is not None:
        gap_start_local = stats.longest_gap_start.astimezone(LOCAL_TZ).strftime("%H:%M")
        subject += f" — longest gap {_fmt_duration(stats.longest_gap_s)} from {gap_start_local}"
        gap_line = (f'<p>Longest gap: {_fmt_duration(stats.longest_gap_s)}, '
                   f'starting {gap_start_local} Pacific.</p>')

    if breakdown:
        breakdown_line = ", ".join(
            f"{err}: {n}" for err, n in sorted(breakdown.items(), key=lambda kv: -kv[1]))
    else:
        breakdown_line = "no collector_poll data for this day (pre-#16 deploy?)"

    html = f'''<!DOCTYPE html>
<html><head><style>{CSS}</style></head>
<body>
<h2>Collector gap &mdash; {target_date.strftime("%A, %B %-d")}</h2>
<p>{stats.present} of {stats.expected} expected polls present ({stats.coverage:.1%} coverage).</p>
{gap_line}
<p>Breakdown: {breakdown_line}</p>
</body></html>'''
    return subject, html


def generate_gap_check(client: InfluxDBClient, target_date: date):
    """Runs daily for `target_date` (the previous local day). Sends nothing
    unless ch.gap_alert_needed() says the coverage or longest-gap threshold
    was crossed."""
    query_api = client.query_api()
    start, stop = local_day_utc_range(target_date)
    timestamps = query_poll_timestamps(query_api, flux_ts(start), flux_ts(stop))
    stats = ch.gap_stats(timestamps, start, stop)
    logger.info(f"{target_date}: coverage {stats.coverage:.1%}, "
               f"longest gap {_fmt_duration(stats.longest_gap_s)}")
    if not ch.gap_alert_needed(stats):
        return
    breakdown = query_poll_failures(query_api, flux_ts(start), flux_ts(stop))
    subject, html = render_gap_email(target_date, stats, breakdown)
    send_email(html, subject)


# ---------- daily heat-pump cooling alert ----------

@dataclass
class CoolStats:
    minutes: int
    runs: int
    kwh: float
    first_start: datetime | None


def _hvac_mode_flux(start: str, stop: str) -> str:
    return f'''
from(bucket: "{INFLUXDB_BUCKET}")
  |> range(start: {start}, stop: {stop})
  |> filter(fn: (r) => r._measurement == "hvac_mode")
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"])
'''


def query_hvac_mode_intervals(query_api, start: str, stop: str) -> list[dict]:
    """One dict per 5-min hvac_mode interval: start, mode, energy_kwh (the
    single nonzero energy_<mode>_kwh field). Same shape hvac_classifier and
    attribution.runs consume."""
    out = []
    for table in query_api.query(_hvac_mode_flux(start, stop), org=INFLUXDB_ORG):
        for rec in table.records:
            v = rec.values
            out.append({
                "start": rec.get_time(),
                "mode": v.get("mode"),
                "energy_kwh": sum(
                    v.get(k) or 0.0 for k in v if k.startswith("energy_") and k.endswith("_kwh")),
            })
    out.sort(key=lambda i: i["start"])
    return out


def cool_stats(intervals: list[dict]) -> CoolStats:
    """Pure: total cool minutes, number of contiguous cool runs (a timeline
    gap breaks a run, per attribution.runs), energy, and first run start."""
    cool_runs = attribution.runs(intervals, "cool")
    n_intervals = sum(len(r) for r in cool_runs)
    return CoolStats(
        minutes=n_intervals * attribution.INTERVAL_MINUTES,
        runs=len(cool_runs),
        kwh=sum(i.get("energy_kwh") or 0.0 for r in cool_runs for i in r),
        first_start=cool_runs[0][0]["start"] if cool_runs else None,
    )


def cool_alert_needed(stats: CoolStats) -> bool:
    return stats.minutes >= HVAC_COOL_ALERT_MIN_MINUTES


def render_cool_email(target_date: date, stats: CoolStats) -> tuple[str, str]:
    """(subject, html). Subject carries the whole message, like the gap alert."""
    runs_word = "run" if stats.runs == 1 else "runs"
    first_local = stats.first_start.astimezone(LOCAL_TZ).strftime("%H:%M") if stats.first_start else "?"
    subject = (f"❄️ Heat pump cooled {_fmt_duration(stats.minutes * 60)} yesterday "
               f"({stats.runs} {runs_word}, first {first_local})")
    html = f'''<!DOCTYPE html>
<html><head><style>{CSS}</style></head>
<body>
<h2>Heat pump cooling &mdash; {target_date.strftime("%A, %B %-d")}</h2>
<p>{_fmt_duration(stats.minutes * 60)} of <code>cool</code>-labeled intervals across
{stats.runs} {runs_word}, first starting {first_local} Pacific, {stats.kwh:.1f} kWh.</p>
<p>The classifier labels a non-hot-water heat-pump run <code>cool</code> whenever the outdoor
temperature is at or above {COOL_MIN_TEMP_F:.0f}&deg;F &mdash; it has no
thermostat signal. If the thermostats are on heat, the Stiebel ran cooling on its own comfort
setpoint. Set <code>HVAC_COOL_ALERT=0</code> in <code>pi/.env</code> for cooling season.</p>
</body></html>'''
    return subject, html


def generate_cool_check(client: InfluxDBClient, target_date: date):
    """Runs daily for `target_date` (the previous local day). Sends nothing
    unless HVAC_COOL_ALERT is on and cool time crossed the threshold."""
    query_api = client.query_api()
    start, stop = local_day_utc_range(target_date)
    intervals = query_hvac_mode_intervals(query_api, flux_ts(start), flux_ts(stop))
    stats = cool_stats(intervals)
    logger.info(f"{target_date}: cool {_fmt_duration(stats.minutes * 60)} in {stats.runs} runs "
               f"({len(intervals)} hvac_mode intervals)")
    if not cool_alert_needed(stats):
        return
    subject, html = render_cool_email(target_date, stats)
    send_email(html, subject)


def main():
    parser = argparse.ArgumentParser(description="Weekly energy report + daily anomaly check")
    parser.add_argument("--loop", action="store_true",
                       help="Run forever: anomaly check daily, weekly briefing Mondays, "
                            "both at REPORT_HOUR local")
    parser.add_argument("--date", type=str,
                       help="Send the weekly briefing for the week containing this date "
                            "(YYYY-MM-DD) — on-demand test send")
    parser.add_argument("--anomaly-date", type=str,
                       help="Run the anomaly check for this date (YYYY-MM-DD) — on-demand test")
    parser.add_argument("--gap-date", type=str,
                       help="Run the collector data-gap check for this date (YYYY-MM-DD) — "
                            "on-demand test")
    parser.add_argument("--cool-date", type=str,
                       help="Run the heat-pump cooling check for this date (YYYY-MM-DD) — "
                            "on-demand test (ignores HVAC_COOL_ALERT)")
    args = parser.parse_args()

    for var, name in [(INFLUXDB_TOKEN, "INFLUXDB_TOKEN"), (RESEND_API_KEY, "RESEND_API_KEY"),
                      (REPORT_EMAIL, "REPORT_EMAIL")]:
        if not var:
            logger.error(f"{name} not set")
            return

    client = InfluxDBClient(url=INFLUXDB_URL, token=INFLUXDB_TOKEN, org=INFLUXDB_ORG)

    if args.date:
        target = datetime.strptime(args.date, "%Y-%m-%d").date()
        logger.info(f"Generating weekly briefing for the week containing {args.date}")
        generate_weekly_report(client, local_week_start(target))
    elif args.anomaly_date:
        target = datetime.strptime(args.anomaly_date, "%Y-%m-%d").date()
        logger.info(f"Running anomaly check for {args.anomaly_date}")
        generate_anomaly_check(client, target)
    elif args.gap_date:
        target = datetime.strptime(args.gap_date, "%Y-%m-%d").date()
        logger.info(f"Running data-gap check for {args.gap_date}")
        generate_gap_check(client, target)
    elif args.cool_date:
        target = datetime.strptime(args.cool_date, "%Y-%m-%d").date()
        logger.info(f"Running cooling check for {args.cool_date}")
        generate_cool_check(client, target)
    elif args.loop:
        logger.info(f"Loop mode: anomaly check daily, weekly briefing Mondays, at {REPORT_HOUR}:00")
        while True:
            wait = seconds_until_hour(REPORT_HOUR)
            logger.info(f"Next run in {wait / 3600:.1f} hours")
            time.sleep(wait)
            yesterday = (datetime.now() - timedelta(days=1)).date()
            try:
                generate_anomaly_check(client, yesterday)
            except Exception as e:
                logger.error(f"Anomaly check failed: {e}")
            try:
                generate_gap_check(client, yesterday)
            except Exception as e:
                logger.error(f"Gap check failed: {e}")
            if HVAC_COOL_ALERT:
                try:
                    generate_cool_check(client, yesterday)
                except Exception as e:
                    logger.error(f"Cooling check failed: {e}")
            if datetime.now().weekday() == 0:   # Monday: yesterday closed last week
                try:
                    generate_weekly_report(client, local_week_start(yesterday))
                except Exception as e:
                    logger.error(f"Weekly report failed: {e}")
    else:
        generate_anomaly_check(client, datetime.now().date() - timedelta(days=1))

    client.close()


if __name__ == "__main__":
    main()
