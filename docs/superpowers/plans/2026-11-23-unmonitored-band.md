# Unmonitored Chart Band Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unmonitored (the overflow subpanel: washer, dryer, garage, attic, recirc pump…) becomes a sixth stacked band on the Power Explorer chart, at the top of the stack, so ticking only Unmonitored shows its usage over time instead of an empty chart.

**Architecture:** `/api/power` (category view only, never a drill) also reads `panel.grid_power_w`, bucket mean per display bucket over the same segments as the circuit query, and appends one more series, `Unmonitored` = `max(0, grid − Σ five category means)` per bucket (pure `web/lib/unmonitoredSeries.ts`). It rides the existing payload, so it goes through `queryRows` (retry), `lib/queryCache`, the HTTP cache and `lib/clientFetch` with no new request. On the client a new `BAND_ORDER` (the five categories, then Unmonitored) drives the chart's series and stack; every circuit code path keeps `CATEGORY_ORDER`, so Unmonitored never gets a drill.

**Tech Stack:** Next.js 16 / React 19, TypeScript, Tailwind 4, lightweight-charts 5.2.0, vitest 4, Flux (InfluxDB 2).

**Spec:** the brief for this plan (restated under Global Constraints and Decisions); background in `CLAUDE.md` § web/ "Selection" and issue #17 (Part 1: Unmonitored is shipped as a residual, deliberately not from `feedthrough_power_w`). Builds on `docs/superpowers/plans/2026-11-23-power-explorer-circuits.md` (branch `explorer-circuits`, PR #33).

## What exists today (findings)

1. **Unmonitored kWh is a residual, not the feedthrough meter.** `queryEnergyByCategory` (`web/lib/influx.ts:425-469`) runs `queryPanelKwh` = raw `integral(unit: 1h)` of `panel.grid_power_w` over the window (`influx.ts:340-351`, no rollup exists for `panel`) and appends `{ category: "Unmonitored", kwh: unmonitoredKwh(panelKwh, circuitKwh) }`, where `unmonitoredKwh = Math.max(0, panelKwh − circuitKwh)` (`web/lib/energyWindow.ts:208`), floored once over the whole window. `circuitKwh` is the sum of the category rows: raw `integral()` of `|power_w|` for windows ≤ 48 h, `energy_wh_counter` sums from `circuit_5m` (≤ 7 d) or `circuit_1h` beyond (`web/lib/rollup.ts:148`). `/api/energy` queries the *snapped Pacific calendar period* (day/week/month/year), not the viewed window. `pi/daily_report.py` `unmonitored_kwh` (:530) is the same method (period sum of panel − circuits, floored once on the period's sum, :761-813). `/trends` reuses `cachedQueryEnergyByCategory`, so it is the same number. `feedthrough_power_w` is read by nothing in `web/` or the reports.
2. **Today's Total line is the sum of the five category series, not the whole house.** `shapeData` (`web/components/PowerChart.tsx:185-201`) sums every series in the `/api/power` payload into `totalByTime`; the payload has only the five categories. So with everything on, the stack top already equals Total, and both exclude the subpanel (~11% of energy at 30 d/90 d).
3. **The panel already treats Unmonitored as chevron-less** (`web/components/CategoryPanel.tsx:93, 111`), `partialCategories` / `categoriesNeedingCircuits` / the `expand` reducer iterate `CATEGORY_ORDER` only (`web/lib/selection.ts:41, 128`; `web/lib/viewState.ts:79`), and `/api/power?drill=Unmonitored` is rejected (`isCategory`). The colour is `UNMONITORED_COLOR = "#94a3b8"` in `web/lib/selection.ts:177`, outside the palette test in `web/lib/drill.test.ts`.

## Decisions

1. **Band definition: the same residual as the kWh row, per bucket.** `Unmonitored(t) = max(0, mean grid_power_w(t) − Σ category means(t))`, using the very category bucket means the other five bands draw. Rejected: drawing `feedthrough_power_w` directly. It is the subpanel's own meter and reconciles to only ~98% of grid − circuits (issue #17: 964 W vs 681 + 266 W), and it swings negative, so its area would not match the kWh in the panel and the stack top would not equal the panel total. The residual reconciles by construction, needs no sign handling (grid import is positive; the circuits are already `abs()`-ed), and at 30 s resolution shows the same subpanel jitter. It also contains metering slop, same as the kWh row.
2. **Computed server-side, appended to the category payload as series `"Unmonitored"`.** One payload, one cache entry, same bucket stamps; the client treats it as a sixth category. The panel query runs **per segment** with the circuit query's exact range and `aggregateWindow(every)`, always raw (no `panel` rollup). Bucket stamps match: the rollup path's `timeShift` puts `_start/_stop` back on `[seg.startMs, seg.stopMs)`, and both pipelines stamp each window at its (clamped) stop. A single whole-range panel query would mis-stamp the seam bucket.
3. **Clamped at 0 on the server**, not only when drawing, so `Total = Σ six series = max(grid, Σ categories)` per bucket = the top of the stack, exactly, with everything on.
4. **Discrepancy and how it is handled.** Band area over a period minus the panel's kWh for that period = (a) the per-bucket clamp: the kWh floors once over the period, the band floors every bucket, so the band is ≥ by Σ of the negative buckets' magnitude (expected near zero: the subpanel's baseline is ~250 W, so negative residuals need the subpanel near 0 W plus meter slop), plus (b) differences every band already has: bucket mean × width vs `integral()` (trapezoid, interpolates across gaps; missing buckets draw nothing), and for periods > 48 h the circuits' kWh comes from SPAN's cumulative counter, not the power means the chart draws (≤ 0.3% for the heat pump, CLAUDE.md § web/ /trends). Handled by: a pure test that pins (a) exactly; a manual reconciliation check (Task 4, check 8) that measures the gap for one complete day and one complete month against the Else band's own gap as a baseline; the code comment and CLAUDE.md line say "area ≥ the kWh row by the clamped buckets". No UI disclosure unless check 8 exceeds 2%. Note also that the panel shows the *snapped calendar period's* kWh, so the chart's visible window only matches it when the view is exactly that period.
5. **A panel-query failure never fails the chart.** `queryGridPower` catches (after `queryRows`' one retry), logs, and returns `[]`: the five bands draw as before, no Unmonitored band, Total = Σ five.
6. **A bucket with grid data but no category point emits no Unmonitored point** (it would show the whole house as subpanel). A bucket with categories but no grid emits none either (draws 0 via `pointsFor`).
7. **Total rule: Total shows only while nothing is off** (`off.categories` and `off.circuits` both empty). Unmonitored is drawn now, so turning it off changes the chart and Total no longer matches the stack. `showTotal(EVERYTHING)` stays true; `showTotal({categories:["Unmonitored"]})` becomes false.
8. **Order and colour.** `BAND_ORDER = [...CATEGORY_ORDER, "Unmonitored"]` in `web/lib/drill.ts` (Unmonitored on top: added first, at the back). `Unmonitored: "#94a3b8"` (slate-400) moves into `CATEGORY_COLORS` so the palette test covers it; it is not Else's `#6b7280` and not any lane colour (`ambiguous` and the Total line are `#9ca3af`, close but not equal: the dotted Total will sit on the slate band's top edge, which is where it belongs). `UNMONITORED` moves to `drill.ts` and is re-exported from `selection.ts` so existing imports keep working. `SELECTABLE` = `BAND_ORDER`, unchanged in value.
9. **Browser HTTP cache.** `/api/power` sends `public, max-age=86400` for historical windows, so a returning browser could serve a pre-deploy payload without the band for a day. `fetchSeriesCached` adds `shape=u1` to the URL (ignored by the route, bump it when the payload shape changes). The server LRU is per deployment and needs nothing. Client `TtlLru` keys are unchanged (in-memory, gone on reload).
10. **Cost.** One more Flux query per `/api/power` category request (per segment, so usually 2), run concurrently with the circuit segments. It reads one field of one tagless measurement, raw 30 s: ~2,900 rows/day scanned, ~1 M for a year-long load. The breakdown already integrates the same field raw over a calendar year for the `1y` view (`queryPanelKwh`), so this is the same order of scan. Task 4 check 9 measures it; a `panel_1h` rollup on the Pi is the fix if it is slow, out of scope here (Pi untouched).

## Global Constraints

- Work on branch `unmonitored-band` (stacked on `explorer-circuits`, PR #33) in worktree `/Users/nico/src/span-worktrees/unmonitored`. Do not push, do not merge.
- Setup once: `cd web && npm ci && npm run sync-config`. Baseline: `cd web && npx vitest run` → 348 pass, 27 files.
- No new dependencies. Lint step is `cd web && npx tsc --noEmit`.
- Pure logic in `web/lib/*.ts` with a vitest file beside it, test first. Chart/React wiring is manual-verify (Task 4).
- Reader-facing strings in `web/lib/explorerCopy.ts`.
- Never read `.env*` files, never run `vercel`, never touch the Pi.
- URL stays intent-only and unchanged in format: `off=Unmonitored` and every legacy `show=` / `drill=` link keep their meaning. No new URL params on the page.
- Every chart band gets `setData` on every `applyStack` pass (padded empty data when off), the zero floor stays, and async callbacks read the latest selection from `offRef` (patterns already in `PowerChart.tsx`).
- Unmonitored never reaches a circuit path: `partialCategories`, `categoriesNeedingCircuits`, the `expand` reducer and `/api/*?drill=` keep iterating/accepting `CATEGORY_ORDER` / `isCategory` only.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. With everything on, `Σ` of the six series at every bucket equals the Total line (no clamp mismatch). Test in Task 2 (`stack top = max(grid, Σ)`).
2. Bucket stamps of the panel query match the circuit stamps across the rollup/raw seam (no spike or dip at the seam). Flux in Task 3; manual check 11 in Task 4.
3. A drilled `/api/power` request never runs the panel query and never contains an `Unmonitored` series. Test in Task 3.
4. `showTotal` with only Unmonitored off is now false; presets: House includes it, HVAC/Car only exclude it. Tests in Task 1.
5. Panel query failure leaves the chart working. Test in Task 3.

---

### Task 1: Band order, palette and selection rules (`lib/drill.ts`, `lib/selection.ts`)

**Files:**
- Modify: `web/lib/drill.ts`, `web/lib/selection.ts:9-15, 132-142, 177-180`
- Test: `web/lib/drill.test.ts`, `web/lib/selection.test.ts`

**Interfaces:**
- Produces: `UNMONITORED = "Unmonitored"` and `BAND_ORDER` (readonly `[...CATEGORY_ORDER, "Unmonitored"]`) from `drill.ts`; `categoryColor("Unmonitored") === "#94a3b8"`; `chartCategories(off)` now lists on keys of `BAND_ORDER` (Unmonitored last); `showTotal(off)` true only when nothing is off. `selection.ts` still exports `UNMONITORED`, `SELECTABLE` (same value), `selectableColor`.

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/drill.test.ts` (change its import to `import { BAND_ORDER, CATEGORY_COLORS, CATEGORY_ORDER, categoryColor } from "./drill";`):

```ts
describe("chart bands", () => {
  it("stack the five categories, then Unmonitored on top", () => {
    expect(BAND_ORDER).toEqual([...CATEGORY_ORDER, "Unmonitored"]);
  });
  it("Unmonitored keeps its slate swatch, distinct from Else grey", () => {
    expect(categoryColor("Unmonitored")).toBe("#94a3b8");
    expect(categoryColor("Unmonitored")).not.toBe(categoryColor("Else"));
  });
});
```

(The existing "no category color is reused by a mode lane or event marker" test now also covers Unmonitored, because it iterates `CATEGORY_COLORS`.)

In `web/lib/selection.test.ts`:

1. Replace the `chartCategories` describe (:35-40) with:

```ts
describe("chartCategories", () => {
  it("lists every on band in stack order, Unmonitored last", () => {
    expect(chartCategories(EVERYTHING)).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else", "Unmonitored"]);
    expect(chartCategories({ categories: ["Car"], circuits: [] })).toEqual(["HVAC", "Lights", "Appliances", "Else", "Unmonitored"]);
    expect(chartCategories({ categories: ["Unmonitored"], circuits: [] })).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else"]);
  });
  it("only Unmonitored ticked draws only Unmonitored", () => {
    expect(chartCategories(onlyThese(["Unmonitored"]))).toEqual(["Unmonitored"]);
  });
  it("presets: House keeps Unmonitored, HVAC only and Car only drop it", () => {
    expect(chartCategories(presetOff("house"))).toEqual(["HVAC", "Lights", "Appliances", "Else", "Unmonitored"]);
    expect(chartCategories(presetOff("hvac"))).toEqual(["HVAC"]);
    expect(chartCategories(presetOff("car"))).toEqual(["Car"]);
  });
  it("legacy links: off=Unmonitored and show=… still parse to the same bands", () => {
    expect(chartCategories(parseOff("Unmonitored"))).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else"]);
    expect(chartCategories(offFromShow(["HVAC"]))).toEqual(["HVAC"]);
    expect(chartCategories(offFromShow(["HVAC", "Unmonitored"]))).toEqual(["HVAC", "Unmonitored"]);
  });
  it("Unmonitored never becomes a circuit category", () => {
    const off = toggle(EVERYTHING, "Unmonitored");
    expect(categoryState(off, "Unmonitored")).toBe("off");
    expect(partialCategories(off)).toEqual([]);
    expect(categoriesNeedingCircuits(EVERYTHING, ["Unmonitored"])).toEqual([]);
  });
});
```

2. In the `showTotal` describe (:92-107), replace the "stays shown when only Unmonitored is off" case with:

```ts
  it("is hidden when only Unmonitored is off (it is drawn now)", () => {
    expect(showTotal({ categories: ["Unmonitored"], circuits: [] })).toBe(false);
  });
```

3. In "Total hides when any circuit is off" (:222-225), change `expect(showTotal(os(["Unmonitored"]))).toBe(true);` to `.toBe(false)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/drill.test.ts lib/selection.test.ts`
Expected: FAIL (`BAND_ORDER` undefined; `chartCategories` lacks Unmonitored; `showTotal` with only Unmonitored off returns true).

- [ ] **Step 3: Implement**

`web/lib/drill.ts` (replace the header comment's second sentence and add the band order):

```ts
// The explorer's band palette and stack order. Which circuits belong to a
// category is decided by the shared regex rules in ./categories; this module
// only holds how a band looks and where it sits in the stack. Unmonitored is a
// band but not a category: it has no circuits (see lib/unmonitoredSeries).

export const UNMONITORED = "Unmonitored";

export const CATEGORY_COLORS: Record<string, string> = {
  HVAC: "#ef4444",
  Car: "#3b82f6",
  Lights: "#eab308",
  Appliances: "#8b5cf6",
  Else: "#6b7280",
  [UNMONITORED]: "#94a3b8",
};

/** The five circuit categories, bottom of the stack first. Circuit code paths
 *  (drill, partial, expand) iterate this, never BAND_ORDER. */
export const CATEGORY_ORDER = ["HVAC", "Car", "Lights", "Appliances", "Else"] as const;

/** Every chart band, bottom first: the categories, then Unmonitored on top. */
export const BAND_ORDER = [...CATEGORY_ORDER, UNMONITORED] as const;
```

`web/lib/selection.ts`:

1. Imports (:9): `import { BAND_ORDER, CATEGORY_ORDER, UNMONITORED, categoryColor } from "./drill";` and replace :13-15 with:

```ts
export { UNMONITORED };
export const SELECTABLE: readonly string[] = BAND_ORDER;
```

2. Replace `chartCategories` and `showTotal` (:135-142):

```ts
/** Bands drawn on the chart, bottom of the stack first. */
export const chartCategories = (off: OffSet): string[] =>
  BAND_ORDER.filter((c) => isOn(off, c));

/** The dotted Total line is the sum of every band (whole house), so it shows
 *  only while nothing is off. */
export const showTotal = (off: OffSet): boolean =>
  off.categories.length === 0 && off.circuits.length === 0;
```

3. Replace :177-180 with `export const selectableColor = categoryColor;` and delete `UNMONITORED_COLOR`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; 354 pass (348 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add web/lib/drill.ts web/lib/drill.test.ts web/lib/selection.ts web/lib/selection.test.ts
git commit -m "feat(web): Unmonitored is a chart band in the selection model"
```

---

### Task 2: Residual series (`lib/unmonitoredSeries.ts`)

**Files:**
- Create: `web/lib/unmonitoredSeries.ts`
- Test: `web/lib/unmonitoredSeries.test.ts`

**Interfaces:**
- Consumes: `type SeriesPoint` from `web/lib/influx.ts` (type-only import).
- Produces: `type GridPoint = { time: string; watts: number }`; `unmonitoredSeries(categories: readonly SeriesPoint[], grid: readonly GridPoint[]): SeriesPoint[]`.

- [ ] **Step 1: Write the failing tests**

`web/lib/unmonitoredSeries.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { unmonitoredSeries } from "./unmonitoredSeries";

const T1 = "2026-11-20T10:00:00Z";
const T2 = "2026-11-20T10:05:00Z";
const T3 = "2026-11-20T10:10:00Z";
const cat = (time: string, series: string, watts: number) => ({ time, series, watts });

describe("unmonitoredSeries", () => {
  it("is grid minus the sum of the categories, per bucket", () => {
    const cats = [cat(T1, "HVAC", 400), cat(T1, "Else", 300), cat(T2, "HVAC", 500)];
    const grid = [{ time: T1, watts: 960 }, { time: T2, watts: 750 }];
    expect(unmonitoredSeries(cats, grid)).toEqual([
      { time: T1, series: "Unmonitored", watts: 260 },
      { time: T2, series: "Unmonitored", watts: 250 },
    ]);
  });
  it("clamps a negative residual to 0 but keeps the point", () => {
    const out = unmonitoredSeries([cat(T1, "HVAC", 1000)], [{ time: T1, watts: 980 }]);
    expect(out).toEqual([{ time: T1, series: "Unmonitored", watts: 0 }]);
  });
  it("skips a bucket with grid data but no category point (no whole-house spike)", () => {
    const out = unmonitoredSeries([cat(T1, "HVAC", 100)], [{ time: T1, watts: 300 }, { time: T2, watts: 900 }]);
    expect(out.map((p) => p.time)).toEqual([T1]);
  });
  it("emits nothing for a bucket without grid data, or with no grid at all", () => {
    expect(unmonitoredSeries([cat(T1, "HVAC", 100), cat(T2, "HVAC", 100)], [{ time: T1, watts: 300 }]))
      .toHaveLength(1);
    expect(unmonitoredSeries([cat(T1, "HVAC", 100)], [])).toEqual([]);
  });
  it("matches buckets by instant, not by string", () => {
    const out = unmonitoredSeries([cat("2026-11-20T10:00:00.000Z", "HVAC", 100)], [{ time: T1, watts: 350 }]);
    expect(out).toEqual([{ time: T1, series: "Unmonitored", watts: 250 }]);
  });
  it("ignores a non-finite grid value", () => {
    expect(unmonitoredSeries([cat(T1, "HVAC", 100)], [{ time: T1, watts: Number.NaN }])).toEqual([]);
  });
  it("stack top = max(grid, Σ categories) at every bucket, so it equals the Total line", () => {
    const cats = [cat(T1, "HVAC", 400), cat(T2, "HVAC", 900), cat(T3, "Car", 7000)];
    const grid = [{ time: T1, watts: 700 }, { time: T2, watts: 850 }, { time: T3, watts: 7300 }];
    const all = [...cats, ...unmonitoredSeries(cats, grid)];
    const top = (t: string) => all.filter((p) => p.time === t).reduce((s, p) => s + p.watts, 0);
    expect([top(T1), top(T2), top(T3)]).toEqual([700, 900, 7300]);
  });
  it("band area exceeds the once-floored period residual by exactly the clamped buckets", () => {
    // Period kWh method (energyWindow.unmonitoredKwh): floor once on the sum.
    const cats = [cat(T1, "HVAC", 400), cat(T2, "HVAC", 900)];
    const grid = [{ time: T1, watts: 700 }, { time: T2, watts: 850 }];
    const bandW = unmonitoredSeries(cats, grid).reduce((s, p) => s + p.watts, 0);
    const periodW = Math.max(0, 700 + 850 - (400 + 900));
    expect(bandW - periodW).toBe(50); // the T2 bucket's −50 W, clamped away
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/unmonitoredSeries.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `web/lib/unmonitoredSeries.ts`**

```ts
// The Unmonitored chart band: the overflow subpanel (washer, dryer, …) plus
// metering slop, as the panel's grid power minus every named circuit — the same
// residual as the Unmonitored kWh row (energyWindow.unmonitoredKwh, #17), so
// the band reconciles with it. Not panel.feedthrough_power_w: that meter reads
// ~2% off this residual and swings negative.
//
// Floored at 0 per bucket, so the six series sum to max(grid, Σ categories) =
// the top of the stack = the Total line. The kWh row floors once per period,
// so over a period the band's area is >= the row by the clamped buckets.

import type { SeriesPoint } from "./influx";

export type GridPoint = { time: string; watts: number };

const SERIES = "Unmonitored";

export function unmonitoredSeries(
  categories: readonly SeriesPoint[],
  grid: readonly GridPoint[],
): SeriesPoint[] {
  const circuitsAt = new Map<number, number>();
  for (const p of categories) {
    const t = Date.parse(p.time);
    circuitsAt.set(t, (circuitsAt.get(t) ?? 0) + p.watts);
  }
  const out: SeriesPoint[] = [];
  for (const g of grid) {
    if (!Number.isFinite(g.watts)) continue;
    const circuits = circuitsAt.get(Date.parse(g.time));
    // No category point: a gap in circuit data, not a bucket where the whole
    // house was the subpanel.
    if (circuits === undefined) continue;
    out.push({ time: g.time, series: SERIES, watts: Math.max(0, g.watts - circuits) });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/unmonitoredSeries.test.ts`
Expected: PASS (8).

- [ ] **Step 5: Commit**

```bash
git add web/lib/unmonitoredSeries.ts web/lib/unmonitoredSeries.test.ts
git commit -m "feat(web): Unmonitored power series as grid minus circuits per bucket"
```

---

### Task 3: Serve it from `/api/power` (`lib/influx.ts`, `lib/clientFetch.ts`)

**Files:**
- Modify: `web/lib/influx.ts` (new `rawPanelPowerFlux` + `queryGridPower` beside `rawPowerFlux` at :128-137; `queryPower` at :214-251), `web/lib/clientFetch.ts:49-57`
- Test: `web/lib/influx.retry.test.ts`

**Interfaces:**
- Consumes: Task 2 `unmonitoredSeries`, `GridPoint`; `queryRows`, `planSegments`, `Segment`, `fluxEvery` (existing).
- Produces: `queryPower` (category grouping) returns the five category series plus `"Unmonitored"`, sorted by instant; drilled output unchanged. `/api/power` route unchanged.

- [ ] **Step 1: Write the failing tests**

In `web/lib/influx.retry.test.ts`, extend the hoisted state and the mock so queries can be inspected:

```ts
const state = vi.hoisted(() => ({
  calls: 0,
  script: [] as Array<{ rows?: Record<string, unknown>[]; throwErr?: unknown }>,
  /** Every Flux string the code ran, in call order. */
  fluxes: [] as string[],
  /** When set, any query reading panel grid power throws this (no script step consumed). */
  panelErr: null as unknown,
}));
```

`iterateRows` becomes `async *iterateRows(flux: string) { state.calls++; state.fluxes.push(flux); if (state.panelErr && flux.includes("grid_power_w")) throw state.panelErr; const step = …` (rest unchanged); `beforeEach` also sets `state.fluxes = []; state.panelErr = null;`. Then add:

```ts
describe("queryPower and the Unmonitored band", () => {
  const opts = { fromMs: F, toMs: T, interval: "5m" as const, nowMs: T + 3_600_000 };
  it("the category view also reads panel grid power", async () => {
    await influx.queryPower(opts);
    expect(state.fluxes.some((f) => f.includes(`r._measurement == "panel"`) && f.includes("grid_power_w"))).toBe(true);
  });
  it("a drill never reads panel grid power", async () => {
    await influx.queryPower({ ...opts, grouping: { kind: "circuit", category: "HVAC" } });
    expect(state.fluxes.some((f) => f.includes("grid_power_w"))).toBe(false);
  });
  it("a failed panel query leaves the category series working", async () => {
    state.panelErr = Object.assign(new Error("503"), { name: "HttpError", statusCode: 503 });
    await expect(influx.queryPower(opts)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/influx.retry.test.ts`
Expected: FAIL on "the category view also reads panel grid power" (no such query yet). The other new cases may pass already; that is fine.

- [ ] **Step 3: Implement in `web/lib/influx.ts`**

1. Import: `import { unmonitoredSeries, type GridPoint } from "./unmonitoredSeries";`
2. After `rawPowerFlux` (:137):

```ts
/** Whole-house grid power, mean per display bucket, over one segment of a
 *  power query. Always raw (`panel` has no rollup). Same range and
 *  aggregateWindow as that segment's circuit query, so the bucket stamps match
 *  (the rollup path's timeShift puts _start/_stop back on the segment). No
 *  abs(): grid import is positive, and the kWh row integrates it as is.
 *  group() is defensive: `panel` is tagless since the v2 collector. */
function rawPanelPowerFlux(seg: Segment, interval: IntervalKey): string {
  return `
from(bucket: "${BUCKET}")
  |> range(start: ${fluxDate(seg.startMs)}, stop: ${fluxDate(seg.stopMs)})
  |> filter(fn: (r) => r._measurement == "panel" and r._field == "grid_power_w")
  |> filter(fn: (r) => exists r._value)
  |> group()
  |> aggregateWindow(every: ${fluxEvery(interval)}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
`;
}

/** Grid power per bucket across every segment, or [] on failure: a panel
 *  problem must never fail the chart (the Unmonitored band just isn't drawn). */
async function queryGridPower(segments: Segment[], interval: IntervalKey): Promise<GridPoint[]> {
  try {
    const parts = await Promise.all(
      segments.map(async (seg) =>
        (await queryRows(rawPanelPowerFlux(seg, interval))).map((o) => ({
          time: String(o._time),
          watts: Number(o._value),
        })),
      ),
    );
    return parts.flat();
  } catch (e) {
    console.warn("queryGridPower failed; drawing without the Unmonitored band", e);
    return [];
  }
}
```

3. In `queryPower`, run it alongside the segments and append the band (category view only):

```ts
  const [parts, grid] = await Promise.all([
    Promise.all(segments.map(async (seg) => { /* existing body, unchanged */ })),
    g.kind === "category" ? queryGridPower(segments, interval) : Promise.resolve([]),
  ]);
  const series = parts.flat();
  // Segments never share a bucket timestamp … (keep the existing comment)
  return [...series, ...unmonitoredSeries(series, grid)].sort(
    (a, b) => Date.parse(a.time) - Date.parse(b.time),
  );
```

Update `queryPower`'s doc comment: the category view also carries an `"Unmonitored"` series (see `lib/unmonitoredSeries`).

4. `web/lib/clientFetch.ts`: above `fetchSeriesCached` add

```ts
/** Bumped when /api/power's payload changes shape, so a browser HTTP-cached
 *  response from before (max-age is a day for past windows) is never served.
 *  u1: the category view carries an "Unmonitored" series. */
const POWER_SHAPE = "u1";
```

and in the URL builder, after `interval`: `url.searchParams.set("shape", POWER_SHAPE);`. The route ignores the param; the cache keys stay as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all pass (the existing "queryPower retries once after a connection reset" too, whichever query the reset hits).

- [ ] **Step 5: Commit**

```bash
git add web/lib/influx.ts web/lib/influx.retry.test.ts web/lib/clientFetch.ts
git commit -m "feat(web): /api/power carries the Unmonitored series"
```

---

### Task 4: Draw the band, new copy, manual verify

**Files:**
- Modify: `web/components/PowerChart.tsx:19, 309-342, 449-473`, `web/lib/explorerCopy.ts:19-20`
- Test: `web/lib/explorerCopy.test.ts`
- No change expected: `web/components/CategoryPanel.tsx` (already chevron-less for Unmonitored), `web/lib/selectionSummary.ts`, `web/components/ExplorerClient.tsx`. If tsc or a check says otherwise, fix there and say so in the commit.

**Interfaces:**
- Consumes: Task 1 `BAND_ORDER`, `chartCategories`, `showTotal`, `categoryColor`; Task 3 payload.

- [ ] **Step 1: Copy test, failing**

Add to `web/lib/explorerCopy.test.ts`:

```ts
  it("Unmonitored note: the subpanel as one feed, noisy at 1-minute buckets", () => {
    expect(EXPLORER_COPY.unmonitoredNote).toMatch(/subpanel/);
    expect(EXPLORER_COPY.unmonitoredNote).toMatch(/one feed/);
    expect(EXPLORER_COPY.unmonitoredNote).toMatch(/1-minute/);
    expect(EXPLORER_COPY.unmonitoredNote).not.toMatch(/no line/);
  });
```

Run: `cd web && npx vitest run lib/explorerCopy.test.ts` → FAIL.

- [ ] **Step 2: Copy**

`web/lib/explorerCopy.ts`:

```ts
  unmonitoredNote:
    "Unmonitored is the subpanel (washer, dryer, …) as one feed: the panel total minus every named circuit. At 1-minute buckets it looks noisy.",
```

Run the copy test → PASS.

- [ ] **Step 3: Chart wiring in `web/components/PowerChart.tsx`**

1. Import (:19): `import { BAND_ORDER, categoryColor } from "@/lib/drill";` (drop `CATEGORY_ORDER` if nothing else uses it).
2. `applyStack` (:323-324): `stackLayers(BAND_ORDER, chartCategories(off), byCat, d.sortedTimes)` and `for (const cat of BAND_ORDER)`. The rest of the loop (padded `setData` for every band every pass, `visible: layer !== undefined`) stays as is. `subtractOffCircuits` needs no change: no off circuit categorises to Unmonitored, so its series passes through.
3. Series creation (:449-453): `for (const cat of BAND_ORDER.slice().reverse())`; fix the comment: the top layer is now Unmonitored, added first.
4. Comments: `applyStack`'s doc (:309-314) says Total is the sum of every band and shows only while nothing is off; `shapeData` gets a one-liner that `totalByTime` sums every series in the payload, Unmonitored included, so it equals the stack top. `catSeriesRef`'s comment says "one per band".
5. No code change for Total (`showTotal` changed in Task 1) or the legend (it already maps `chartCategories(state.off)` reversed with `categoryColor`, so Unmonitored appears first, above Else).

Run: `cd web && npx tsc --noEmit && npm test` → clean, all pass.

- [ ] **Step 4: Manual verify on the branch's Vercel preview**

No `vercel` commands. The preview builds when Nico pushes the branch (the Vercel Git integration comments the URL on the PR). Run every check with devtools open (Network + Console) and the preview URL as the origin. Pass when all hold:

1. `/?range=24h`: six bands, slate Unmonitored on top, distinct from Else's darker grey. Legend top to bottom: Total, Unmonitored, Else, Appliances, Lights, Car, HVAC. The dotted Total line rides the top edge of the Unmonitored band (crosshair anywhere: no gap between them).
2. Untick Unmonitored: its band and the Total line (and legend entry) go, Else is the top band, the URL becomes `/?range=24h&off=Unmonitored`, and Network shows no new `/api/power` request. Tick it back: band and Total return, URL clean.
3. `/?range=7d&off=HVAC,Car,Lights,Appliances,Else`: only the Unmonitored band, from zero, the y-axis scaled to it (a few kW peaks at most when the dryer runs), no Total.
4. Presets: "House (no car)" shows Unmonitored; "HVAC only" and "Car only" hide it; "Everything" brings back all six and Total.
5. The Unmonitored row has no ⌄ button. Expanding HVAC still lists circuits. At no point does Network show `drill=Unmonitored`.
6. Untick one HVAC circuit (expand HVAC first): HVAC band shrinks, Unmonitored band stays the same shape (it sits higher or lower only by HVAC's change), Total hides, legend reads "HVAC (part)".
7. `/?range=6h`, bucket 1m: the Unmonitored band is jagged, as the panel note says; at `/?range=7d` (1h buckets) it is smooth. The note under the panel reads the new text.
8. Reconciliation. Paste in the preview's devtools console (yesterday, 5-minute buckets, then last month, 1-hour buckets):

```js
async function recon(spanDays, stepMin) { const to = Date.now() - spanDays * 864e5; const e = await (await fetch(`/api/energy?from=${to - spanDays * 864e5}&to=${to}`)).json(); const row = (c) => e.data.find((r) => r.category === c && !r.parent); const u = row('Unmonitored'); const p = await (await fetch(`/api/power?from=${u.periodFromMs}&to=${u.periodToMs}&interval=${stepMin === 5 ? '5m' : '1h'}&shape=u1`)).json(); const area = (c) => p.data.filter((x) => x.series === c).reduce((s, x) => s + x.watts, 0) * (stepMin / 60) / 1000; for (const c of ['Unmonitored', 'Else']) { const k = row(c).kwh, a = area(c); console.log(c, { kwh: k.toFixed(2), area: a.toFixed(2), diffPct: (100 * (a - k) / k).toFixed(2) }); } }
await recon(1, 5); await recon(31, 60);
```

  Pass: Unmonitored's `diffPct` is within 2% for both (and ≥ 0 or within Else's own gap, which is the shared bucket-mean-vs-energy difference). Record both numbers in the commit message. Fail (> 2%): stop, report the numbers; the CLAUDE.md line and possibly the panel note must disclose the gap.
9. `/?range=1y`: note the `/api/power` request's time in Network against the same request on production (https://span.pianohouseproject.org/?range=1y). Pass: under ~2x production and under 10 s. Otherwise report the numbers (the fix is a `panel` rollup on the Pi, out of scope).
10. Legacy links: `/?range=7d&show=HVAC` shows only HVAC (Unmonitored off); `/?range=7d&show=HVAC&drill=HVAC` opens HVAC only with HVAC expanded and the URL rewritten without `drill`; `/?range=7d&off=Unmonitored` shows five bands.
11. Seam: `/?range=24h` with bucket 5m (rollup bulk + raw tail), zoom into the last 2 hours: the Unmonitored band shows no spike or drop to zero at a bucket boundary near "now minus 1 h". Drag left to the loaded edge so the window extends: the band continues with no gap and no console errors.

Fail: any check does not hold.

- [ ] **Step 5: Commit**

```bash
git add web/components/PowerChart.tsx web/lib/explorerCopy.ts web/lib/explorerCopy.test.ts
git commit -m "feat(web): Unmonitored band on the Power Explorer chart"
```

(Body: the two reconciliation `diffPct` values from check 8 and the 1y timing from check 9.)

---

### Task 5: Verify the branch and update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (§ web/ "Selection" bullet, :150, and the "Circuits" line under it, :151, only)

- [ ] **Step 1: Type-check, tests, build**

Run: `cd web && npx tsc --noEmit && npm test && npm run build`
Expected: tsc clean; 348 + 18 new tests pass (report the count); build succeeds and lists `/`.

- [ ] **Step 2: Leftover grep**

Run: `cd web && grep -rn "UNMONITORED_COLOR\|no line on the chart\|has no power series" app components lib`
Expected: no matches.

- [ ] **Step 3: CLAUDE.md, one line, no growth**

1. In the "Selection" bullet (:150), replace the two sentences "The Total line shows only while the five chart categories (HVAC, Car, Lights, Appliances, Else) are all on; turning off only Unmonitored leaves the chart unchanged. Unmonitored has no line on the chart (it is a residual) but counts in the table, panel and headline." with: "Unmonitored is the top band (built on branch `unmonitored-band`, not merged; plan `docs/superpowers/plans/2026-11-23-unmonitored-band.md`): per bucket, mean `panel.grid_power_w` minus the five category means, floored at 0 (`lib/unmonitoredSeries.ts`, served in `/api/power`), the same residual as its kWh row, so its area is ≥ that row only by the clamped buckets; Total (the sum of all six bands, = the stack top) shows only while nothing is off."
2. In the "Circuits" line (:151), replace "Total shows only while all five chart categories are on and no circuit is off." with "Total hides while any circuit is off."

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: Unmonitored chart band built"
```

## Open questions (would change the design)

1. **Residual or the subpanel's own meter?** This plan draws grid − circuits so the band reconciles with the kWh shown. If Nico would rather see `feedthrough_power_w` itself (the subpanel's meter, e.g. to line up with a future dryer detector, #17 Part 2), Task 3's Flux changes to that field with a clamp, and the band then runs ~2% off the kWh row and off the Total line.
2. **Is the Total line still worth drawing?** With everything on it coincides with the Unmonitored band's top edge, and it hides whenever anything is off. Keeping it (as here) is the smaller change; dropping it is a follow-up.
3. **1y load time** (check 9): if the raw panel scan is slow, the fix is a `panel_1h` rollup task on the Pi, which this plan does not touch.
