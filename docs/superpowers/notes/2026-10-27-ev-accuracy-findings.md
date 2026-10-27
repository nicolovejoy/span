# EV accuracy findings (trends view Part 1, Task 1)

Date: 2026-10-27. Scope: the three disagreeing EV sources named in
`docs/superpowers/specs/2026-10-26-trends-view-design.md` § Part 1, plus the
2026-10-26 anomaly email ("HVAC 3052.9 kWh vs a normal 7.3 kWh"), which turned
out to be the same bug. No code changed; this note is the evidence and the
proposed fix for Task 2.

## Summary

1. **The October counter/integral split is one hour, not a trend.** The SPAN panel
   restarted at 17:00Z on 2026-10-26 (10:00 Pacific). During the restart every
   circuit's cumulative `consumed_energy_wh` read **0** for ~20 minutes, then came
   back at a **different, lower baseline**. The rollup's counter branch drops the
   negative step down to zero but then sums the positive step from zero up to the
   new baseline as if it were energy. That single hour (`circuit_1h` bucket stamped
   `2026-10-26T18:00:00Z`) carries +73.8 kWh on the charger and +2,921.8 kWh on
   "Heat pump (HP) / Control". It is the entire October discrepancy (127 − 53 ≈ 74)
   and the entire anomaly email.
2. **Before that hour, counter and integral agree on every day since September**
   (and on every charging day, within 0.5%). The spec's hypothesis that the 30s
   integral misses charger pulses is **not supported** for this charger.
3. **`charge_event` under-covers because the detector freezes sessions at first
   sight.** It scans a 3h lookback every 10 min, writes a session the first time it
   is ≥30 min long, then skips every later, longer version of it ("already
   recorded"). Nearly every stored session is 30–40 min / 6–7 kWh regardless of the
   real session length.
4. **Unmonitored is not affected.** Panel counter vs `integral(grid_power_w)` agree
   within 0.1% in Jun/Aug/Sep and 1.4% in Jul. No reason to move the panel side to
   the counter.

## Evidence

### Daily charger kWh, counter vs integral (Pacific days, `circuit_1h`)

Only days with meaningful charging shown; every other day is ~0.02 kWh on both.

| Day | counter | integral |
|---|---|---|
| Sep 5 | 30.08 | 30.01 |
| Sep 7 | 9.96 | 10.01 |
| Sep 8 | 17.17 | 17.12 |
| Sep 10 | 22.14 | 22.12 |
| Sep 14 | 22.47 | 22.42 |
| Sep 16 | 21.55 | 21.53 |
| Sep 19 | 15.16 | 15.22 |
| Sep 21 | 24.04 | 24.08 |
| Sep 24 | 20.32 | 20.24 |
| Sep 28 | 24.98 | 25.01 |
| Oct 1 | 19.92 | 19.92 |
| Oct 6 | 32.68 | 32.58 |
| Oct 7–25 | ~0.02/day | ~0.004/day (no charging at all) |
| **Oct 26** | **89.65** | **17.48** |
| Oct 27 (to 14:30) | 10.81 | 9.09 |

Oct 26 counter minus the 73.82 kWh jump = 15.83; Oct 26+27 together: counter 26.64
vs integral 26.57 (0.3%). The per-day split differs by ~1.7 kWh because a session
straddled Pacific midnight and the meter only advances every ~3 min.

### The restart, raw 30s data (5-min `last` of `circuit.consumed_energy_wh`, Wh)

| Time (Z) | HP / Control | Tesla Car Charger | Kitchen / Refrigerator |
|---|---|---|---|
| 16:55 | 3,114,501 | 517,779 | 109,727 |
| 17:00–17:15 | **0** | **0** | **0** |
| 17:20 | 2,921,700 | 73,820 | 56,552 |
| 17:25 → | advancing normally | advancing normally | advancing normally |

Panel-level `consumed_energy_wh` went 6,513,738 → 4,030,291 at 17:00Z and
`grid_power_w` read 0 at that sample. Collector log: last good poll 17:00:06Z,
`Connection refused` / `No route to host` from 17:00:36Z, first good poll
17:04:42Z. Nothing changed on the Pi. The panel reports firmware
`spanos3/r202639/04`; the restart may have been a firmware update (not provable
from our data). Counters have been continuous since (checked 23:00Z–01:00Z too).

The new baselines are not a uniform offset (HP control −193 kWh, charger
−444 kWh, fridge −53 kWh, panel −2,483 kWh), so the panel did not simply rewind
to a snapshot; it is a rebase of unknown origin. Nothing in our stack reads the
absolute counter value, only deltas, so the rebase itself is harmless. The
zero-then-jump is the problem.

### Why the rollup counted it

`pi/influx_tasks/circuit_1h.flux` (and `circuit_5m.flux`, same body) counter branch:

```
|> difference(nonNegative: false, keepFirst: false)
|> filter(fn: (r) => r._value >= 0.0)
|> sum()
```

Designed (README § "Why the counter branch is not increase()") for the 2026-07-30
case: a small backward correction, where dropping the one negative step bounds
the error at one sample. A reading of 0 followed by a return to a large value is
a different shape: the negative step is dropped, but the next step (0 → 73,820)
is positive and is summed. The branch has no plausibility bound on a single
step.

Hourly scan of all history (`energy_wh_counter > 2 × energy_wh + 1 kWh`): the only
multi-circuit event is 2026-10-26T18:00Z (20 circuits). The other hits are
single-circuit, 1–4 kWh, all consistent with the counter catching energy during
a collector gap (what the counter is for), e.g. charger 2026-10-02T06:00Z
counter 4.40 vs integral 1.63 kWh.

### Consumers of the bad hour

Everything that sums `circuit_1h.energy_wh_counter`:
- explorer breakdown table and `/api/energy` (`cachedQueryEnergyByCategory`)
- weekly email, 12-month trend, and the daily anomaly check
  (`daily_report.py` `query_daily_circuit_counter_kwh` and friends)
- `/trends` once built

The anomaly check's baseline is a median/MAD over 8 trailing same-weekdays
(`report_baseline.py`), so Oct 26 would skew future Mondays only mildly, and not
at all once the hour is repaired.

### `charge_event` coverage, Sep 1 → Oct 27

| Event start (Z) | min | kWh | Circuit that day (integral) |
|---|---|---|---|
| Sep 5 18:10 / 20:16 / 22:26 | 35 / 180 / 53 | 5.5 / 16.1 / 4.8 | 30.0 |
| Sep 8 05:50 / 07:56 | 35 / 133 | 6.7 / 12.0 | 27.1 (Sep 7+8) |
| Sep 11 03:47 | 38 | 7.4 | 22.1 |
| Sep 14 19:35 | 31 | 5.9 | 22.4 |
| Sep 16 21:03 | 33 | 6.2 | 21.5 |
| Sep 19 22:07 | 39 | 7.5 | 15.2 |
| Sep 22 04:25 | 31 | 5.9 | 24.1 |
| Sep 25 04:56 | 31 | 5.9 | 20.3 |
| Sep 29 04:37 | 40 | 7.7 | 25.0 |
| Oct 2 03:25 | 31 | 6.0 | 19.9 |
| Oct 6 20:09 / 22:17 | 37 / 109 | 7.2 / 21.0 | 32.6 |
| Oct 27 05:30 | 38 | 7.3 | 26.6 (Oct 26+27) |

Mean power ≈ 11 kW, so a 30–40 min event is ~6–7 kWh and a real 22 kWh session is
~2 h. `charge_detector.py`: `LOOKBACK_MINUTES = 180`, loop every 600 s,
`MIN_DURATION_MIN = 30`, `event_already_exists` dedupes on any event within ±2 h
of the start and then **skips**. So the first loop iteration after a session
passes 30 min writes it with its length so far, and nothing ever updates it. The
few long events (180, 133, 109 min) are sessions whose start had already
scrolled to the lookback edge, which also clips the start time.

Also, `status.sh`'s "no charge_event in 14 days" was true and correct: there was
no charging at all Oct 7–25.

### Unmonitored check (panel counter vs grid integral, kWh)

| Month | panel counter | integral(grid_power_w) |
|---|---|---|
| Jun | 914.4 | 914.9 |
| Jul | 894.5 | 881.9 |
| Aug | 924.0 | 923.3 |
| Sep | 906.3 | 906.6 |

July's 1.4% is the 2026-07-30 panel restart (a collector gap the integral misses).
Leave `queryPanelKwh` on the integral.

## Ground truth

There is no Tesla app to compare with (the car is an Ioniq 5 with no app; the
circuit label is SPAN's). Counter and integral are two independent measurements
that agree within 0.5% on every charging day, which is the strongest internal
check available. If the wall unit is a Tesla Wall Connector Gen 3 on Wi-Fi, its
local endpoint `http://<connector-ip>/api/1/lifetime` reports a lifetime
`energy_wh` and `/api/1/vitals` a `session_energy_wh`; that would be an external
check with no app involved. Otherwise the car's own charging summary on the
dashboard for one session is enough to validate the ~11 kW rate.

## Proposed fix (Task 2)

**A. Rollup: bound each counter step by physics.** In both `circuit_5m.flux` and
`circuit_1h.flux` (the body is shared with `backfill_rollups.py`), add `elapsed`
between samples and drop any step that implies more than 50 kW on one circuit
(the whole panel is a 200 A / 48 kW service): keep
`0 ≤ Δ ≤ 50,000 × elapsed_s / 3600`. A 30 s step may carry at most ~417 Wh; a
1 h collector gap may still carry 50 kWh, so the counter keeps its advantage over
the integral during outages. The 0 → 73,820 Wh step at 17:20Z fails the bound and
is dropped; every legitimate step in the history passes (max plausible per 30 s
is the charger at ~11 kW ≈ 92 Wh).
Then: re-provision both tasks on the Pi (README § Provisioning) and
`backfill_rollups.py --from 2026-10-26T07:00Z --to 2026-10-27T07:00Z` for both
measurements. Verify: the 18:00Z hour's counter ≈ its integral for every circuit,
Oct 26 charger ≈ 16 kWh, and the explorer's October Car total drops from ~127 to
~53 kWh. Optionally re-send the Oct 26 anomaly email.
Test: a unit test in `pi/` on the counter-branch rule using the observed series
(517,779 → 0 → 0 → 73,820 → 73,820.03) expecting ~0.2 Wh, plus a 1 h gap case
expecting the full delta.

**B. `charge_detector`: write a session only when it has ended, and overwrite
rather than skip.** (1) Treat a run as closed only when at least one sample
below threshold follows it inside the window; a run still above threshold at the
window's end is in progress and is not written. (2) Extend `LOOKBACK_MINUTES`
to cover the longest real session (12 h; a full Ioniq 5 charge at 11 kW is ~7 h)
so the start is never clipped. (3) Replace the ±2 h skip with an overwrite: a
re-detected session has the same start timestamp, and Influx overwrites a point
with identical measurement + tags + time. Then delete the truncated events
(`influx delete` on `_measurement="charge_event"` since 2026-05-01) and rebuild
with `charge_detector.py --backtest --days 180 --write`.
Test: a session longer than the old 3 h window, sampled at 30 s, produces one
event with the full duration; an in-progress run at the window edge produces
none.

**C. Not changing:** Unmonitored / `queryPanelKwh`; the Car layer definition
(energy through the charger circuit).

**Follow-up, out of scope here:** a health point when an hourly counter delta
exceeds its integral by more than a few kWh on several circuits at once, so the
next panel restart pages instead of emailing a 3,000 kWh Monday.

## Fix applied (2026-10-27, same day)

**A changed shape before shipping.** The first probe of "50 kW × elapsed" threw
away legitimate energy: SPAN's meter lands energy in batches up to ~15 min
apart, so a single 30 s sample can carry a 2,963 Wh lump on the charger (355 kW
if read as power) or 470 Wh on the heat pump. The shipped rule
(`pi/influx_tasks/*.flux`, commit 686ee01) is: previous reading non-zero, and
step ≤ 10 kWh + 50 kW × elapsed. Probe over the restart hour, a batch hour, a
normal charging hour and the 24.8 h collector gap of 2026-05-10: identical to the
old numbers everywhere except the restart hour, where every jump is gone
(table in `pi/influx_tasks/README.md` § "Panel restarts that rebase the
counter"). Tasks re-provisioned on the Pi, Oct 26–27 rollups rebuilt.

**B shipped as proposed** (commit dd333c6): closed sessions only, 12 h lookback,
exact-start dedupe, chunked streaming backfill. 65 truncated events deleted,
86 rebuilt from raw.

Before / after, charger circuit and sessions, kWh:

| | before | after |
|---|---|---|
| Oct 2026 circuit counter (to the 27th) | 127.0 | 79.8 |
| HVAC on Mon Oct 26 (anomaly email) | 3,052.9 | normal |
| Sep sessions / Sep circuit | 92 / 208 (44%) | 206.9 / 208.3 (99%) |
| Jun sessions / Jun circuit | 193 / 364 | 361.7 / 364 |
| Sessions, Jan–Oct | 65 events, mostly 30–40 min | 86 events, 30–356 min |

**Not changed:** Unmonitored / `queryPanelKwh`; the Car layer definition.

**Deploy lessons:** `influx task update` in the shipped CLI takes neither
`--org` nor `-` for stdin (`provision_influx_tasks.sh` fixed, two commits);
`docker compose run` without `--no-deps` recreated the `influxdb` container
mid-backfill (README recipe fixed). No data lost either time.

**Ground truth still open:** no external meter was compared. Counter and
integral agreeing within 0.5% on every charging day is the evidence; a Tesla
Wall Connector Gen 3 local endpoint, if that's the hardware, would close it.
