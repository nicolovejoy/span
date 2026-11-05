#!/usr/bin/env bash
# Side-by-side check of the v2 (MQTT) collector's shadow series against v1, per
# complete Pacific day (#26, plan docs/superpowers/plans/2026-10-28-collector-v2.md
# Task 5). Prints only the rows that MISS the pass bar, so empty sections = pass:
#   - energy per circuit over the whole window within max(1%, 50 Wh, 0.25 h x the
#     circuit's peak |power|). v1 lands energy in <=15-min batches, so its counter
#     trails v2 at each window edge by up to 15 min of load; a surge at a midnight
#     boundary shifted 337 Wh of heat pump energy across it on 2026-11-02 (the
#     per-day check at max(1%, 50 Wh) false-failed on exactly that). Judged over the
#     whole window the shift happens once, and the 0.25 h x peak allowance bounds it.
#   - daily mean power per circuit within max(2%, 10 W). Secondary: both collectors
#     sample every 30 s, so they see different phases of a cycling load (the speed
#     oven, 2026-11-02: -245 vs -422 W hourly mean while the energy counters agreed
#     to 0.1 Wh; SPAN reports every load as negative power_w, in v1 and v2 alike).
#     Energy is the hard gate; power is a smoke check.
#   - collector_poll_v2 result=ok count >= collector_poll's, per day
#
# Run ON the Pi:          bash compare_v2.sh 3
# or from the laptop:     ssh nico@phrpi.local 'bash -s' -- 3 < pi/tools/compare_v2.sh
set -euo pipefail
DAYS="${1:-3}"
cd ~/SPAN/pi

# </dev/null: under `ssh ... bash -s` the script itself is stdin, and exec -T would eat it.
q() { docker compose exec -T influxdb influx query --org home "$1" </dev/null; }

HEAD='
import "timezone"
import "date"
import "math"
option location = timezone.location(name: "America/Los_Angeles")
stop = date.truncate(t: now(), unit: 1d)
start = date.sub(d: '"${DAYS}"'d, from: stop)
'

per_circuit() {  # daily mean power: $1 field, $2 aggregate fn, $3 relative tolerance, $4 absolute tolerance
  q "$HEAD"'
from(bucket: "span")
  |> range(start: start, stop: stop)
  |> filter(fn: (r) => (r._measurement == "circuit" or r._measurement == "circuit_v2") and r._field == "'"$1"'")
  |> group(columns: ["_measurement", "circuit_id", "name"])
  |> aggregateWindow(every: 1d, fn: '"$2"', createEmpty: false)
  |> group(columns: ["circuit_id", "name"])
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  // A circuit-day present on only one side is a miss, not a silent pass.
  |> map(fn: (r) => ({ r with
        missing: if not exists r.circuit_v2 then "v2" else if not exists r.circuit then "v1" else "",
        diff: if exists r.circuit and exists r.circuit_v2 then r.circuit_v2 - r.circuit else 0.0,
        tol: if exists r.circuit and '"$3"' * math.abs(x: r.circuit) > '"$4"' then '"$3"' * math.abs(x: r.circuit) else '"$4"' }))
  |> filter(fn: (r) => r.missing != "" or math.abs(x: r.diff) > r.tol)
  |> keep(columns: ["_time", "name", "missing", "circuit", "circuit_v2", "diff", "tol"])
'
}

energy_total() {  # whole-window energy; tolerance max(1%, 50 Wh, 0.25 h x peak |power_w|)
  q "$HEAD"'
peak = from(bucket: "span")
  |> range(start: start, stop: stop)
  |> filter(fn: (r) => r._measurement == "circuit_v2" and r._field == "power_w")
  |> map(fn: (r) => ({ r with _value: math.abs(x: r._value) }))
  |> group(columns: ["circuit_id", "name"])
  |> max()
  |> keep(columns: ["circuit_id", "name", "_value"])
  |> rename(columns: {_value: "peak_w"})
energy = from(bucket: "span")
  |> range(start: start, stop: stop)
  |> filter(fn: (r) => (r._measurement == "circuit" or r._measurement == "circuit_v2") and r._field == "consumed_energy_wh")
  |> group(columns: ["_measurement", "circuit_id", "name"])
  |> spread()
  |> group(columns: ["circuit_id", "name"])
  |> pivot(rowKey: ["_start"], columnKey: ["_measurement"], valueColumn: "_value")
  |> map(fn: (r) => ({ r with
        missing: if not exists r.circuit_v2 then "v2" else if not exists r.circuit then "v1" else "" }))
join(tables: {e: energy, p: peak}, on: ["circuit_id", "name"])
  |> map(fn: (r) => ({ r with
        diff: if exists r.circuit and exists r.circuit_v2 then r.circuit_v2 - r.circuit else 0.0,
        tol: if exists r.circuit and 0.01 * math.abs(x: r.circuit) > 50.0 and 0.01 * math.abs(x: r.circuit) > 0.25 * r.peak_w then 0.01 * math.abs(x: r.circuit)
             else if 0.25 * r.peak_w > 50.0 then 0.25 * r.peak_w else 50.0 }))
  |> filter(fn: (r) => r.missing != "" or math.abs(x: r.diff) > r.tol)
  |> keep(columns: ["name", "missing", "circuit", "circuit_v2", "diff", "tol", "peak_w"])
'
}

echo "=== energy (Wh) misses over the last $DAYS complete Pacific days: v1 circuit vs circuit_v2 ==="
energy_total

echo
echo "=== daily mean power (W) misses (smoke check) ==="
per_circuit power_w mean 0.02 10.0

echo
echo "=== days where v2 has fewer ok polls than v1 ==="
q "$HEAD"'
from(bucket: "span")
  |> range(start: start, stop: stop)
  |> filter(fn: (r) => (r._measurement == "collector_poll" or r._measurement == "collector_poll_v2")
        and r._field == "points" and r.result == "ok")
  |> group(columns: ["_measurement"])
  |> aggregateWindow(every: 1d, fn: count, createEmpty: true)
  |> group()
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> map(fn: (r) => ({ r with collector_poll_v2: if exists r.collector_poll_v2 then r.collector_poll_v2 else 0 }))
  |> filter(fn: (r) => r.collector_poll_v2 < r.collector_poll)
'

echo
echo "=== coverage (row counts compared above; zero means no shadow data yet) ==="
q "$HEAD"'
from(bucket: "span")
  |> range(start: start, stop: stop)
  |> filter(fn: (r) => r._measurement == "circuit_v2" and r._field == "consumed_energy_wh")
  |> group()
  |> count()
'
