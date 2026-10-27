# Trends View + EV Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status (2026-10-27):** Part 1 (Tasks 1–2) **done** — findings and the shipped fix in
`docs/superpowers/notes/2026-10-27-ev-accuracy-findings.md` (the cause was a panel-restart
counter rebase, not the integral; Unmonitored unchanged; the Car layer stays the circuit
counter). Part 2 (Tasks 3–9) is **deferred behind #26** (SPAN v1 API removal 2026-12-31),
decided with Nico. Resume at Task 3 when #26 is done; nothing in Tasks 3–9 changes.

**Goal:** Fix the EV charging totals the weekly email's 12-month trend relies on, then ship `/trends`: monthly/weekly/yearly stacked bars of energy by purpose with a ranked "Where it went" panel.

**Architecture:** Part 1 is a diagnosis-first debugging task on the Pi's energy sources, then a fix wherever the evidence points. Part 2 adds pure, tested period/URL/layer logic in `web/lib/`, a server route that fans out one cached energy query per period (reusing `cachedQueryEnergyByCategory`, plus small `hvac_mode` and `bath_event` sums), and a client page with a hand-rolled SVG stacked bar chart and the ranked panel.

**Tech Stack:** Next.js 16 (App Router) + TypeScript + Tailwind in `web/`, vitest, InfluxDB 2 / Flux via `@influxdata/influxdb-client`; Python 3 on the Pi for Part 1 if the fix lands there.

**Spec:** `docs/superpowers/specs/2026-10-26-trends-view-design.md` (read it first; it carries the evidence, the decisions, and the calls marked *my call*). Mock: https://claude.ai/artifact/JKDbAiezV8iBpxERiWomic (tab B).

## Global Constraints

- Next.js 16: read `web/AGENTS.md` and the relevant guide in `web/node_modules/next/dist/docs/` before writing route or page code. APIs differ from training data.
- UTC at rest, Pacific (`America/Los_Angeles`) on display. Never bucket dates with `toISOString().slice(0,10)`; use the `pacificWall` / `pacificMidnightUtc` helpers in `web/lib/energyWindow.ts`.
- Reader-facing strings go in `web/lib/trendsCopy.ts`, not inline in components.
- Never read `.env*` files. `web/.env.local` already exists for local dev (`cd web && npm run dev`, see `docs/web-deploy.md` § Local dev).
- Energy source for circuit categories: `circuit_1h.energy_wh_counter` via the existing `cachedQueryEnergyByCategory` (unless Task 2 changes it).
- Dollars: `costForKwh` + `proratedBaseCharge` from `web/lib/rates.ts` (flat $0.1241/kWh, $0.83/day).
- Constants: data start `2025-12-26` Pacific; HVAC split start `2026-01-04` Pacific.
- Tests: `cd web && npm test`. Chart/React wiring is manual-verify.
- `/api/health` untouched. Cloudflare Bot Fight Mode stays off.
- Deploy = push to `main` (Vercel Git integration). Pi changes: check the Pi checkout's branch first (`ssh nico@phrpi.local 'cd ~/SPAN && git status -sb'`) and add a Dockerfile `COPY` line for any new `pi/*.py`.

## Review Focus

1. **DST months/weeks** (Mar 8 2026, Nov 1 2026): period bounds must be Pacific midnights, and a 23h/25h day must not drop or duplicate a bar → tests in Task 3.
2. **A period straddling the HVAC split start** (Jan 2026, year 2026): the pre-split days must land in "HVAC (not split)" and the rest in the split layers, adding to the HVAC circuit total → tests in Task 5 and the split query in Task 6.
3. **`hvac_mode` sums exceed the HVAC circuit total** (integral vs counter disagreement): unclassified clamps to 0, layers still sum to the house total within the residual, residual reported → test in Task 5.
4. **Stale or hand-typed URLs** (`sel` older than the default window, `end` in the future, garbage keys, `sel` for the wrong grain): fall back to sensible defaults, never a 500 or empty page → tests in Task 4.
5. **The period still in progress, and the partial first period** (Oct 2026 "so far", Dec 2025 starting the 26th): labeled as such, `toMs` clamped to now, never read as a real dip → tests in Task 3.

---

## Part 1 — EV accuracy

### Task 1: Diagnose the EV discrepancy (no code changes)

**Files:**
- Create: `docs/superpowers/notes/2026-10-27-ev-accuracy-findings.md`

**Interfaces:**
- Produces: a findings note naming the correct source for the charger circuit's energy, the cause of the October counter/integral split and of `charge_event` under-coverage, and a proposed fix. Task 2 implements it.

- [ ] **Step 1: Load `superpowers:systematic-debugging`** and follow it for this task.

- [ ] **Step 2: Reproduce the spec's numbers.** On the Pi (`ssh nico@phrpi.local`, `docker exec influxdb influx query '…'`), for circuit `Outdoor / Tesla Car Charger`, get daily Pacific totals Sep 1 → today of `circuit_1h.energy_wh_counter` and `circuit_1h.energy_wh`. Expected: they agree to ~0.5% through September and diverge in October (month totals 127 vs 53 kWh as of Oct 26). Note: `aggregateWindow` stamps windows at their stop; use `timeSrc: "_start"` when reading.

- [ ] **Step 3: Find the diverging days and inspect raw data.** For the 2–3 worst days, pull raw 30s `circuit` `power_w` and the raw cumulative counter field for that circuit (check `pi/collector.py` for its field name) and plot or tabulate them. Decide between: pulsed draw the 30s poll misses; a counter jump/reset; real non-session draw; something else.

- [ ] **Step 4: Check `charge_detector` coverage.** List `charge_event` points for Sep–Oct against the days the circuit counter shows >2 kWh. Read `pi/charge_detector.py` thresholds and explain each missed day.

- [ ] **Step 5: Ask Nico for ground truth.** Ask for the Tesla app's charging history (kWh per session or per day) for 4–6 recent home-charging days, including at least one October day. Compare it with each source.

- [ ] **Step 6: Check whether Unmonitored is affected.** If Step 3 shows the integral misses charger pulses, compare `integral(panel.grid_power_w)` with the panel's own counter (`consumed_energy_wh`, written by `pi/collector.py` ~line 72) per month. Record the size of the difference.

- [ ] **Step 7: Write the findings note** (evidence tables, cause, chosen source of truth, proposed fix, whether Unmonitored changes) and commit it.

```bash
git add docs/superpowers/notes/2026-10-27-ev-accuracy-findings.md
git commit -m "docs: EV accuracy findings (12-month trend)"
```

- [ ] **Step 8: STOP and report to Nico.** Summarize the cause and the proposed fix; wait for his go-ahead before Task 2.

### Task 2: Fix the EV source (shape set by Task 1)

**Files:** set by Task 1's findings: one or more of `pi/charge_detector.py`, the rollup task / `pi/backfill_rollups.py`, `pi/daily_report.py` energy helpers, `web/lib/influx.ts` (`queryPanelKwh` if Unmonitored moves to the panel counter), with tests beside them (`pi/test_*.py`, `web/lib/*.test.ts`).

**Interfaces:**
- Produces: the charger circuit's period energy (what `cachedQueryEnergyByCategory` returns as `Car`, and what `daily_report.py`'s `query_daily_circuit_counter_kwh` sums) matching Nico's Tesla-app days within 5%. The Car layer stays "energy through the charger circuit" (spec).

- [ ] **Step 1: Write a failing test** that encodes the bug Task 1 found, using the real values from the findings note as fixtures (e.g. a counter series with the observed jump, or a session the detector missed).
- [ ] **Step 2: Run it and confirm it fails** (`cd pi && python -m pytest <test> -v` or `cd web && npx vitest run <test>`).
- [ ] **Step 3: Implement the fix** named in the findings note.
- [ ] **Step 4: Run the full suites** (`cd pi && python -m pytest`, `cd web && npm test`). Expected: all pass.
- [ ] **Step 5: Deploy and backfill if needed.** Pi: pull on the Pi, rebuild the affected service, re-run any backfill the fix needs. Web: push.
- [ ] **Step 6: Verify against ground truth.** Re-run Task 1 Step 2's query; the Tesla-app days are within 5%. If Unmonitored changed, record before/after month totals in the findings note.
- [ ] **Step 7: Commit, then report before/after numbers to Nico.**

---

## Part 2 — `/trends`

### Task 3: Period list for a grain

**Files:**
- Modify: `web/lib/energyWindow.ts` (export the existing private `periodBoundsFor` as `periodBounds`; no behavior change)
- Create: `web/lib/trends.ts`, `web/lib/trends.test.ts`

**Interfaces:**
- Produces:
  - `type TrendGrain = "week" | "month" | "year"`
  - `const DATA_START_MS: number` (Pacific midnight 2025-12-26), `const HVAC_SPLIT_START_MS: number` (Pacific midnight 2026-01-04)
  - `type TrendPeriod = { key: string; fromMs: number; toMs: number; complete: boolean; partialStart: boolean }`. `fromMs` is clamped up to `DATA_START_MS`, `toMs` down to `nowMs`; `partialStart` is true when `fromMs` was clamped.
  - `periodKey(fromMs: number, grain: TrendGrain): string`: month `YYYY-MM`, week = Monday `YYYY-MM-DD`, year `YYYY` (Pacific calendar).
  - `parsePeriodKey(key: string, grain: TrendGrain): { fromMs: number; toMs: number } | null`
  - `trendPeriods(opts: { grain: TrendGrain; endKey?: string | null; nowMs: number }): TrendPeriod[]`: oldest first; 13 periods ending at `endKey` (default: the period containing now; an `endKey` after the current period clamps to it) for week/month; every year from 2025 to now for year; periods entirely before `DATA_START_MS` are dropped.
  - `shiftEndKey(endKey: string, grain: TrendGrain, periods: number, nowMs: number): string`: for the prev/next arrows (±13), clamped to the current period.

- [ ] **Step 1: Write the failing tests** in `web/lib/trends.test.ts`. Use `nowMs = Date.parse("2026-10-26T19:00:00-07:00")`:
  - `trendPeriods({grain:"month", nowMs})` has 11 entries; keys run `2025-12` … `2026-10`; first has `partialStart: true` and `fromMs === DATA_START_MS`; last has `complete: false` and `toMs === nowMs`; every other entry is `complete: true`.
  - `trendPeriods({grain:"month", endKey:"2026-09", nowMs})` ends at `2026-09` with `complete: true`, 10 entries.
  - `trendPeriods({grain:"month", endKey:"2027-03", nowMs})` equals the default.
  - `trendPeriods({grain:"week", nowMs})` has 13 entries, last key `2026-10-26`, each `fromMs` a Pacific Monday midnight; with `nowMs = Date.parse("2026-11-10T12:00:00-08:00")`, the period keyed `2026-10-26` (contains the 2026-11-01 DST end) spans 169h.
  - Month `2026-03` spans 743h (DST start); `2026-11` spans 721h.
  - `trendPeriods({grain:"year", nowMs})` keys `["2025","2026"]`, the 2025 one with `partialStart: true`.
  - `parsePeriodKey("2026-13","month")`, `parsePeriodKey("2026-10-27","week")` (a Tuesday), `parsePeriodKey("abc","year")` all return `null`.
  - `shiftEndKey("2026-10","month",-13,nowMs) === "2025-09"`; `shiftEndKey("2026-09","month",13,nowMs) === "2026-10"`.
- [ ] **Step 2: Run** `cd web && npx vitest run lib/trends.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** in `web/lib/trends.ts` on top of `periodBounds`; step periods by `periodBounds(prev.fromMs - 1, grain)` so DST is handled by the existing helper.
- [ ] **Step 4: Run** `cd web && npm test`. Expected: all pass, including the untouched `energyWindow.test.ts`.
- [ ] **Step 5: Commit** `feat(web): trend period list for week/month/year grains`.

### Task 4: `/trends` URL state

**Files:**
- Create: `web/lib/trendsUrl.ts`, `web/lib/trendsUrl.test.ts`

**Interfaces:**
- Consumes: `TrendGrain`, `parsePeriodKey`, `trendPeriods` (Task 3).
- Produces:
  - `type TrendsState = { grain: TrendGrain; endKey: string | null; selKey: string | null }`
  - `parseTrendsState(params: Record<string, string | string[] | undefined>, nowMs: number): TrendsState`
  - `buildTrendsSearch(s: TrendsState): string`: no leading `?`; omits `grain=month` and null keys; param order `grain`, `end`, `sel`.

- [ ] **Step 1: Write the failing tests:**
  - `{}` → `{grain:"month", endKey:null, selKey:null}`.
  - `{grain:"bogus"}` → grain `month`; `{grain:"week", end:"2026-10-27"}` (not a Monday) → `endKey: null`.
  - `{sel:"2026-09"}` → `selKey:"2026-09"`, `endKey:null` (inside the default window).
  - `{sel:"2026-02"}` with `nowMs` in 2027-06 (outside that default window) → `endKey:"2026-02"`.
  - `{sel:"2026-10-26"}` with grain `month` → `selKey:null`.
  - `{end:"2026-09", sel:"2026-11"}` (sel outside the window ending at `end`) → `selKey:null`.
  - Round trip: `buildTrendsSearch(parseTrendsState(p, now))` for `grain=week&end=2026-10-19&sel=2026-10-12` returns the same string; default state builds `""`.
- [ ] **Step 2: Run** `cd web && npx vitest run lib/trendsUrl.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `web/lib/trendsUrl.ts`.
- [ ] **Step 4: Run** `cd web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): /trends intent URL parse/build`.

### Task 5: Stack layers from a period's energy

**Files:**
- Create: `web/lib/trendLayers.ts`, `web/lib/trendLayers.test.ts`

**Interfaces:**
- Produces:
  - `type PeriodEnergy = { categories: Record<string, number>; preSplitHvacKwh: number; modes: { heat: number; cool: number; hotWater: number; idle: number; ambiguous: number }; bathKwh: number }`. `categories` holds the top-level rows from `cachedQueryEnergyByCategory` for the **split** part of the period (keys `HVAC`, `Car`, `Lights`, `Appliances`, `Else`, `Unmonitored`), plus non-HVAC energy from the pre-split part already added in. `preSplitHvacKwh` is the HVAC circuit kWh before `HVAC_SPLIT_START_MS`.
  - `type TrendLayers = { hvacUnsplit: number; heat: number; cool: number; hotWater: number; hvacOther: number; car: number; lights: number; appliances: number; rest: number; detail: { standby: number; unclassified: number; bath: number; other: number; unmonitored: number }; totalKwh: number; residualKwh: number }`
  - `deriveLayers(e: PeriodEnergy): TrendLayers`
  - `const LAYER_ORDER = ["hvacUnsplit","heat","cool","hotWater","hvacOther","car","lights","appliances","rest"] as const` (bottom → top)

  Rules: `unclassified = max(0, HVAC − heat − cool − hotWater − idle)`; `hvacOther = idle + unclassified`; `rest = Else + Unmonitored`; `residualKwh = HVAC − (heat + cool + hotWater + idle + ambiguous)` (signed, for logging); `totalKwh` = sum of all layers; `bath = min(bathKwh, hotWater)`.

- [ ] **Step 1: Write the failing tests:**
  - Typical month (`HVAC 300, heat 150, cool 0, hotWater 100, idle 20, ambiguous 25`): `unclassified 30`, `hvacOther 50`, `residualKwh 5`, layers sum to `totalKwh` = HVAC + Car + Lights + Appliances + Else + Unmonitored.
  - Modes exceed the circuit (`HVAC 100`, `heat 90, hotWater 20, idle 5`): `unclassified 0`, `residualKwh -15`, `heat`/`hotWater` unchanged.
  - Pre-split month (`preSplitHvacKwh 400`, every mode 0, `HVAC 0`): `hvacUnsplit 400`, every split layer 0.
  - Straddling month (`preSplitHvacKwh 40`, `HVAC 260`, heat + cool + hotWater + idle = 250): `hvacUnsplit 40`, and the HVAC layers sum to 300.
  - `bathKwh 12, hotWater 8` → `detail.bath 8`.
- [ ] **Step 2: Run** `cd web && npx vitest run lib/trendLayers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `web/lib/trendLayers.ts`.
- [ ] **Step 4: Run** `cd web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): derive trend stack layers from period energy`.

### Task 6: Per-period queries + `/api/trends`

**Files:**
- Modify: `web/lib/influx.ts` (factor the field-sum query out of `queryHvacModeRows` into `queryHvacModeFieldSums`, add the idle and ambiguous fields; add `queryBathKwh`)
- Modify: `web/lib/queryCache.ts` (add `cachedQueryTrendPeriod`)
- Create: `web/lib/trendsQuery.ts`, `web/app/api/trends/route.ts`

**Interfaces:**
- Consumes: `cachedQueryEnergyByCategory`, `TrendPeriod`, `trendPeriods`, `HVAC_SPLIT_START_MS`, `deriveLayers`, `PeriodEnergy`, `TrendLayers`, `parseTrendsState`.
- Produces:
  - `queryHvacModeFieldSums(fromMs: number, toMs: number): Promise<Record<string, number>>` (keys `energy_<mode>_kwh` for heat, cool, hot_water, idle, ambiguous). `queryHvacModeRows` keeps its output by calling it.
  - `queryBathKwh(fromMs: number, toMs: number): Promise<number>`: sum of `bath_event.energy_kwh` with event start in `[fromMs, toMs)`.
  - `queryPeriodEnergy(p: { fromMs: number; toMs: number }): Promise<PeriodEnergy>` in `trendsQuery.ts`. When the period straddles `HVAC_SPLIT_START_MS`, it calls `cachedQueryEnergyByCategory` once per side: HVAC from the pre side becomes `preSplitHvacKwh`, other categories add together. Modes and baths are queried over the split side only.
  - `cachedQueryTrendPeriod(p: TrendPeriod): Promise<PeriodEnergy>`: same LRU/in-flight pattern as `cachedQueryEnergyByCategory`; TTL 24h when `p.complete`, 60s otherwise.
  - `GET /api/trends?grain=&end=` → `{ periods: Array<TrendPeriod & { layers: TrendLayers }> }`; 400 on a grain outside `week|month|year`; an invalid `end` falls back to default. `Cache-Control` as in `app/api/energy/route.ts` (max-age 60 if the last period is incomplete, else 86400). Log `residualKwh` per period when `|residual| > 0.05 × HVAC`.

- [ ] **Step 1: Refactor `queryHvacModeRows` onto `queryHvacModeFieldSums`** and run `cd web && npm test`. Expected: PASS (no behavior change).
- [ ] **Step 2: Implement `queryBathKwh`, `queryPeriodEnergy`, `cachedQueryTrendPeriod`, and the route.** Fetch all periods with `Promise.all`.
- [ ] **Step 3: Manual verify against local dev.** Run `cd web && npm run dev`, then:
  - `curl -s 'http://localhost:3000/api/trends' | jq '.periods | length, .[0].key, .[-1].complete'`. Expected: `11`, `"2025-12"`, `false`.
  - `curl -s 'http://localhost:3000/api/trends?grain=bogus' -o /dev/null -w '%{http_code}'`. Expected: `400`.
  - Spot-check one complete month: its layer sum matches the explorer breakdown table's total for that month (kWh) within 1%.
  - The 2026-01 period has `hvacUnsplit > 0` and split layers > 0.
- [ ] **Step 4: Note the cold-load time** for the default view (13 parallel period queries). If it's over ~10s, report it rather than restructuring.
- [ ] **Step 5: Commit** `feat(web): /api/trends per-period energy by purpose`.

### Task 7: Copy, palette, and the stacked chart

**Files:**
- Create: `web/lib/trendsCopy.ts`, `web/components/TrendsChart.tsx`
- Modify: `web/app/globals.css` (series color tokens, light + dark)

**Interfaces:**
- Consumes: `TrendPeriod`, `TrendLayers`, `LAYER_ORDER`.
- Produces:
  - `trendsCopy.ts`: layer labels (`hvacUnsplit: "HVAC (not split)"`, `heat: "Heating"`, `cool: "Cooling"`, `hotWater: "Hot water"`, `hvacOther: "HVAC standby + unclassified"`, `car: "Car charging"`, `lights: "Lights"`, `appliances: "Appliances"`, `rest: "Other + unmonitored"`), panel row labels (spec § "Where it went"), `periodLabel(p: TrendPeriod, grain: TrendGrain): string` (e.g. "Sep 2026", "Oct 2026 so far", "Dec 26–31", "Week of Oct 19"), the shower note "showers not detected yet", and the base-charge label.
  - `<TrendsChart periods={…} grain={…} unit={"kwh"|"usd"} selKey={string|null} onSelect={(key: string|null) => void} />`.
- Colors: the spec's table (light/dark hex per layer). `hvacUnsplit` light `#7d8580`, dark `#8a928d`. `hvacOther` is a 45° hatch of the neutral pair. Define each as a CSS custom property in `globals.css` with the dark values under the existing dark-mode block.

- [ ] **Step 1: Validate the `hvacUnsplit` color** against its neighbor `heat`. Run the dataviz skill's validator, e.g. `node <dataviz-skill-dir>/scripts/validate_palette.js "#7d8580,#eb6834" --mode light`, and the same with the dark values. Expected: no FAIL. If it fails, step the neutral lighter or darker until it passes and update the spec table.
- [ ] **Step 2: Write `trendsCopy.ts`**, with a unit test for `periodLabel` covering the five label forms above (`web/lib/trendsCopy.test.ts`). Run `cd web && npx vitest run lib/trendsCopy.test.ts`; expected PASS after implementation.
- [ ] **Step 3: Build `TrendsChart`** as hand-rolled SVG, following the mock:
  - y axis with 4 gridlines and kWh or $ ticks; 2px surface-colored gaps between segments; top segment rounded.
  - Bars of partial periods marked: an asterisk label with a footnote.
  - Hover tooltip listing every layer, top to bottom, plus the total; in $ mode it adds the period's base charge.
  - Click selects; clicking again clears. Unselected bars dim to 35% while one is selected.
  - Legend above, always shown.
- [ ] **Step 4: Commit** `feat(web): trends stacked chart + copy + palette`.

### Task 8: `/trends` page, "Where it went" panel, navigation

**Files:**
- Create: `web/app/trends/page.tsx`, `web/components/TrendsClient.tsx`, `web/components/WhereItWent.tsx`
- Modify: `web/components/ExplorerClient.tsx:172-173` (header: add a "Trends" link)

**Interfaces:**
- Consumes: everything above; `costForKwh`, `proratedBaseCharge`.
- Produces: the page. `page.tsx` SSRs the default/URL state's periods (via `queryPeriodEnergy` through the cache, the same way `app/page.tsx` SSRs the breakdown). `TrendsClient` owns `{grain, endKey, selKey, unit}`, syncs the URL with `history.replaceState(buildTrendsSearch(state))`, and refetches `/api/trends` on grain/end change (simple in-memory map keyed by `grain|end`).

- [ ] **Step 1: Build `WhereItWent`.** Props: `{ periods, selKey, unit, grain }`. If `selKey` is set it ranks that period, otherwise the sum over all shown periods.
  - Rows sorted by kWh: Heating, Cooling, Hot water (sub-line: baths kWh · showers not detected yet), Unclassified HVAC, HVAC standby, Car charging, Lights, Appliances, Other circuits, Unmonitored, plus HVAC (not split) when it's non-zero. Each row has kWh or $, %, and a bar in the layer color.
  - $ mode adds a "Base charge" row (`proratedBaseCharge(toMs − fromMs)` summed over the ranked periods); % in $ mode includes it.
  - The header names the period, using `periodLabel` or a range label.
  - An "Open in explorer" link to `/?from=<fromMs>&to=<toMs>` for the ranked span.
- [ ] **Step 2: Build `TrendsClient` and `page.tsx`.**
  - Controls row: grain switch (Months / Weeks / Years), prev/next arrows using `shiftEndKey` (next disabled at the current period), kWh/$ switch, and a link back to the explorer.
  - Layout: chart and panel side by side at ≥760px, stacked below that.
- [ ] **Step 3: Add the "Trends" link** in the explorer header.
- [ ] **Step 4: Run** `cd web && npm test && npm run build`. Expected: tests pass, build succeeds.
- [ ] **Step 5: Manual verify on local dev** at http://localhost:3000/trends:
  - The default shows Dec 2025 … Oct 2026, with Oct marked "so far" and Dec labeled "Dec 26–31".
  - Clicking Sep sets the URL to `?sel=2026-09`; reloading keeps Sep ranked.
  - Weeks shows 13 Monday-start bars; Years shows 2025 and 2026.
  - $ mode shows the Base charge row.
  - Dark mode is legible.
  - At phone width (≈400px) the page doesn't scroll horizontally and the panel sits below the chart.
- [ ] **Step 6: Commit** `feat(web): /trends page with Where-it-went panel`.

### Task 9: Ship, smoke-test, document

**Files:**
- Modify: `CLAUDE.md` (web/ section: a `/trends` bullet describing the data path, layer rules, URL format, and spec link; Next Steps: email deep-links now have URLs to target)

- [ ] **Step 1: Push to `main`.** Then confirm the Vercel deploy succeeded (`vercel ls` or the dashboard).
- [ ] **Step 2: Give Nico a self-contained smoke test:**
  - URL: https://span.pianohouseproject.org/trends.
  - Steps: load the page, hover a bar, click Sep, toggle $, switch to Weeks, follow "Open in explorer".
  - Pass: every step behaves as in Task 8 Step 5, and the Sep total matches the explorer's Sep breakdown.
  - Fail: any blank chart, a 5xx, or a mismatch over 1%.
- [ ] **Step 3: Check** `curl -s -o /dev/null -w '%{http_code}' https://span.pianohouseproject.org/api/health`. Expected: `200`.
- [ ] **Step 4: Update `CLAUDE.md` and commit** `docs: /trends in CLAUDE.md`.
