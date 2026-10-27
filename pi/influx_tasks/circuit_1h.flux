// circuit_1h — 1-hour rollup of the raw `circuit` measurement.
//
// Identical pipeline to circuit_5m.flux (same three fields: power_w_mean,
// energy_wh, energy_wh_counter), only the bucket width and schedule differ.
// See that file (and influx_tasks/README.md) for the full rationale; comments
// here are kept to the differences.
//
// TIMESTAMP CONVENTION: end-of-bucket. A point at time T covers [T - 1h, T).
//
// This is derived from raw `circuit`, NOT from circuit_5m — chaining rollups
// would compound the small per-bucket edge error and would make circuit_1h
// silently wrong whenever circuit_5m is incomplete. Both read raw independently.

// --- BEGIN TASK HEADER ---
import "date"

option task = {name: "circuit_1h", every: 1h, offset: 5m}

srcBucket = "span"
srcMeasurement = "circuit"
dstBucket = "span"
dstOrg = "home"
dstMeasurement = "circuit_1h"

// bucketPeriod = bucketEvery + one collector sample interval (POLL_INTERVAL=30s).
bucketEvery = 1h
bucketPeriod = 1h30s
tailSlack = 30s

// Emit the 2 most recently completed hours; re-emitting the older one is
// idempotent and heals a missed run.
emitTo = date.truncate(t: now(), unit: bucketEvery)
emitFrom = date.sub(d: 2h, from: emitTo)

readFrom = date.sub(d: bucketEvery, from: emitFrom)
readTo = date.add(d: tailSlack, to: emitTo)
// --- END TASK HEADER ---

src =
    from(bucket: srcBucket)
        |> range(start: readFrom, stop: readTo)
        |> filter(fn: (r) => r._measurement == srcMeasurement and r._field == "power_w")
        |> filter(fn: (r) => exists r._value)
        |> map(fn: (r) => ({r with _value: if r._value < 0.0 then -r._value else r._value}))

means =
    src
        |> aggregateWindow(every: bucketEvery, fn: mean, createEmpty: false)
        |> filter(fn: (r) => r._time > emitFrom and r._time <= emitTo)
        |> set(key: "_field", value: "power_w_mean")

energy =
    src
        |> window(every: bucketEvery, period: bucketPeriod)
        |> integral(unit: 1h)
        |> map(fn: (r) => ({r with _time: date.add(d: bucketEvery, to: r._start)}))
        |> filter(fn: (r) => r._time > emitFrom and r._time <= emitTo)
        |> filter(fn: (r) => r._value >= 0.0)
        |> window(every: inf)
        |> set(key: "_field", value: "energy_wh")

// SPAN's own cumulative meter. See circuit_5m.flux for why this is a sum of
// plausible non-negative per-sample deltas and emphatically NOT increase(),
// and for what the step bounds guard against (2026-10-26 panel restart).
maxStepBaseWh = 10000.0
maxStepRateW = 50000.0
nsPerHour = 3600000000000.0
counter =
    from(bucket: srcBucket)
        |> range(start: readFrom, stop: readTo)
        |> filter(fn: (r) => r._measurement == srcMeasurement and r._field == "consumed_energy_wh")
        |> filter(fn: (r) => exists r._value)
        |> window(every: bucketEvery, period: bucketPeriod)
        |> map(fn: (r) => ({r with cur: r._value, ts: int(v: r._time)}))
        |> difference(nonNegative: false, keepFirst: false, columns: ["_value", "ts"])
        |> filter(fn: (r) => r._value == 0.0 or (r._value > 0.0 and r.cur - r._value > 0.0 and r._value <= maxStepBaseWh + maxStepRateW * float(v: r.ts) / nsPerHour))
        |> sum(column: "_value")
        |> map(fn: (r) => ({r with _time: date.add(d: bucketEvery, to: r._start)}))
        |> filter(fn: (r) => r._time > emitFrom and r._time <= emitTo)
        |> window(every: inf)
        |> set(key: "_field", value: "energy_wh_counter")

union(tables: [means, energy, counter])
    |> set(key: "_measurement", value: dstMeasurement)
    |> keep(columns: ["_time", "_value", "_field", "_measurement", "circuit_id", "name"])
    |> to(bucket: dstBucket, org: dstOrg, tagColumns: ["circuit_id", "name"])
