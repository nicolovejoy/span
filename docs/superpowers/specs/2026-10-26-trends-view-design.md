# Trends view (energy by purpose over time) + EV accuracy — design

Date: 2026-10-26. Status: approved in conversation (Nico picked mock B, "all that sounds great").
Mock: https://claude.ai/artifact/JKDbAiezV8iBpxERiWomic (tab "B · Stacked months"; example numbers only).

## Why

Nico wants to see how much energy goes to each purpose over time (heating, cooling, hot
water, car charging, lights, appliances, everything else), and the total by purpose for any
period, including the HVAC guesses we already make (heat / cool / hot water / baths) and the
HVAC energy we *can't* classify. The power explorer answers "what happened in this window";
nothing answers "how does this month compare with the last twelve, by purpose".

Separately, he asked that the weekly email's 12-month trend carry accurate EV charging data.
The trends view sums EV the same way that chart does, so the two are fixed together, EV first.

## Scope

Two parts, in order:

1. **EV accuracy diagnosis + fix** (prerequisite). Diagnose before touching code.
2. **`/trends` page** — mock B, built for real.

Out of scope here (later, separate spec): dashboard links in the anomaly/weekly emails, and the
heat/cool/hot-water section in the weekly email (Nico's items 1–3). Part 2 deliberately
provides the deep-linkable URLs those items will point at.

## Part 1 — EV accuracy

**Note on #15.** #15 (make `energy_wh_counter` authoritative) is **closed and shipped**
(commit 6ab1c56, 2026-08-23). The weekly report and the web energy path already sum
`circuit_1h.energy_wh_counter`. This part is new work, not #15.

**Evidence gathered 2026-10-26** (Influx on the Pi, charger circuit `Outdoor / Tesla Car Charger`,
Pacific calendar months):

- Circuit counter (`circuit_1h.energy_wh_counter`), kWh: Jan 185 · Feb 225 · Mar 235 · Apr 171 ·
  May 171 · Jun 364 · Jul 181 · Aug 182 · Sep 208 · Oct (to 26th) 127.
- Integral field (`circuit_1h.energy_wh`): matches the counter within ~0.5% every month
  **except October: 53 vs 127**.
- `charge_event.energy_kwh` summed by month: May 33 · Jun 193 · Jul 70 · Aug 79 · Sep 92 ·
  Oct 34 — roughly 40–50% of the circuit total in most months.
- `status.sh` reports no `charge_event` in the last 14 days, yet the circuit counter shows real
  energy in that span.

So three sources disagree, and October's counter/integral split is new. Hypotheses to test,
not conclusions: the charger draws in pulses the 30s integral misses (the #15 rationale) and
something changed in October; `charge_detector` thresholds miss slow/short sessions; a counter
anomaly (panel reset or backward correction) inflated October; non-charging draw on the circuit.

**Work:**
- Use `superpowers:systematic-debugging`. Compare daily counter vs integral vs raw power for the
  charger circuit across October; find the days that diverge and look at raw 30s `power_w` there.
- Establish which source is right. Nico can supply ground truth (Tesla app charging history
  for a few sessions/days); ask for it rather than guess.
- Fix where the error is: the rollup, the counter handling, `charge_detector`, or the report.
  Report the finding and the fix to Nico before moving on to Part 2.
- Acceptance: for a set of days Nico confirms against the Tesla app, the source the
  weekly email and `/trends` use is within 5%.
- **Unmonitored may be affected too** *(my call)*: Unmonitored = panel `integral(grid_power_w)` −
  summed circuit counters. If the diagnosis shows the integral misses charger pulses, the panel
  integral misses them as well, understating Unmonitored. In that case Part 1 may switch the
  panel side to the panel's own counter (`consumed_energy_wh`, written by `pi/collector.py`)
  everywhere it's used (explorer breakdown, weekly email, `/trends`), with before/after numbers
  for a few months reported to Nico. If the evidence doesn't show it, leave it alone.
- The **Car layer stays "energy through the charger circuit"** whatever Part 1 finds *(my call)*;
  `charge_event` describes sessions and is not a substitute total. Part 1 fixes the accuracy of
  that circuit total (and the detector, if it's missing sessions).

## Part 2 — `/trends` page

### What it is

A new page beside the explorer. A stacked bar chart, one bar per Pacific calendar period, plus a
"Where it went" panel ranking every purpose for the selected range or the clicked bar.

### Decided (with Nico)

- Form: mock B. Stacked bars + "Where it went" ranked panel beside it (stacks below on phone).
- Bars are **named Pacific calendar periods**, never sliding windows. A period still in progress
  is labeled "so far" (same convention as the explorer breakdown table, `web/lib/energyWindow.ts`).
- Grain: **months** by default; **weeks** (Monday start) and **years** selectable.
- Default range: trailing 12 complete months + the current month so far (13 bars), matching the
  weekly email's 12-month trend.
- **Range per grain** *(my call)*: months and weeks show 13 bars ending at an anchor period;
  years show every year since collection began. The anchor defaults to the current period.
  Prev / next arrows move the anchor back or forward 13 periods (never past the current one).
- **Data start** *(my call)*: leading periods with no data are trimmed, so no empty slots.
  A bar covering only part of its period because collection started mid-period is labeled
  with its real span ("Dec 26–31", "2025 · Dec 26–31").
- Click a bar → the panel ranks that period; click again → back to the whole range.
- kWh / $ toggle.
- Its own route (`/trends`), not a mode inside the explorer.

### Stack layers (bottom → top) and colors

Eight layers, in this order (the order is what keeps adjacent colors distinguishable for
color-blind viewers — validated with the dataviz skill's `validate_palette.js`, adjacent pairs):

| Layer | Light | Dark |
|---|---|---|
| Heating | `#eb6834` | `#d95926` |
| Cooling | `#2a78d6` | `#3987e5` |
| Hot water | `#e87ba4` | `#d55181` |
| HVAC standby + unclassified (hatched neutral) | `#a6aca8` on `#cfd4d1` | `#6e7671` on `#454c48` |
| Car charging | `#1baf7a` | `#199e70` |
| Lights | `#eda100` | `#c98500` |
| Appliances | `#6250d6` | `#9085e9` |
| Other + unmonitored (neutral) | `#cfd4d1` | `#454c48` |

Legend always shown. Hover tooltip per bar lists every layer's value.

### "Where it went" panel rows

Ranked by kWh, each with kWh (or $), % of total, and a bar:
Heating · Cooling · Hot water (sub-line: "baths X · showers not detected yet") · Unclassified
HVAC · HVAC standby · Car charging · Lights · Appliances · Other circuits · Unmonitored.
Header names the period ("Where it went · Sep 2026", "· Oct 2026 so far", "· Oct 2025–Oct 2026").

### Data definitions

Per period:

- **Circuit categories** (HVAC, Car, Lights, Appliances, Else): `circuit_1h.energy_wh_counter`
  summed per circuit, bucketed by `pi/categories.json` (via `web/lib/categories.ts`) — the same
  source and grouping the explorer breakdown and weekly email use. After Part 1 lands, Car uses
  whatever source Part 1 settles on.
- **Unmonitored**: panel grid kWh − sum of circuits, as `queryEnergyByCategory` already does
  (`unmonitoredKwh`).
- **Heating / Cooling / Hot water / Standby / Ambiguous**: sums of `hvac_mode` fields
  `energy_heat_kwh`, `energy_cool_kwh`, `energy_hot_water_kwh`, `energy_idle_kwh`,
  `energy_ambiguous_kwh` within the period.
- **Unclassified HVAC** = HVAC circuit total − (heat + cool + hot water + standby), clamped ≥ 0.
  This makes the layers add up to the HVAC circuit total (and the stack to the whole house): it
  absorbs `ambiguous` plus any difference between `hvac_mode`'s integral-based energy and the
  circuit counter. *My call; the builder should log the size of that residual on real months and
  flag it if it's more than a few percent of HVAC.*
- **Baths**: `bath_event.energy_kwh` summed by event start time within the period, shown only as
  a sub-line of Hot water (never its own stack layer). Other hot water is not shown separately.
- **Showers**: not detected yet; the sub-line says so. When a shower predicate lands in
  `attribution.py`, it gets a sub-line too.
- **Before 2026-01-04** (start of the `hvac_mode` timeline): no split exists. HVAC is drawn as a
  single layer labeled "HVAC (not split)" and the panel shows one HVAC row. A period that
  straddles the start date counts as split from 2026-01-04 on, unsplit before. *My call:*
  "HVAC (not split)" is a solid mid-neutral (light `#7d8580`, dark `#8a928d`), drawn as the
  bottom layer, visually distinct from the standby/unclassified hatch; run
  `validate_palette.js` on it against its neighbors and adjust the step if it fails. Only
  Dec 2025 and Jan 2026 (and the 2025/2026 year bars) are affected.
- **Before 2025-12-26** (collection start): no bar.
- **Dollars**: kWh × the flat rate in `web/lib/rates.ts` (`costForKwh`). Seattle City Light is
  flat-rate (no TOU, `pi/rates.py`). *Known small error, accepted: pre-April 2026 was $0.1291,
  not $0.1241.* *My call:* in $ mode the panel adds a **"Base charge"** row
  (`proratedBaseCharge` for the period, as the explorer's breakdown table does) so a month's
  $ total matches the explorer and the bill. It's a panel row and a tooltip line, not a stack
  layer; "% of total" in $ mode includes it.

### Behavior

- SSR the default view for fast first paint; client handles grain switches and bar selection.
- Intent URL *(my call on the format)*: `/trends?grain=month&end=2026-09&sel=2026-09`.
  `grain` = `month|week|year` (default `month`, omitted); `end` = anchor period (default current,
  omitted); `sel` = selected bar. Period keys: month `YYYY-MM`, week = the Monday `YYYY-MM-DD`,
  year `YYYY`. A `sel` without `end` sets `end = sel` when `sel` is older than the default
  window, so a link to a given period keeps working forever. These are the URLs the future email
  links will use; keep parse/build pure and tested.
- Each bar's tooltip / the panel header offers "Open in explorer" → the explorer with that
  period's window (`/` with `from`/`to`, which `web/lib/url-state.ts` already parses).
- Explorer header gets a "Trends" link; `/trends` links back.
- Server-side cache like the existing energy routes (`lib/queryCache` LRU); completed periods
  never change, so they can be cached long.

### Constraints

- Next.js 16 in `web/` — **read `web/AGENTS.md` and the guides in `node_modules/next/dist/docs/`
  before writing code**; APIs differ from training data.
- UTC at rest, Pacific on display; never bucket with `toISOString().slice(0,10)`.
- Reader-facing strings in a copy module, not inline (shared convention).
- `/api/health` untouched. Bot Fight Mode stays off.
- Pure logic (period bucketing, layer derivation, residual clamp, URL parse/build) in `web/lib/`
  with vitest tests, following `energyWindow.ts` / `eventRuns.ts`. Chart wiring is manual-verify.

### Left to the builder

Chart implementation (hand-rolled SVG as in the mock, or the existing chart library if it does
stacked bars cleanly), API route shape, Flux query structure, and whether week/year use separate
queries or derive from daily sums.

### Non-goals

- Replacing or changing the explorer chart.
- Email changes (later spec).
- Shower detection (separate small task in `attribution.py`).
- Harmonizing the explorer's existing category colors with this palette.
