# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Local observability tool for SPAN Smart Panel. Polls panel API, stores data in InfluxDB, visualizes in Grafana.

**Panel IP:** 192.168.4.72 (static)

## Quick Start

```bash
# One-shot health check of the whole stack (panel, Pi services, freshness, backup)
./status.sh

# Full stack lives on the Pi (ssh nico@phrpi.local); manage it there:
cd pi && docker compose up -d
```

## Machine roles (decided 2026-08-13)

- **Pi (`phrpi.local` → 192.168.4.53 on eth0; 192.168.5.50 is its wlan0 out-of-band backup,
  which `status.sh` uses as a fallback)** — single source of truth. Runs the whole Docker
  stack (dashboard itself is Vercel-hosted) + nightly restic backup. Stays this way deliberately: low blast radius,
  rebuilds from git.
- **Mini** (closet, ethernet to Pi, always-on) — no SPAN services. Observer/backup
  roles only (uptime monitoring is external — UptimeRobot via prompt-lab's
  declarative config; candidate second backup target). Revisit only if #18
  (TimescaleDB) lands, which would make it the storage box.
- **Laptop** — dev only. `status.sh` works from here; nothing
  runs in steady state. Checkout is `~/src/span`.

**Repo renamed `SPAN` → `span` on 2026-08-27** (GitHub `nicolovejoy/span`; the old URL still
redirects). The **Pi's checkout stays `/home/nico/SPAN`, capital-S, deliberately** —
`/etc/systemd/system/span-backup.service` hardcodes
`ExecStart=/home/nico/SPAN/pi/backup/backup.sh`, and backup guards the only unrecoverable state.
Its git remote was updated in place. Compose is unaffected either way: the project name derives
from the `pi/` directory, so volumes are `pi_influxdb-data`, never `SPAN_*`. Renaming that
directory later means editing the unit and `systemctl daemon-reload` first.

## Architecture

- `pi/` - Docker stack for Pi deployment (11 services)
  - `collector.py` (v1 REST) - **deleted 2026-11-13** after 8 clean days on v2; last in git at
    c98e7f4^. `SPAN_ACCESS_TOKEN` is gone from `pi/.env.tpl` too.
  - `collector_health.py` - Pure gap/coverage math + httpx error classification, no I/O (#16)
  - `hvac_modes.py` - Pure 5-min interval bucketing + two-stage heat/cool/hot-water/idle/ambiguous
    classification, no I/O (#14 sub-project 2)
  - `attribution.py` - Pure run-grouping + bath predicate over the `hvac_mode` timeline, no I/O
    (#14 sub-project 2); shower/laundry predicates are natural follow-on additions here
  - `bath_detector.py` - Detects bath events from the `hvac_mode` timeline (re-based off raw
    circuit reads, #14 sub-project 2)
  - `charge_detector.py` - Detects EV charging sessions (10min loop over a 12h lookback;
    writes a session only once it has *ended*, keyed by exact start time — until 2026-10-27 it
    wrote sessions at first sight and never updated them, so `charge_event` carried ~40% of the
    charger's energy. `--backfill --days N` rebuilds from raw.) The car is an Ioniq 5 (no app);
    "Tesla Car Charger" is just SPAN's circuit label.
  - `influx_tasks/*.flux` - the `circuit_5m` / `circuit_1h` rollup tasks. The counter branch
    sums only *plausible* steps of SPAN's cumulative meter (previous reading non-zero, step ≤
    10 kWh + 50 kW × elapsed): a panel restart on 2026-10-26 read 0 on every circuit for ~20 min
    and came back at a lower baseline, and the 0→baseline step was summed as +2,921 kWh of HVAC.
    SPAN's meter lands energy in ~15-min batches, so never bound a step by implied power alone.
    Details + probe table: `pi/influx_tasks/README.md`; findings:
    `docs/superpowers/notes/2026-10-27-ev-accuracy-findings.md`. After editing a `.flux`:
    `./provision_influx_tasks.sh`, `docker compose build daily-report`, backfill with
    `docker compose run --rm --no-deps …` (without `--no-deps` compose recreates `influxdb`).
  - `wall_connector_poller.py` - Polls the Tesla Wall Connector Gen 3's unauthenticated local API
    (192.168.7.124, DHCP-reserved) every 60s into a `wall_connector` measurement: the charger's own
    cumulative kWh, ground truth for `charge_event`. Not in `/api/health` yet.
  - `weather_poller.py` - Hourly outdoor temp/humidity/cloud-cover from Open-Meteo into a
    `weather` measurement (#14 Phase 1). Unblocks the heat/cool split and cold-weather
    aux-heat suppression (#3) — neither built yet.
  - `hvac_classifier.py` - Classifies heat-pump operation into 5-min `hvac_mode` intervals
    (heat/cool/hot_water/idle/ambiguous) via `hvac_modes.py`, writing to Influx; `--loop` /
    `--backfill` / `--backtest` modes plus a nightly 02:00 Pacific self-heal sweep re-backfilling
    the last 2 completed days (#14 sub-project 2). Depends on `weather_poller.py`'s output — no
    weather data degrades intervals to `ambiguous`. Writes no health point and isn't in
    `pi-health.json`; `/api/health` does check `hvac_mode` freshness (≤75 min, since 2026-09-05).
  - `daily_report.py` - Weekly energy briefing (Mondays) + daily anomaly-check email + daily
    data-gap alert via Resend, all at 7am; plus an opt-in daily heat-pump cooling alert
    (`HVAC_COOL_ALERT=1` in `pi/.env`, ≥15 min of `cool` intervals yesterday) — on for heating
    season, off for cooling season. Added 2026-09-10 after the Stiebel ran cooling on its own
    comfort setpoint (since raised 22.5→24°C) while the Honeywells sat on heat.
    Email overhaul (plan `docs/superpowers/plans/2026-11-05-email-overhaul.md`, code 2026-11-05):
    `email_kit.py` (inlined styles, plain-text part, dark-mode wrapper; needs its Dockerfile COPY,
    present) for all four emails, dashboard deep links, a heat/cool/hot-water split in the weekly
    briefing and HVAC anomaly email (from `hvac_mode`), and anomaly emails that say NEW today or
    Day N since …, backed by episode-start state. Deployed to the Pi 2026-11-13 (the `daily-report`
    container had not been rebuilt since 2026-09-10, so emails 11-06 → 11-13 went out in the old
    format); first new-format send is the 2026-11-14 7am run, weekly briefing 2026-11-16.
    Weekly briefing accuracy pass (2026-11-13): the long-run column is an average *week* over the
    trailing 52 weeks of days with data, labelled by the weeks behind it ("vs 43-wk avg") — it used
    to compare a week against an average *month*, so everything read about -70%. Chart legends sit
    in one row above the plot in stack order, and bars include Unmonitored so they sum to the
    headline. Year-over-year (same week last year + the five weeks centred on it) is built but
    dormant until the data exists (first week: January 2027). The HVAC block states outdoor
    temperature as context only: a weather-adjusted "expected kWh" was tested and rejected (weekly
    heat kWh vs heating degree days, R² 0.62; similar-weather weeks differ ~4x, and January's
    heat/hot-water split looks off — not investigated).
  - `rates.py` - TOU rate schedule for cost calculations
  - `telegraf.conf` - Host + per-container metrics (CPU/mem/disk/load/temp/docker) into the
    `telemetry` bucket (#16)
  - `docker-compose.yml` - InfluxDB, Grafana, collector, bath-detector, charge-detector,
    weather, hvac-classifier, daily-report, telegraf, cloudflared
  - `cloudflared` — the `phrpi` tunnel is **shared beyond SPAN** and its routes are
    dashboard-managed (Zero Trust → Tunnels → phrpi → Published application routes, read
    2026-09-19): `grafana.` → `grafana:3000`, `influx.` → `influxdb:8086`, and `koma.` /
    `michael.` → `nudge-board:80` (the nudge project: its own compose project `deploy`, attached
    to this stack's `pi_default` network). **Restarting it blips all of them.** The `span.` →
    `web:3000` route is stale (web retired 2026-08-13; dashboard cleanup optional). The token is a
    compose secret read via `--token-file` (2026-09-19, prompt-lab #55) — never re-add `--token`
    or `env_file: .env` to this service; either puts secrets back in `docker inspect`. Source of
    truth for the token: 1Password `dev-secrets` → `phrpi-cloudflared-tunnel-token` (field
    `credential`); the Pi's `pi/.env` is rendered from it via `pi/.env.tpl` (see § Credentials;
    the Pi has no `op`). To rotate: Cloudflare dashboard → tunnel → Add a connector → Refresh
    token, update the 1Password item, run `pi/render_env.sh` from the laptop, then `docker compose
    up -d --force-recreate --no-deps cloudflared` (`--force-recreate` because compose doesn't
    notice a changed secret value alone). Never hand-edit the Pi's `.env`.
  - `collector_v2.py` + pure `span_v2.py` — **the collector** (compose service `collector`, container
    `span-collector`) since the 2026-11-05 cutover (#26): subscribes to the panel's MQTT broker
    (8883, Homie topics), snapshots every 30s into `panel` / `circuit` / `collector_poll` /
    `panel_lifecycle` — the same schema v1 wrote, so downstream is untouched. Also writes one
    `collector_poll` point per snapshot (result/error + `panel_age_ms`) for observability (#16).
    Secrets are compose file secrets (no `env_file`). Exits after 10 min without an ok snapshot so
    the container restarts and re-fetches the panel CA. The `*_v2` measurements are shadow-run
    history (2026-10-28 → 11-05), harmless; drop whenever.
  - `grafana/provisioning/` - Auto-configured datasource + dashboards, incl. `pi-health.json`
    (uid `pi-health`) — collector poll failure rate, host + container metrics (#16)
- `web/` - Next.js power-explorer dashboard (Vercel-hosted, see § web/)
- `pi/backup/` - nightly restic backup to Cloudflare R2 (systemd timer, 03:30). Covers the
  only unrecoverable state: InfluxDB, the lights project's TimescaleDB (shares the Pi; not span data), the Grafana volume, and the `.env` files —
  everything else rebuilds from git. Config at `/etc/span-backup.env` on the Pi (rendered from
  `span-backup.env.tpl` via `op inject`; the Pi has no 1Password). **Restore runbook and setup
  steps: `pi/backup/README.md`.** The repo password lives in 1Password as `phrpi-restic-backup`
  — without it every snapshot is unrecoverable ciphertext.

## web/ — power explorer

Next.js 16 app, **Vercel-hosted** (project `nico-lovejoys-projects/span`,
domain `span.pianohouseproject.org`) since 2026-08-13, auto-deployed from
GitHub pushes via the Vercel Git integration. Pi-hosted as a Docker service
2026-05-09 → 2026-08-13.

- **Client-driven state** (`ExplorerClient.tsx`, since #11 2026-06-19): a client reducer owns `{from,to,interval,show}`. Pan/zoom updates client state only — it never navigates. The URL is **intent-only** (`?range=7d&show=HVAC`), synced via `history.replaceState`; transient pan/zoom is *not* in the URL. `page.tsx` SSRs the initial breakdown + seeds the client cache for a fast first paint, then the client owns every switch. A full reload resets pan/zoom to the preset (by design).
- **Caching:** in-memory `TtlLru` (`lib/clientCache`) fronts `/api/power` + `/api/energy` (`lib/clientFetch`) → back-and-forth between visited windows = 0-network. Server LRU (`lib/queryCache`, both power + energy) + HTTP cache are the cold-miss backstop. IndexedDB-across-reload persistence still open (#10).
- **Breakdown table** = real 30s `integral()` via `/api/energy` (`cachedQueryEnergyByCategory`), keyed by window only so changing the bucket doesn't refetch it.
- **Breakdown table snaps to Pacific calendar periods (2026-08-28, decided over two design rounds):** the chart shows the exact zoom window, but the table describes the calendar day/week(Mon-start)/month/year nearest the view (grain from window length: ≤2d/≤14d/≤62d/else), anchored at the window's end — full period vs full prior period when historical, period-to-date vs same-elapsed-of-prior ("pace", clamped to the prior period's end) when it contains now. Headers name the period (`kWh · Aug 2026 · so far` / `vs Jul`). All pure logic + labels in `web/lib/energyWindow.ts` (`snapPeriod`, `periodLabel`, `computeDelta`), tested incl. DST + short-month clamp. Percent deltas are suppressed under a 1 kWh prior base — small denominators screamed (+137% on 1.3 kWh).
- **Events layer (2026-09-05):** two SVG lanes under the chart (heat-pump `hvac_mode` runs; `bath_event` + `charge_event` spans) drawn inside `PowerChart` via lightweight-charts' `timeToCoordinate` plus a per-render affine time→x map from two resolved bucket anchors (`resolveAnchors` + `affineXOf`) so they track pan/zoom, plus an `EventList` under the breakdown table (rows follow the visible window, click zooms). Data from `/api/events?from&to` → `{ modes, events, modesTruncated }`; runs grouped server-side by `lib/eventRuns.ts` (pure, tested), layout in `lib/eventLanes.ts` (pure, tested). Mode runs are skipped beyond 62-day windows. `events=0` in the intent URL hides the layer; on by default. Spec: `docs/superpowers/specs/2026-09-05-explorer-events-layer-design.md`. Future de-clutter / drill-down pages: #25.
- Auto-coarsen interval picks bucket size to stay ≤175 points across the range
- Tests: `cd web && npm test` (vitest) — unit tests for the cache + intent-URL logic. Chart/React wiring is manual-verify.
- Categories sourced from `pi/categories.json` (copied to `web/categories.generated.json` by `predev`/`prebuild` — Vercel builds use this normal `prebuild` sync; the Dockerfile's copy-in path is a Docker-era leftover, no longer used)
- Talks to Influx via `influx.pianohouseproject.org` with the `span-web` CF Access service token (`CF_ACCESS_CLIENT_ID/SECRET` in the Vercel env activate the service-token path in `web/lib/influx.ts`)
- Built with `output: "standalone"` — a leftover from the Docker era, harmless on Vercel
- **Cloudflare Bot Fight Mode must stay OFF on the `pianohouseproject.org` zone.** It challenges the
  Vercel→Influx path and breaks the dashboard. Outage 2026-08-21: 453 of 500 firewall events in 24h
  were `bot_fight_mode` / `managed_challenge` against `influx.pianohouseproject.org` `/api/v2/query`,
  UA `influxdb-client-js`, from Vercel's AWS egress — *all* of them our own traffic, zero real bots.
  Symptom: `/api/health` 503s and charts go blank while the Pi stays perfectly healthy.
  - **A WAF skip rule does NOT fix this on the free plan.** Plain Bot Fight Mode runs ahead of WAF
    custom rules and can't be exempted; that scoping needs Super Bot Fight Mode (paid). The zone-wide
    toggle in Security → Settings is the only lever. Don't burn time writing a skip rule.
  - Nothing else protects Influx via BFM — CF Access + the service token is the real gate, and Managed
    Rules / AI Crawl Control (which do catch real scanners on other hosts in the zone) are unaffected.
  - **It presents as a rate limit, not a hard block.** Vercel egresses from a rotating AWS IP pool and
    BFM scores each IP separately, so ~1 check in 20 slips through — long down-runs punctuated by a
    single success. Both agents on the 2026-08-21 incident initially misread this as a refilling
    rate-limit budget. Firewall-events export (Security → Analytics → Events) names the rule directly;
    read it before theorising.
- `/api/health` — observer endpoint (UptimeRobot + prompt-lab's daily health email): reads `HEALTH_CHECKS` in `web/lib/health.ts`, four checks — collector ≤300s, backup ≤30h, weather ≤5h, hvac_mode ≤75min. 503 on any failure.
- Deploy/auth setup: see `docs/web-deploy.md`

## Next Steps

**Start at `docs/roadmap.md`** — phased, dependency-ordered, each phase scoped to hand to a
subagent. The list below is near-term mechanics; the roadmap explains ordering and why.

- **#26 — v1 REST API removed by SPAN on 2026-12-31. Collector CUT OVER to v2 MQTT 2026-11-05**
  (c98e7f4). Shadow-run compare (`pi/tools/compare_v2.sh`) was clean once its per-day energy check
  stopped false-failing on v1's ≤15-min batch lag at midnight (heat pump 11-02, 337 Wh shifted
  across the boundary). Verified at cutover: `/api/health` 200, `status.sh` green, 21 circuits per
  poll as before, heat pump counter stepped +368 Wh once at the switch (v1's held-back batch;
  matches the 5-min power integral, no double count). From 2026-11-06 the morning emails run on v2
  data. `collector.py`, the `pi/.env.tpl` line and the compose rollback note were
  deleted 2026-11-13. Remaining before 2026-12-31: (1) Nico: delete the `SPAN_ACCESS_TOKEN` field
  from the `phrpi-span-env` 1Password item and run `pi/render_env.sh` (expect one dropped key);
  until then the Pi's `.env` still carries the unused key, harmless; (2) done 2026-11-13: the
  v1 laptop tools (`span_client.py`, `discover.py`, `run.sh`, `requirements.txt`) were retired, not
  ported; nothing in the repo speaks v1 any more. `pi/hvac_probe.py` was listed here by mistake: it
  reads Influx, not the panel, and needs nothing; (3) optional: surface
  `panel_lifecycle` as "panel restarted" in the anomaly email. Spike findings
  `docs/superpowers/notes/2026-10-27-span-v2-spike-findings.md`; plan
  `docs/superpowers/plans/2026-10-28-collector-v2.md`.
- **Trends view (`/trends`) — Part 1 (EV accuracy) SHIPPED 2026-10-27; Part 2 deferred behind
  #26.** Spec `docs/superpowers/specs/2026-10-26-trends-view-design.md`, plan
  `docs/superpowers/plans/2026-10-26-trends-view.md` (Tasks 3–9 remain). Part 1 outcome: the
  "October EV split" and the 3,052 kWh anomaly email were one panel-restart counter rebase, fixed
  in the rollup tasks; `charge_event` now covers ~99% of charger energy (was ~44%). Unmonitored
  unaffected. Ground truth for the charger: `wall_connector_poller.py` (deployed 2026-10-29) reads the
  Gen 3 unit's `/api/1/lifetime` + `/vitals` into a `wall_connector` measurement; its absolute
  counter is unverified, so compare windows by differencing — reconciling it against
  `charge_event` is still to do. Open: a restart /
  firmware-change signal from the panel so the anomaly email says "panel restarted" instead of
  reporting usage (the v2 status endpoint has no uptime — fold into #26's spike).
- **Pi test suite:** all green, 339 pass (2026-11-13). The 5 `test_weekly_report.py` failures were
  a stub-order bug, fixed by the shared matplotlib stub in `pi/conftest.py` (f00cba8). Run with
  `cd pi && uv run --python 3.11 --with pytest --with httpx --with influxdb-client --with tzdata
  --with matplotlib pytest -q`.
- **#14 sub-project 2 — heat/cool/hot-water split — SHIPPED 2026-08-28.** Deployed to the Pi,
  `hvac_mode` backfilled to 2026-01-04 (67,608 intervals), merged to `main`, smoke-tested live.
  Spec/plan/findings under `docs/superpowers/` (the ≥95% bath-parity gate was waived at 83.3% —
  structural, see `notes/2026-08-26-hvac-phase0-findings.md`). Follow-ups now unblocked (pointers,
  not new scope): shower/laundry predicates as small additions to `attribution.py` (the shower
  population is measured, per the findings note); #3 cold-weather aux suppression; a recirc-pump
  retro-analysis (unplugged 2026-04-09) readable from overnight `hot_water` energy in the
  backfilled timeline.
- **#17 part 2 — dryer (then washer) detection**, off `panel.feedthrough_power_w`. Part 1
  ("Unmonitored" breakdown row) shipped 2026-08-23 (commit d3bb6a0) and reconciles live at ~11%
  share; part 2 is the next Phase 2 item and *does* need the sign/`abs()` handling part 1 deliberately
  deferred (`feedthrough_power_w` swings negative). Detail: `docs/roadmap.md` Phase 2, issue #17.
- **#9 segment-router cleanup candidate** — `daily_report.py`'s `_run_segments` and friends,
  `query_total_kwh`, `_delta_arrow` are unreferenced by the shipped weekly report. Candidate for a
  future cleanup pass if nothing else picks them up first.
- **Events layer follow-ups** (from the 2026-09-05 final review, none blocking): mode-run `$` uses
  the flat `web/lib/rates.ts` rate while bath/charge rows use the Pi's TOU `cost_dollars` —
  `hvac_mode` already stores a per-interval `cost_dollars` that `queryHvacModeIntervals` could sum
  instead; `queryEvents` looks back only 24h for events overlapping the window start (fine for
  baths/charges, will truncate any future long-running `<kind>_event`); adjacent lane hit-targets
  (8px minimum) overlap at 7d+ so hover can pick a neighbour; no loading state distinct from
  "no events"; first paint shifts 44px when the lanes mount. UX de-clutter / drill-down pages: #25.
- **Heat-pump cooling alert (shipped 2026-09-10)** — `HVAC_COOL_ALERT=1` is set on the Pi for
  heating season; **set it to 0 next spring** or it emails every warm day. First real read is the
  2026-09-11 7am run (first day after the Stiebel comfort setpoint went 22.5→24°C). No thermostat
  ground truth exists: Honeywells aren't in HA and the Resideo developer application (2026-04-09,
  re-pinged 2026-09-10) is unanswered — if it lands, gate the classifier on `hvac_mode` from the
  API. Thread: `~/src/.handoff/home-assistant-span.md`.
- **Presence/occupancy signal from lights-circuit baseline deviation** — new idea, not yet built.
  `docs/superpowers/notes/2026-09-04-vacation-and-dhw-ground-truth.md` found the vacant-period baseline for "Lights /
  Downstairs" stable to ±2W night over night, and a real visitor broke it by 2–3x with bedroom
  circuits untouched — a much cleaner occupancy signal than anything HVAC- or grid-based (HVAC
  reacts to weather regardless of occupancy; grid blends EV/kitchen/everything together). Sketch:
  a rolling per-circuit, per-time-of-day baseline (trailing-N-day median at matching local time),
  flag sustained deviation as a presence event, surface either as its own event stream (like
  `bath_event`/`charge_event`) or a shaded band on the explorer chart. The Aug 31–Sep 2 vacant
  window in that note is a ready-made calibration case.
- **Dashboard access model** — decision pending (2026-08-13); candidate: signed-cookie unlock link in Next.js middleware. /api/health (observer endpoint, see prompt-lab uptime convention) must stay exempt.
- **EV monthly + annual cost rollup** in daily report (request #3 from 2026-05-23 batch — last unaddressed item). Weekly section already excludes EV (per-2h-bucket subtract); EV accounting is pinned to the exact `CHARGE_CIRCUIT` name shared with `charge_detector`, not the Car regex.
- **Power explorer chart E2E** (#13) — Playwright harness via a `MOCK_INFLUX` fixture mode. Plan in the issue.
- **`weather_poller.py` has no dead-service detection.** `normal_run`'s `past_days=2` self-heals a
  single missed poll, but an outage longer than ~2 days leaves a permanent hole only a manual
  `--backfill` re-run repairs. Unlike the collector, it writes no health point and isn't in
  `pi/grafana/provisioning`'s `pi-health.json`. No fix designed yet. The same blind spot exists for
  `hvac_classifier.py` (#14 sub-project 2): its nightly 02:00 Pacific sweep re-backfills the last 2
  completed days, so an outage under ~2 days self-heals, but a longer one still needs a manual
  `--backfill`, and it likewise writes no health point and isn't in `pi-health.json`. Both are now
  in `/api/health` (2026-09-05) so a dead container pages via UptimeRobot; the remaining gap is that
  an outage longer than the self-heal window still needs a manual `--backfill`. Because the
  classifier depends on `weather_poller.py`'s output (no weather data degrades intervals to
  `ambiguous`), an unfixed weather outage silently degrades the HVAC split too, even after
  `hvac_classifier` deploys.
- **Dashboard UX backlog** — open: polling cadence (#5), 1m smoothing (#7), custom PWA icon,
  zoom-in-loads-detail (#12 follow-up, low priority), in-email settings link (#8, needs persistent
  store + report-loop rework).
- **HVAC cooling watch** — cooling fault found 2026-06-14 (aux resistance firing + compressor short-cycling on a hot day); turning off the HRV apparently fixed it. Confirm with a 3–6h `pi/hvac_probe.py` run during active cooling. Cold-weather suppression at #3.

## SPAN API

**The collector uses v2 (since 2026-11-05):** `POST /api/v2/auth/register` (door-switch proximity or
the app's passphrase) → `accessToken` + `ebusBrokerPassword`; readings come from the panel's own MQTT
broker (8883, username = serial, Homie topics per circuit), LAN-only. `GET /api/v2/status` is
unauthenticated (what `status.sh` probes); `GET /api/v2/certificate/ca` serves the broker's CA.
Circuit loads are *negative* `power_w` in both APIs; consumers take `abs()`.

v1 (`http://192.168.4.72/api/v1`) is **removed by SPAN on 2026-12-31**; nothing in this repo uses it
since 2026-11-13.

## Credentials

The Pi's `pi/.env` (git-ignored) is generated, never hand-edited: `pi/.env.tpl` lists every key, with
secrets as 1Password references (vault `dev-secrets`; items `phrpi-span-env`, `span-panel-v2-client`,
`phrpi-cloudflared-tunnel-token`, `SPAN-resend-API-key`). To change a value, update 1Password (or a
plain line in the template), then run `pi/render_env.sh` from the laptop. It renders, shows key names
that would be dropped/added and same/DIFFERS per key, asks before swapping, keeps `.env.bak`, and
restarts nothing.

<!-- SHARED-CONVENTIONS:BEGIN v=c254cba18982 — auto-managed, do not edit here; source: prompt-lab/workflow/claude-md-shared.md (edit + re-sync) -->
## Shared conventions

<!-- These are Nico's cross-repo output rules. They're materialized into each repo's
CLAUDE.md so every agent (local, cloud, headless) sees them as plain text. Source of
truth: prompt-lab/workflow/claude-md-shared.md — edit there and re-sync, never here. -->

- **Clickable URLs.** When pointing at any web destination (dashboard, repo, PR, deploy, settings, docs, localhost), print the full bare URL — `https://example.com` or `http://localhost:8080` — on its own, never just the page's name and never a markdown `[label](url)` link. Nico's terminal auto-linkifies raw `https://` text, so a bare URL is one-click and stays copyable.

- **Number your questions.** Any time you ask Nico more than one question, present them as a numbered list (1., 2., 3.) so he can answer by number with no ambiguity. A single standalone question needs no number.

- **Never ask Nico to recall a past moment.** No "think of the last time X happened", "walk me through the last time…", or any question he can only answer by remembering an event. Look the history up yourself (the prompt-history DB, git, logs, the data), then propose something concrete for him to react to, or ask directly what he wants. This overrides the brainstorming skill's "walk me through the last time" question style (Nico, 2026-11-03).

- **Self-contained smoke-test instructions.** When you ask Nico to manually test or verify an app or website, assume zero carried-over context — he should never scroll back or recall a URL/path/credential from earlier. Always include: the exact URL (full `https://…` or `http://localhost:…`, restated even if mentioned above), the precise steps in order, and what a pass vs. fail looks like. Repetition here is a feature, not clutter.

- **UTC at rest, Pacific on display.** Timestamps are stored in UTC, always. A *calendar day* shown to a human is `America/Los_Angeles` — Nico's day, and the clock the work actually happened on. The two rules that follow are the ones that get broken: never form a date bucket with `new Date(…).toISOString().slice(0,10)` (that is UTC, so every chart axis and "today" silently rolls over at 5pm Pacific — it put a phantom tomorrow bar on the Prompt Lab dashboard), and never bucket UTC-stamped rows with a bare `date(col)` in SQL. Use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })` in JS and an explicit zone in SQL/Python. Storage in local time is also wrong — it can't be migrated across a DST boundary without loss.

- **No marker before a copy-paste command block.** Nico's terminal renders markdown bullets (`-`, `*`, `•`) as `●`, which breaks paste into zsh. The line directly above a fenced command block must be a plain-text label ending in a colon — never a bullet, dash, asterisk, or number. For loud copy targets, lead the label with `📋` + bold `COPY THE BELOW`, then a colon, then the block. Bracket anything Nico will paste elsewhere (a prompt for another agent, a multi-line command) with a ruler line of `================` above the label and below the closing fence. Rulers go outside the fence so they aren't copied, each with a blank line before it (a `===` line directly under text renders as a heading).

- **No bare backslash in a copy-paste command block.** A `\` is load-bearing shell syntax that renders invisibly and gets silently dropped somewhere between the markdown render, the clipboard, and zsh. `find … -exec test -e {} \; -delete` arrived in the terminal as `… {} ; -delete`, which zsh split into two commands and reported as `find: -exec: no terminating ";"` plus `command not found: -delete` (2026-09-20). Quote it instead — `';'` is exactly equivalent to `\;` and survives any copy path. For the same reason never break a command across lines with a trailing `\`: write one long line, however wide it wraps.

- **Reader-facing text lives in content or copy files, not inline in components.** Some repos ship French alongside English (selected-projects mirrors the site under `/fr`; ibuild4you has French public pages). There, every new string goes in the repo's strings/copy module or content folder, with its translation, and an English copy edit means updating the French twin too. Elsewhere, keeping text out of components is what makes `/localize` cheap later. Terms and register: `prompt-lab/workflow/localization/fr-glossary.md`.

- **A review another agent must act on goes on the PR.** A review that another agent must act on, or that must outlive the session, is posted as a PR comment (`gh pr comment`), where the next session or agent finds it. Live, in-session reviews between Nico and the agent stay in chat. There is no devlog.md: the history DB is the one session record.

- **Browser testing runs headless.** A headed browser takes focus on Nico's Mac. Run Playwright headless, with Edge (`channel: 'msedge'`) for desktop runs wherever a config picks a browser. Never use `headless: false`, `--headed`, `--debug`, `--ui` or `PWDEBUG` unless Nico asks for it in this session. For a visual check, take a screenshot or record a trace (`trace: 'on-first-retry'` or `'on'`) instead of opening a window. The Claude-in-Chrome extension is the one thing that drives Nico's real Chrome, on purpose.

- **WebKit test runs record no frames on a Mac.** While the display is asleep, macOS WindowServer keeps every captured window buffer until a display wakes, and at 65,536 it aborts and ends the login session (2026-11-09; https://github.com/microsoft/playwright/issues/43066). Playwright's WebKit trace screenshots and video capture 25 times a second. In any config with a WebKit project, set `screenshots: false` on the trace for local runs (`trace: { mode: 'retain-on-failure', screenshots: false }`, any mode) and leave video off; CI on Linux may keep them. With that set, `--trace on` stays safe. Plain `page.screenshot` is fine, and Edge and Chromium are unaffected. Do not use `caffeinate -d` for this: it cannot wake a sleeping display and has no time limit around a command. Healthy reading: `ioclasscount IOSurface` between 400 and 900.
<!-- SHARED-CONVENTIONS:END -->
