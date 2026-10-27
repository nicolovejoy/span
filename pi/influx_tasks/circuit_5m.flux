// circuit_5m — 5-minute rollup of the raw `circuit` measurement.
//
// Writes three float fields per (circuit_id, name) per 5m bucket:
//   power_w_mean      — arithmetic mean of abs(power_w) over the bucket
//   energy_wh         — trapezoidal integral(unit: 1h) of abs(power_w), in Wh
//   energy_wh_counter — increase of SPAN's own consumed_energy_wh meter
//
// energy_wh and energy_wh_counter were two independent estimates of the same
// quantity, stored side by side to be A/B'd over real history. #15 resolved
// this: energy_wh_counter is now authoritative, energy_wh kept as a cross-check.
// Do not drop either.
//
// TIMESTAMP CONVENTION: end-of-bucket (`aggregateWindow`'s default
// timeSrc: "_stop"). A point at time T covers the half-open interval
// [T - 5m, T). See influx_tasks/README.md — this is the shared contract.
//
// Raw `circuit` is never deleted (bucket retention is infinite), so this
// measurement is a pure speed optimisation and can be rebuilt from scratch at
// any time with backfill_rollups.py.
//
// IDEMPOTENCE: Influx overwrites a point with identical
// (measurement, tag set, field key, timestamp). Every emitted point is keyed by
// (circuit_5m, circuit_id+name, field, bucket-end) — all derived deterministically
// from the bucket boundary, never from wall-clock or run time. Re-running any
// window therefore overwrites in place and cannot double-count. That is why the
// task deliberately re-emits the last 3 buckets on every run: it self-heals a
// missed run or late-arriving collector points at zero cost.
//
// The body below is shared verbatim with backfill_rollups.py, which strips the
// task header and substitutes its own chunk bounds. Keep the marker comments.

// --- BEGIN TASK HEADER ---
import "date"

option task = {name: "circuit_5m", every: 5m, offset: 1m}

srcBucket = "span"
srcMeasurement = "circuit"
dstBucket = "span"
dstOrg = "home"
dstMeasurement = "circuit_5m"

// Bucket width, and the width of the *overlapping* read window used by both the
// integral and the counter branch. bucketPeriod MUST be bucketEvery + exactly
// one collector sample interval (POLL_INTERVAL=30s).
// See README "Why the windows overlap".
bucketEvery = 5m
bucketPeriod = 5m30s
tailSlack = 30s

// Emit the 3 most recently *completed* buckets. Re-emitting the older two is
// free (idempotent) and heals a skipped run or a slow collector write.
// Bucket-end stamps are emitted in the half-open interval (emitFrom, emitTo].
emitTo = date.truncate(t: now(), unit: bucketEvery)
emitFrom = date.sub(d: 15m, from: emitTo)

// Read one extra bucket earlier than the first emitted bucket: window() clips
// windows at the range edge, producing a bogus partial window whose _start
// collides with the first real one. That partial maps to a bucket-end stamp of
// exactly emitFrom, which the `_time > emitFrom` filter discards.
// Read tailSlack past emitTo so the final bucket's trapezoid reaches its right edge.
readFrom = date.sub(d: bucketEvery, from: emitFrom)
readTo = date.add(d: tailSlack, to: emitTo)
// --- END TASK HEADER ---

src =
    from(bucket: srcBucket)
        |> range(start: readFrom, stop: readTo)
        |> filter(fn: (r) => r._measurement == srcMeasurement and r._field == "power_w")
        // Defensive: a single null sample poisons integral() for the whole bucket.
        |> filter(fn: (r) => exists r._value)
        // Match the abs() the existing app-side queries apply (web/lib/influx.ts):
        // SPAN reports some circuits with inverted sign.
        |> map(fn: (r) => ({r with _value: if r._value < 0.0 then -r._value else r._value}))

// Mean branch. Plain non-overlapping windows; aggregateWindow's default
// timeSrc: "_stop" already gives the end-of-bucket stamp we want.
means =
    src
        |> aggregateWindow(every: bucketEvery, fn: mean, createEmpty: false)
        |> filter(fn: (r) => r._time > emitFrom and r._time <= emitTo)
        // set() (not map()) because _field is a group-key column.
        |> set(key: "_field", value: "power_w_mean")

// Energy branch. NOT aggregateWindow(fn: integral): integral() only spans the
// first to the last point *inside* its window, so a plain 5m window integrates
// 4m30s of a 5m bucket and undercounts by ~10% (measured: -10.2%). Overlapping
// windows (period = bucketEvery + one sample interval) pull in the first point
// of the next bucket, so consecutive trapezoids tile the timeline exactly.
// Measured against a raw whole-range integral() this reproduces it to 15
// significant figures under nominal cadence.
energy =
    src
        |> window(every: bucketEvery, period: bucketPeriod)
        |> integral(unit: 1h)
        // The overlapping window's own _stop is _start + bucketPeriod, i.e. one
        // sample interval PAST the bucket end — so derive the stamp from _start
        // instead of duplicating _stop. This is what keeps the two branches on
        // the same end-of-bucket convention.
        |> map(fn: (r) => ({r with _time: date.add(d: bucketEvery, to: r._start)}))
        |> filter(fn: (r) => r._time > emitFrom and r._time <= emitTo)
        // Guard seen in web/lib/influx.ts: sparse data has produced negative
        // integrals despite the abs() above.
        |> filter(fn: (r) => r._value >= 0.0)
        // Collapse the per-window group key back to a single stream before union.
        |> window(every: inf)
        |> set(key: "_field", value: "energy_wh")

// Counter branch — the increase in SPAN's own cumulative consumed_energy_wh
// meter across the bucket. Independent of our 30s resampling, so a collector
// outage does not under-report it the way integral() does.
//
// NOT increase(). Flux's increase() is built for counters that wrap to zero:
// difference(nonNegative: true) returns the CURRENT value when it sees a
// decrease. SPAN does not wrap — it makes small backward corrections (observed
// 2026-07-30 13:54Z, -5.59 Wh on every circuit at once, during a panel
// restart). Fed one of those, increase() reported 113,114.64 Wh for an hour
// whose true delta was 14.43 Wh — a ~4000x overstatement that would poison the
// rollup. Summing non-negative per-sample deltas instead degrades gracefully:
// a backward correction (or a genuine wrap) drops a single step, bounding the
// error at one sample interval of energy instead of a whole counter reading.
//
// The >= 0.0 (not > 0.0) filter matters: SPAN's counter is coarse — it lands
// energy in batches, up to ~15 min apart on busy circuits — so most 30s deltas
// are exactly 0. Keeping them is what makes a flat bucket emit a real 0 rather
// than vanishing.
//
// Dropping negatives is not enough (2026-10-26 17:00Z, a panel restart): every
// circuit read 0 for ~20 min, then came back at a different, LOWER baseline.
// The step down to 0 was dropped, but the step from 0 up to the new baseline
// (+73,820 Wh on the charger, +2,921,700 Wh on HP Control) was summed as
// energy. So a positive step also has to be plausible:
//   - the previous reading must be non-zero (a 0 is an uninitialised meter);
//   - the step must fit maxStepBaseWh + maxStepRateW x elapsed. The base term
//     covers one batched update (largest seen in 5 months: ~3 kWh, the charger
//     at 11.6 kW x ~15 min); the rate term keeps the counter's advantage over
//     the integral across a collector gap (27.5 kWh over a 24.8 h gap on
//     2026-05-10 must survive). A bound on implied power alone does NOT work:
//     a 3 kWh batch in a 30 s sample looks like 355 kW.
// README "Panel restarts that rebase the counter" has the probe numbers.
// These constants live in the body, not the header, because
// backfill_rollups.py replaces the header with its own.
maxStepBaseWh = 10000.0
maxStepRateW = 50000.0
nsPerHour = 3600000000000.0
//
// Same overlapping window as the energy branch, for the same reason: the diffs
// must span sample(t) -> sample(t + bucketEvery) so consecutive buckets tile
// the counter exactly, with no double-counting and no dropped step.
counter =
    from(bucket: srcBucket)
        |> range(start: readFrom, stop: readTo)
        |> filter(fn: (r) => r._measurement == srcMeasurement and r._field == "consumed_energy_wh")
        |> filter(fn: (r) => exists r._value)
        // No abs() here — this is a cumulative meter, not a signed power reading.
        |> window(every: bucketEvery, period: bucketPeriod)
        // Carry the current reading and the sample time alongside the delta,
        // so the filter can see the previous reading (cur - delta) and elapsed.
        |> map(fn: (r) => ({r with cur: r._value, ts: int(v: r._time)}))
        |> difference(nonNegative: false, keepFirst: false, columns: ["_value", "ts"])
        |> filter(fn: (r) => r._value == 0.0 or (r._value > 0.0 and r.cur - r._value > 0.0 and r._value <= maxStepBaseWh + maxStepRateW * float(v: r.ts) / nsPerHour))
        |> sum(column: "_value")
        // sum() drops _time, so derive the end-of-bucket stamp from _start.
        |> map(fn: (r) => ({r with _time: date.add(d: bucketEvery, to: r._start)}))
        |> filter(fn: (r) => r._time > emitFrom and r._time <= emitTo)
        |> window(every: inf)
        |> set(key: "_field", value: "energy_wh_counter")

union(tables: [means, energy, counter])
    |> set(key: "_measurement", value: dstMeasurement)
    |> keep(columns: ["_time", "_value", "_field", "_measurement", "circuit_id", "name"])
    |> to(bucket: dstBucket, org: dstOrg, tagColumns: ["circuit_id", "name"])
