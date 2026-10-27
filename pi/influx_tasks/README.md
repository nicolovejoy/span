# Operational measurements

## `collector_poll` — per-poll collector health (`span` bucket)

Written by `collector.py`, one point per 30s iteration, best-effort (a write
failure here never blocks the panel/circuit write). Same timestamp as that
iteration's data points.

| | |
|---|---|
| Tags | `host`; `result` ∈ `ok`, `panel_fail`, `circuits_fail`, `both_fail`, `write_fail`; `error` ∈ `none`, `timeout`, `connect`, `http_4xx`, `http_5xx`, `decode`, `other` |
| Field `panel_ms` | int — panel API call duration |
| Field `circuits_ms` | int — circuits API call duration |
| Field `points` | int — number of data points written this iteration |

Tags are a closed enum, never a raw error message — cardinality stays fixed
regardless of what the panel throws. Query `result != "ok"` grouped by
`error` for a failure breakdown; `collector_health.py` (pure, no I/O) owns
the gap/coverage math and error classification, with thresholds
`GAP_COVERAGE_MIN` (0.98) / `GAP_LONGEST_MIN_S` (1800s) overridable via env.
`daily_report.py`'s 07:00 data-gap email and `status.sh`'s coverage line both
read raw poll presence over `circuit` (not `panel`, and not this measurement
directly). **Known limitation:** a streak of `panel_fail` iterations with
circuits still succeeding shows as 100% coverage and raises no gap alert — it
is only visible in this measurement's `error` breakdown.

**Flux trap:** `distinct(column: "_time") |> count()` errors in real Influx
("count: unsupported aggregate column type time") rather than counting
distinct timestamps. The fix is `map(fn: (r) => ({_time: r._value, _value:
1})) |> sum()` — and note the map must restore `_time` explicitly
(`{r with _value: 1}` looks equivalent but silently returns zero rows for
this measurement/field, verified against real data). This bit the daily
anomaly check's `circuit_1h` coverage gate for a full day (crashing silently
every morning since PR #19) before being caught and fixed (#16).

## `telemetry` bucket — host + container metrics

Separate bucket, 30d retention, written by `telegraf` (`pi/telegraf.conf`, #16
Task 5) — host CPU/mem/disk/load/temp plus per-container CPU/mem via the
Docker input. Kept out of the infinite-retention `span` bucket since it's
operational data, not panel telemetry. Consumed by the `pi-health` Grafana
dashboard (`pi/grafana/provisioning/dashboards/pi-health.json`).

# Circuit rollups — `circuit_5m` / `circuit_1h`

Pre-aggregated downsamples of the raw `circuit` measurement, so the power
explorer can answer 90d/1y queries without scanning ~15M raw points (#9).

This file is the shared contract. `web/` and `pi/daily_report.py` both read
these measurements — read the [Timestamp convention](#timestamp-convention) and
[Tail freshness](#tail-freshness) sections before writing a consumer.

## Schema

Two measurements, in the **same `span` bucket** as the raw data.

| | |
|---|---|
| Measurements | `circuit_5m`, `circuit_1h` |
| Tags | `name`, `circuit_id` (carried verbatim from raw `circuit`) |
| Field `power_w_mean` | float — arithmetic mean of `abs(power_w)` over the bucket |
| Field `energy_wh` | float — `integral(unit: 1h)` of `abs(power_w)` over the bucket, in Wh |
| Field `energy_wh_counter` | float — increase in SPAN's own `consumed_energy_wh` meter across the bucket, in Wh |

`power_w_mean` and `energy_wh` derive only from raw `power_w`;
`energy_wh_counter` only from raw `consumed_energy_wh`.
`produced_energy_wh` and `relay_state` are deliberately not rolled up.
`abs()` is applied to `power_w` only — it matches what the app-side queries
already do (`web/lib/influx.ts`), since SPAN reports some circuits with inverted
sign. It is emphatically *not* applied to the cumulative meter.

`energy_wh` and `energy_wh_counter` were two independent estimates of the same
quantity, stored side by side so they could be A/B'd over real history before
either the site or the daily report committed to one. **#15 resolved this:**
`energy_wh_counter` is now authoritative — see [Which energy field to
read](#which-energy-field-to-read) below. Both fields stay stored: `energy_wh`
remains as a cross-check, not a discarded competitor. See
[Accuracy](#accuracy-vs-raw-integral) for how far apart they actually run
(~0.4–0.6% on clean data).

Raw `circuit` is never deleted (bucket retention is infinite), so **the rollups
are a pure speed optimisation and are fully rebuildable from scratch at any
time** — see [Backfill](#backfill). Nothing should ever exist only in a rollup.

Volume, at 21 circuits and 3 fields: `circuit_5m` is 18,144 pts/day (~7.5% of
raw `circuit`), `circuit_1h` is 1,512 pts/day (~0.6%).

### Which energy field to read

**`energy_wh_counter` is authoritative for energy** (decided #15, 2026-08-21).
`energy_wh` is the integral of our 30s `power_w` samples, and burst/impulse
loads — the EV charger above all, also disposal/dishwasher/speed-oven/fireplace
— draw real power in pulses shorter than the 30s poll, so many consecutive
samples read ~0 even while the load draws real energy. The integral
under-counts that energy; SPAN's own cumulative `consumedEnergyWh` meter
counts it correctly. Empirically this is a persistent ~0.7% average
under-count (stdev 1.7 points across 180 days of history), up to 11% on
individual EV-charging days — confirmed via per-circuit tracing that ruled
out counter resets as the cause. It is also immune to missed polls, since it
keeps ticking inside the panel whether or not the collector is listening — but
that turns out to be a secondary effect, not the dominant one: tested
correlation between poll coverage and the integral/counter gap is r=0.11
across 180 days, essentially none.

`energy_wh` is still stored and is useful as a cross-check. Do not delete it.

Two exceptions, both because the counter is too coarse at fine resolution
(three consecutive 30s samples have been observed reading an identical value):

- Windows ≤48h (`ENERGY_RAW_MAX_MS`) integrate raw `power_w` instead.
- Charts read `power_w` / `power_w_mean`, never either energy field.

The mechanism behind that observation: SPAN's own cumulative counter updates in
**~15-minute batches**, not on every poll. Between batches, consecutive 30s
samples read the exact same value, so a per-sample delta at fine resolution is
frequently a real zero even while power is actively flowing — the counter has
nothing new to report yet, not because usage stopped. That coarseness is why
short windows must integrate raw `power_w` instead of reading the counter.

Day-level bucketing of counter energy **must be Pacific-aligned, not UTC** —
this is the project's existing "UTC at rest, Pacific on display" convention
(see `CLAUDE.md`'s Shared Conventions section), applied to this field
specifically because getting it wrong is expensive here. UTC midnight is 17:00
Pacific — mid-EV-charging for this household — so bucketing the counter at UTC
day boundaries splits real charging sessions across the day line and
manufactures spurious day-over-day swings. Empirically confirmed: UTC-aligned
buckets show a ±8–11% day-level artifact that is pure boundary placement, not
usage; re-bucketing the same data Pacific-aligned collapses it down to a real
-0.5% to -0.6% signal.

**Never apply Flux `increase()` to the counter.** `nonNegative: true` treats
SPAN's small backward corrections — observed −5.59 Wh across all 21 circuits
simultaneously at a panel restart, twice in one sampled week — as a counter
wrap, and returns the current value: a 14.43 Wh hour becomes 113,114 Wh. The
rollup tasks use `difference(nonNegative: false)` → drop negatives → `sum()`.
Consumers read the already-corrected rollup field and need no reset handling,
but must not re-derive from the raw counter.

One more trap: `_rollup_stamp()` in `pi/daily_report.py` calibrates tail lag by
comparing rollup sums against the raw integral. It deliberately still reads
`energy_wh` — giving it the counter would show a constant integral-vs-counter
offset that it would misread as lag.

## Timestamp convention

**End-of-bucket.** A point stamped `T` covers the half-open interval
`[T - bucket, T)`.

This is Influx's `aggregateWindow` default (`timeSrc: "_stop"`), and it is what
the web consumer assumes: it shifts rollup query ranges forward one bucket and
`timeShift`s rows back onto start-of-coverage time.

Verified live — at `now() = 16:05:06Z` the newest `circuit_5m` point is stamped
`16:05:00Z` (covering `16:00–16:05`) and the newest `circuit_1h` point is
stamped `16:00:00Z` (covering `15:00–16:00`).

Consequences for consumers:

- `range(start: A, stop: B)` on a rollup selects buckets covering
  `[A - bucket, B - bucket)`. Shift your range forward by one bucket to select
  the buckets covering `[A, B)`.
- Re-aggregating a rollup with `aggregateWindow(every: X, fn: mean)` keeps the
  same convention (default `timeSrc: "_stop"`) and is correct, because a point
  stamped exactly on a window boundary belongs to the window it closes.
- This differs from raw `circuit` points, which are instantaneous samples with
  no interval semantics at all.

`backfill_rollups.py` produces **identical** stamps: it does not reimplement the
pipeline, it reads these same `.flux` files and substitutes only the time
bounds. Backfilled history and live task output cannot drift apart.

## Why the windows overlap

The energy branch does **not** use `aggregateWindow(fn: integral)`. Flux's
`integral()` only spans the first to the last point *inside* its window, so a
plain 5m window integrates 4m30s of a 5m bucket at a 30s sample cadence —
a systematic ~10% undercount. Measured over 6h of real data:

| pipeline | total Wh | vs raw `integral()` |
|---|---|---|
| raw whole-range `integral()` (baseline) | 6678.80 | — |
| `aggregateWindow(every: 5m, fn: integral)` | 5999.86 | **-10.2%** |
| `window(every: 5m, period: 5m30s)` + `integral()` | 6678.8017157852755 | **exact to 15 s.f.** |

So the windows overlap by exactly one sample interval, pulling in the first
point of the next bucket, which makes consecutive trapezoids tile the timeline
with no gaps.

The **counter branch uses the same overlapping window** for the same reason: its
per-sample deltas must span `sample(t) → sample(t + bucket)` so consecutive
buckets tile the counter exactly. Verified: over 7 days `circuit_1h`'s
`sum(energy_wh_counter)` reproduces a whole-range raw counter delta to the full
float — 187 670.74252319336 both ways.

**`bucketPeriod` must be `bucketEvery` + exactly one `POLL_INTERVAL` (30s).**
Larger overcounts (consecutive windows double-count a segment); smaller
reintroduces the truncation. If `POLL_INTERVAL` in `docker-compose.yml` ever
changes, update `bucketPeriod` and `tailSlack` in both `.flux` files and
`FLUX_BUCKET` in `backfill_rollups.py`, then re-backfill.

## Why the counter branch is not `increase()`

Flux's `increase()` is built for counters that **wrap to zero**: internally it is
`difference(nonNegative: true) |> cumulativeSum()`, and `nonNegative: true`
returns the *current value* whenever it sees a decrease.

SPAN does not wrap. It makes small backward corrections — observed 2026-07-30
13:54:56Z, `-5.59 Wh` on **every circuit simultaneously** (a panel restart),
twice in the 7 days sampled. Fed one of those, `increase()` reports the entire
counter reading as an increment:

| construction, 1h window containing the correction | result |
|---|---|
| `last() - first()` (true delta) | 14.43 Wh |
| `increase() \|> last()` | **113 114.64 Wh** — ~4000x overstatement |
| `difference(nonNegative: false)` → drop negatives → `sum()` | 25.60 Wh |

So the tasks sum **non-negative per-sample deltas**. It degrades gracefully: a
backward correction — or a genuine wrap, should SPAN ever do one — drops a
single step, bounding the error at one sample interval of energy rather than
injecting a whole counter reading.

The filter keeps zero deltas, and that matters: SPAN's meter is coarse — it
lands energy in batches, up to ~15 min apart on busy circuits — so most 30s
deltas are exactly `0`. Keeping the zeros is what makes a flat bucket emit a
real `0` instead of vanishing. Verified on 1-minute buckets over a flat
stretch: `0, 0, 14.71, 0, 0` — rows present throughout, no bucket dropped.

## Panel restarts that rebase the counter

Dropping negative steps was not enough. On 2026-10-26 17:00Z the panel
restarted (API down 17:00:36–17:04:42Z, firmware `spanos3/r202639/04`), every
circuit's `consumed_energy_wh` read **0** for ~20 min, and then came back at a
different, **lower** baseline (HP Control 3,114,501 → 0 → 2,921,700 Wh; the
charger 517,779 → 0 → 73,820). The step down was dropped, but the step from 0
up to the new baseline is positive and was summed: +2,921.8 kWh of "HVAC" in
one hour, which the anomaly email duly reported. Other owners see the same
after firmware updates (SpanPanel/span issues #87, #240). Full write-up:
`docs/superpowers/notes/2026-10-27-ev-accuracy-findings.md`.

Since 2026-10-27 a positive step is summed only if it is plausible:

- the previous reading is non-zero — a `0` is an uninitialised meter, so the
  step out of it is a baseline, not energy;
- the step is at most `maxStepBaseWh + maxStepRateW × elapsed`
  (10 kWh + 50 kW × hours between the two samples).

The base term exists because the meter batches: the largest single 30s step
in five months of history is ~3 kWh (the charger at 11.6 kW, one ~15 min
batch), so a bound on *implied power* alone would throw away every batch (a
3 kWh batch in a 30s sample looks like 355 kW). The rate term keeps the
counter's one real advantage over the integral: across a collector gap it still
carries the energy (27.5 kWh over a 24.8 h gap on 2026-05-10 passes).

Probe of the two rules against the old construction, 1h buckets, Wh:

| bucket | circuit | old | new | integral |
|---|---|---|---|---|
| 2026-10-26 18:00Z (restart) | HP / Control | 2,921,769 | 69 | 130 |
| 2026-10-26 18:00Z (restart) | Tesla Car Charger | 73,820 | 0.5 | 0.2 |
| 2026-10-26 18:00Z (restart) | Heat pump (HP) | 74,200 | 952 | 1,789 |
| 2026-10-02 06:00Z (batch straddles the hour) | Tesla Car Charger | 4,398 | 4,398 | 1,631 |
| 2026-10-06 23:00Z (normal charging) | Tesla Car Charger | 7,952 | 7,952 | 10,199 |
| 2026-05-10 19:00Z (24.8 h collector gap) | Heat pump (HP) | 570 | 570 | 409 |

Every non-restart hour is unchanged. In the restart hour the counter now
under-reads a little (HP 952 vs 1,789): the batch accumulated before the
restart was lost in the rebase itself and nothing can recover it. That is a
few hundred Wh house-wide, once.

After editing the rule: re-provision the tasks and backfill the affected range
(see below). The rollups are the only consumer of the raw counter, so nothing
else needs touching.

## Accuracy vs. raw `integral()`

Cross-checked against the query the web app runs today
(`queryEnergyByCategory` in `web/lib/influx.ts`), all 21 circuits. Raw
counter-delta is the same non-negative-delta sum, computed over the whole range
in one shot rather than per bucket.

**7 days, 2026-07-23 → 07-30** (clean data, no outage):

| quantity | Wh | vs raw `integral()` |
|---|---|---|
| raw `integral()` (baseline) | 186 515.62 | — |
| raw counter-delta (baseline) | 187 670.74 | +0.62% |
| `circuit_5m` `sum(energy_wh)` | 186 276.61 | **-0.128%** |
| `circuit_1h` `sum(energy_wh)` | 186 511.14 | **-0.002%** |
| `circuit_5m` `sum(energy_wh_counter)` | 187 600.93 | (-0.037% vs raw counter) |
| `circuit_1h` `sum(energy_wh_counter)` | 187 670.74 | (**exact** vs raw counter) |

**July 2026, 30 days:**

| quantity | Wh | vs raw `integral()` |
|---|---|---|
| raw `integral()` (baseline) | 742 180.12 | — |
| raw counter-delta (baseline) | 745 185.15 | +0.405% |
| `circuit_1h` `sum(energy_wh)` | 740 956.83 | **-0.165%** |
| `circuit_1h` `sum(energy_wh_counter)` | 745 025.89 | (-0.021% vs raw counter) |
| `circuit_1h` `sum(power_w_mean)` × 1h | 741 999.98 | -0.024% |

Per-day over July, `circuit_5m` `energy_wh` tracks raw `integral()` within
**±0.6% on 29 of 30 days** (the exception is the outage day below).

**The two energy estimates agree to within 0.4–0.6% over multi-day windows**,
with the counter consistently the *higher* of the two — the expected direction,
since the integral misses real energy from burst loads (like the EV charger)
that pulse faster than our 30s poll. Nothing here suggests either field is wrong.

The small negative bias of the rollups against their own raw baselines comes
from missed collector polls: when the gap to the next sample exceeds 30s, the
overlapping window does not reach the bucket edge and that one bucket truncates.
Self-limiting and sub-0.2%.

### Known divergence: collector outages

The three methods handle a data gap in three different ways, and this is the one
place they disagree materially:

- raw `integral()` **interpolates straight across the gap**, inventing energy;
- rollup `energy_wh` emits no bucket where there is no data (`createEmpty:
  false`), so it contributes zero for that interval;
- `energy_wh_counter` recovers whatever SPAN itself metered across the gap — but
  only partially, since buckets with fewer than two samples yield no delta at
  all, and it lands as a spike in the bucket where polling resumed rather than
  spread across the outage.

Worst case in the current history is **2026-07-30**, a ~2h50m collector outage
(12:50–17:05 UTC):

| | Wh for the day |
|---|---|
| raw `integral()` | 15 608.12 |
| raw counter-delta | 14 150.49 |
| `circuit_5m` `energy_wh` | 13 869.62 (**-11.1%** vs raw integral) |
| `circuit_5m` `energy_wh_counter` | 13 991.23 |

Every other day in July agrees to within ±0.6%. **No method is authoritative
here** — one invents data, one drops it, and SPAN's own meter went backwards
mid-outage. It is called out because **switching a consumer from raw to rollups
will visibly change historical totals on outage days**, and that must not be
mistaken for a bug.

As an internal consistency check on clean data, `sum(power_w_mean) ×
bucket_hours` agrees with `sum(energy_wh)` to within 0.16%.

## Tail freshness

Rollup tasks lag by construction: the bucket currently in progress does not
exist yet, and the task that closes it runs after an offset.

Let `X` be wall-clock now, `floor5m`/`floor1h` truncation to a bucket boundary.

| | schedule | newest available point | staleness |
|---|---|---|---|
| `circuit_5m` | `every: 5m, offset: 1m` | `floor5m(X - 1m)` | **1–6 min** |
| `circuit_1h` | `every: 1h, offset: 5m` | `floor1h(X - 5m)` | **5–65 min** |

The offsets exist so the task never races the 30s collector: the bucket closing
at `T` needs the sample at `T` to have landed before its trapezoid can reach the
right edge.

**What a consumer must do.** Rollup coverage ends at the horizon above — data
after it is simply absent, not zero, and a naive `sum()` will silently
under-report a window ending "now". Pick one:

1. **Clamp.** Only ask the rollup for `t <= X - 6m` (5m) / `t <= X - 65m` (1h),
   and label anything beyond as not-yet-available. Cheapest.
2. **Hybrid** (what the explorer wants for "last 24h" style views). Read the
   rollup up to the horizon and the raw `circuit` measurement for the remainder,
   then concatenate. The raw tail is small — at most 6 min / 65 min of 30s
   samples — so it stays fast.

Do not paper over the gap by extending the last rollup bucket forward; that
turns a 5-minute average into an hour of flat line on the 1h series.

**Invariant worth preserving:** each task's `offset` is strictly less than its
bucket width (1m < 5m, 5m < 1h). That is what makes the simple consumer rule
"trust the rollup up to `floor(now / bucket) * bucket - bucket`" — one full
bucket of slack, which is what `web/lib/rollup.ts`'s `rollupCutoffMs` uses —
provably safe without the consumer needing to know the schedule. Checked both
branches: when `now mod bucket >= offset` that rule is a full bucket
conservative, and when `now mod bucket < offset` it lands exactly on the
guaranteed horizon. Raising an offset to or beyond its bucket width would
silently break it.

## Self-healing, and when it is not enough

Each run re-emits the last 3 buckets (`circuit_5m`) / 2 buckets (`circuit_1h`),
not just the one that closed. Because Influx overwrites a point with an
identical (measurement, tag set, field key, timestamp) — and every stamp here is
derived from the bucket boundary, never from run time — re-emitting is free and
cannot double-count. That covers a single missed run or a slow collector write.

It does **not** cover a longer outage. If the stack, InfluxDB, or the collector
is down for more than ~15 min (5m) / ~2h (1h), or if the collector backfills old
data, run `backfill_rollups.py` over the affected range.

> Not verified: whether InfluxDB 2.7's scheduler replays runs missed while the
> container was down. Do not rely on it — backfill explicitly after any extended
> outage.

## Provisioning

Tasks are **not** created by `docker compose`; they live in the InfluxDB volume
and persist across restarts, so re-running provisioning on every `up` would be
pure noise. Doing it from a compose one-shot service would also mean either
mounting the Docker socket (privilege escalation for a once-ever operation) or
duplicating the CLI invocation path, and a permanently-`exited` service muddies
`docker compose ps` for a stack that is read at a glance. It is a deliberate
manual step:

```
cd ~/SPAN/pi && ./provision_influx_tasks.sh
```

Idempotent — creates what is missing, updates what exists in place (preserving
the task ID and its run history) and forces it back to `active`. `--dry-run`
reports what it would do. It needs no credentials: the `influxdb` container
carries an active `influx` CLI config. Re-run it after editing any `.flux` file.

Check on them with:

```
docker exec influxdb influx task list --org home
docker exec influxdb influx task log list --org home --task-id <id>
```

## Backfill

`../backfill_rollups.py` rebuilds either measurement over an arbitrary range,
defaulting to 2026-01-04 (start of data) → now. Aggregation runs server-side via
Flux `to()`; no sample data crosses the wire.

Always `--no-deps`: without it `docker compose run` also reconciles the
service's dependencies, and if the compose config has drifted from the running
`influxdb` container since it was started, compose **recreates InfluxDB**
(2026-10-27: a two-second restart mid-backfill, "Connection refused" on every
chunk). The backfill image copies `influx_tasks/` in, so rebuild it first after
editing a `.flux` file.

```
# after editing a .flux file
docker compose build daily-report

# see what would be written, write nothing
docker compose run --rm --no-deps daily-report python backfill_rollups.py --dry-run

# rebuild everything from the start of data
docker compose run --rm --no-deps daily-report python backfill_rollups.py

# repair one range after an outage
docker compose run --rm --no-deps daily-report python backfill_rollups.py --measurement circuit_5m --from 2026-07-30 --to 2026-07-31
```

Chunked so the Pi does not OOM: `circuit_5m` 1 day at a time, `circuit_1h` 7
days. Flux streams windows, so peak memory tracks the raw read rather than the
total range — a 7-day read is ~423k float points, versus ~13M for a naive
whole-history query. `circuit_5m` is chunked tighter only because it emits 12x
more points per unit time (18,144/day vs 1,512/day), making its write batches
the binding constraint.
Measured on the live Pi: ~2s per 1-day `circuit_5m` chunk, ~12s per 7-day
`circuit_1h` chunk, so a full 7-month rebuild is roughly 6 minutes each.
Override with `--chunk-days` if the Pi is busy.

Re-runnable and idempotent for the same reason the tasks are: identical
(measurement, tags, field, timestamp) overwrites in place. Chunk bounds are
snapped to bucket boundaries so no bucket ever straddles two chunks.
