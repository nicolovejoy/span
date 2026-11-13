#!/usr/bin/env python3
"""Pure collector-health math: poll-error classification and gap/coverage
stats. No Influx, no I/O -- collector_v2.py and daily_report.py own that and
call into this module. See docs/superpowers/sdd/2026-08-22-pi-observability/
task-1-brief.md (#16)."""

import json
import os
from dataclasses import dataclass
from datetime import datetime

import httpx

GAP_COVERAGE_MIN = float(os.getenv("GAP_COVERAGE_MIN", "0.98"))
GAP_LONGEST_MIN_S = int(os.getenv("GAP_LONGEST_MIN_S", "1800"))


def classify_error(exc: BaseException) -> str:
    """Bucket a poll exception into one of:
    timeout | connect | http_4xx | http_5xx | decode | other.

    httpx.ConnectTimeout is both a TimeoutException and a ConnectError
    subclass (both descend from TransportError), so TimeoutException must be
    checked first or a connect-timeout would misclassify as "connect"."""
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, httpx.ConnectError):
        return "connect"
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if 400 <= status < 500:
            return "http_4xx"
        if 500 <= status < 600:
            return "http_5xx"
        return "other"
    if isinstance(exc, (json.JSONDecodeError, ValueError)):
        return "decode"
    return "other"


def expected_polls(start_utc: datetime, stop_utc: datetime, interval_s: int = 30) -> int:
    return int((stop_utc - start_utc).total_seconds() / interval_s)


@dataclass
class GapStats:
    present: int
    expected: int
    coverage: float
    longest_gap_s: int
    longest_gap_start: datetime | None
    gaps_over_5m: int


def gap_stats(
    timestamps: list[datetime],
    start: datetime,
    stop: datetime,
    interval_s: int = 30,
) -> GapStats:
    """Coverage + gap analysis over [start, stop). A gap is a
    consecutive-timestamp delta exceeding 2*interval_s; the lead-in gap
    (start -> first timestamp) and tail gap (last timestamp -> stop) are
    also counted."""
    ts = sorted(timestamps)
    present = len(ts)
    expected = expected_polls(start, stop, interval_s)
    coverage = (present / expected) if expected > 0 else 0.0

    if present == 0:
        # No data anywhere in the window: the whole window is one gap.
        whole_window_s = (stop - start).total_seconds()
        return GapStats(
            present=0,
            expected=expected,
            coverage=0.0,
            longest_gap_s=int(whole_window_s),
            longest_gap_start=start,
            gaps_over_5m=1 if whole_window_s > 300 else 0,
        )

    boundaries = [start, *ts, stop]
    gap_threshold_s = 2 * interval_s

    longest_gap_s = 0.0
    longest_gap_start: datetime | None = None
    gaps_over_5m = 0

    for prev, cur in zip(boundaries, boundaries[1:]):
        delta_s = (cur - prev).total_seconds()
        # A normal poll cadence already accounts for one interval_s step;
        # the "gap" is the time missing beyond that expected step.
        candidate_gap_s = max(delta_s - interval_s, 0.0)
        if candidate_gap_s > longest_gap_s:
            longest_gap_s = candidate_gap_s
            longest_gap_start = prev
        if delta_s > gap_threshold_s and delta_s > 300:
            gaps_over_5m += 1

    return GapStats(
        present=present,
        expected=expected,
        coverage=coverage,
        longest_gap_s=int(longest_gap_s),
        longest_gap_start=longest_gap_start,
        gaps_over_5m=gaps_over_5m,
    )


def gap_alert_needed(
    stats: GapStats,
    coverage_threshold: float = GAP_COVERAGE_MIN,
    longest_gap_threshold_s: int = GAP_LONGEST_MIN_S,
) -> bool:
    return stats.coverage < coverage_threshold or stats.longest_gap_s >= longest_gap_threshold_s
