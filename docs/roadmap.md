# SPAN roadmap — phased

Written 2026-07-31. Companion to CLAUDE.md's *Next Steps* (which tracks near-term
mechanics) and the GitHub issues (which track individual units of work). This file
exists to answer a different question: **what order, and why.**

Each phase is scoped to be handed to a subagent with the phase's own section as
the brief. Phases are ordered by dependency, not by appeal.

---

## Where things stand

**Deadline that outranks every phase below (added 2026-10-27): #26.** SPAN removes the v1
REST API on 2026-12-31; the collector, `span_client.py` and `hvac_probe.py` all speak v1.
Migrate to v2 auth + the panel's local MQTT broker before then, writing the same `panel` /
`circuit` measurements so nothing downstream changes. Plan and findings in the issue. The
`/trends` page (Part 2 of `docs/superpowers/plans/2026-10-26-trends-view.md`) waits behind it.

**Done and deployed (2026-10-27)**

- EV accuracy (trends plan Part 1): the rollup counter branch rejects the 0→baseline step a
  panel restart produces (`pi/influx_tasks/*.flux`), and `charge_detector.py` writes whole
  sessions (99% of charger energy, was ~44%). `docs/superpowers/notes/2026-10-27-ev-accuracy-findings.md`.

**Done and deployed (2026-07-31)**

- Nightly encrypted backups to Cloudflare R2 (`pi/backup/`). ~216 MB/snapshot, systemd
  timer at 03:30. Restore runbook in `pi/backup/README.md`. This gates everything
  destructive below.
- Influx rollups (#9): `circuit_5m` / `circuit_1h` tasks live, 7 months backfilled
  (3.77M + 314k points). Verified to **-0.0032%** against raw integral on a gap-free week.

**Built, awaiting verification**

- `web/` and `pi/daily_report.py` read the rollups. Containers rebuilt 2026-07-31;
  needs a real smoke test of the site and one past-dated report run.

---

## The through-line

Most of what's interesting left is one capability wearing different hats:
**attributing energy to a cause.** Baths, laundry, showers, and recirc-loop losses
are all "a trigger happened, then the heat pump worked harder for a while."
`bath_detector.py` is already a hardcoded special case of it.

That capability is blocked on outdoor temperature, because the Stiebel Eltron is an
integrated unit — space heating, cooling, and hot water on the same three circuits.
Without temperature you cannot tell "heated water" from "conditioned air."

Hence temperature comes early despite looking like a side quest.

---

## Phase 1 — Trust the numbers (#15, #16)

*Prerequisite for every analysis below. Cheap.*

Energy is currently computed by integrating sampled power, which **invents energy
across gaps** — InfluxDB draws a straight line over each missed poll. SPAN's own
cumulative meter doesn't have this problem, and we already store it as
`energy_wh_counter` alongside `energy_wh` precisely so this could be settled on data.

- **#15** — make `energy_wh_counter` authoritative for energy; keep power-integration
  for the chart, where the counter is too coarse.
- **~~#16~~ — DONE, merged + deployed 2026-08-23.** Pi observability. ~2% of polls were missed on a
  sampled day and a 2h50m outage on 2026-07-30 went unnoticed; backup health was already covered
  by `web/lib/health.ts` + UptimeRobot, so this scoped to collector reliability. Shipped:
  `collector_poll` points per iteration (result/error classification), a 07:00 data-gap email
  (coverage < 98% or a gap ≥ 30 min, both env-tunable), `status.sh` coverage line, and a `telegraf`
  + `pi-health` Grafana dashboard for host/container metrics. Finding along the way: the daily
  anomaly check's coverage gate had been crashing every run since PR #19 on an unsupported Flux
  aggregate (`distinct(_time) |> count()`) and never could have fired — fixed with a `map` + `sum`.

Do these first because every later number inherits their accuracy, and because
"is this finding real or is it a data gap?" has already cost time once today.

---

## Phase 2 — See the whole house (#17, #12)

*The breakdown currently omits ~28% of consumption.*

`panel.feedthrough_power_w` measures the Square D overflow subpanel — Washer, Dryer,
Garage, Attic, Bath, Recirc Pump, Pwdr Rm — at 30s back to January. It reconciles:
grid 964 W = named circuits 681 W + feedthrough 266 W.

- **~~#17 part 1~~ — DONE, deployed 2026-08-23.** "Unmonitored" category added to both `web/` and
  `pi/daily_report.py`'s breakdowns so totals reconcile to the bill. Shipped as a panel-residual
  (`grid_power_w` integral minus circuits), not sourced from `feedthrough_power_w` directly — see
  CLAUDE.md and issue #17 for why. Settles ~11% share live, not the 28% snapshot above.
- **#12** — per-circuit drill-down. Cheap now that rollups exist; same query with
  `group(["name"])`.
- **#17 part 2** — dryer detection off the feedthrough series (6.6 kW peaks against a
  266 W baseline — unmistakable), then washer using a confirmed dryer cycle as prior.

---

## Phase 3 — Weather (#14, #3)

*Unblocks everything in Phase 4. Free, and backfillable.*

- **~~#14 phase 1~~ — DONE, deployed 2026-08-24.** Hourly outdoor temp from Open-Meteo into a
  `weather` series (`pi/weather_poller.py`), backfilled to 2026-01-04.
- **~~#14 sub-project 2~~ — DONE, deployed 2026-08-28.** Heat/cool/hot-water split into a 5-min
  `hvac_mode` timeline (`pi/hvac_classifier.py`), backfilled to 2026-01-04; web breakdown shows
  Heating/Cooling/Hot Water sub-rows. #14 closed 2026-09-05; its remaining half lives in #3.
- **#3** — cold-weather suppression for the aux-heat alarm. Now implementable; nothing built.
  Note `daily_report.py` has no aux-heat-specific alarm yet, only the generic per-category
  anomaly check — #3 has to define the alarm before it can suppress it.

**Decision point:** if Phase 5 (Timescale) is going to happen, write `weather` to
Timescale rather than Influx from day one. It's the natural pilot — small, new, and
the one dataset both SPAN and the lights system want to join against.

Later: per-facade sensors for solar gain (#14 phase 2) — hardware, separate project.

---

## Phase 4 — Attribution and rollups (the actual goal)

*What Nico asked for on 2026-07-31: weekly/monthly consumption and spend by category,
on the site and in the email, with baths and laundry broken out.*

- **Weekly + monthly category rollups with $**, shared between `web/` and
  `pi/daily_report.py` so the two can't diverge.
- **Generic heat-pump attribution** — given a trigger event, integrate HP draw above
  a rolling baseline over a response window. Build once; baths, laundry hot water,
  showers, and recirc losses all fall out of it. Retire `bath_detector.py`'s hardcoded
  version into it.
- **Presentation:** baths and EV sessions are *derived sub-slices*, not peers of
  Lights/HVAC/Car — they overlap those categories and must not be summed alongside them
  or the breakdown double-counts.
- **Water-bill estimate** — bath and laundry hot-water volume → gallons → SPU rates.
  Explicitly an estimate with stated assumptions.

**Ground truth for tuning this:** `docs/superpowers/notes/2026-09-04-vacation-and-dhw-ground-truth.md` has two more
dated, confirmed-against-reality misses (a fast overlapping heat+shower+laundry call classified
`ambiguous`; a slow-ramping delayed DHW reheat classified `heat`) alongside the original Aug 26
findings doc — useful fixtures whenever this gets revisited.

**Open question worth settling with data:** the recirc pump. Unplugged 2026-04-09;
overnight (2–5am) heat-pump draw went from 806 W median to 21 W. Bounded at
$107–$850/yr, too wide to act on because April warming is confounded. #14 resolves it
retroactively. Also unknown whether it was ever plugged back in — check before redoing
the analysis.

---

## Phase 5 — Consolidate the data layer (#18)

*Strategic. Do not start before Phases 1–3 are stable.*

Two time-series databases run on phrpi doing overlapping jobs. Timescale wins on
merit: it's Postgres (relational + time-series together), it enables cross-domain
joins that are impossible today, its continuous aggregates natively replace #9's
hand-rolled rollups, and Flux is a dead-end language.

Phasing is in the issue. The honest cost: much of #9 becomes redundant. It still
earned its keep — the site is fast now — but it argues against *further* Influx work.

---

## Phase 6 — Housekeeping

Low urgency, real payoff. Suitable filler work.

- Pin floating image tags (`grafana:latest`, `timescaledb:latest-pg16`,
  `cloudflared:latest`) — a surprise major version will break something.
- Rename the `deploy` compose project (from the `~/nudge/deploy` dir name); it will
  collide. Note renaming orphans volumes — safe now that backups exist.
- Reclaim ~20 GB of stale Docker images and build cache.
- Practise a restore from R2. An untested backup is a hypothesis.
- **#13** chart E2E, **#10** IndexedDB cache, **#7** smoothing, **#5** refresh cadence,
  **#6** CF Access, **#8** in-email settings — all independent, none blocking.

---

## Deliberately not doing

- **Manifest CORS** — decided 2026-05-24 to live with it. Cosmetic; the fix is blocked
  by Cloudflare's no-overlapping-destinations rule.
- **Expiring raw 30s data.** Storage is ~460 MB/yr against 90 GB free — roughly 195
  years of headroom. Raw history is what lets new detectors backfill over old data;
  the dryer detector reaching January depends on it. Keep it forever.
- **Consolidating both Pis onto one box** until there's a reason. HA is a leaf node;
  merging failure domains buys tidiness at the cost of resilience.
