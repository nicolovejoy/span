# /trends Car Split (option C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/trends` reports the house and the car separately, matching the weekly email (PR #28): house layers stack above zero and the Car layer hangs below zero on one shared axis, and every total, share and headline is house-only, with the car on its own line.

**Architecture:** `deriveLayers` gains a `houseKwh` and a `HOUSE_LAYER_ORDER` (every layer but `car`). A new pure `lib/trendAxis.ts` computes the two-sided axis (house max up, car max down, one tick step, signed ticks, a value→y map) from the bars, projection included. `panelRows` drops the car from the ranking and returns it separately. `TrendsChart` and `WhereItWent` are rewired onto those three; the chart stays hand-rolled SVG (no chart library), so the below-zero stack is plain `<rect>`s under a zero line.

**Tech Stack:** Next.js 16, React, TypeScript, hand-rolled SVG, vitest.

**Spec:** Binding design in the task brief (restated under Global Constraints); `CLAUDE.md` § Next Steps "Decided 2026-11-23" (option C); mock artboard C, `project/Trends.dc.html` in https://claude.ai/artifact/YQj61hizkkU4AhJ7cg7TH5 (read 2026-11-23: house up, car down from a shared zero line, ticks labelled `N kWh` positive both sides, a "House" figure and a separate "Car … your driving, not the house" figure). Base page spec: `docs/superpowers/specs/2026-10-26-trends-view-design.md`.

## Global Constraints

- House layers (`hvacUnsplit, heat, cool, hotWater, hvacOther, lights, appliances, rest`, bottom → top) stack above zero; `car` hangs below zero on the same axis (same kWh or $ per pixel both sides); a visible zero line; tick labels positive on both sides.
- In-progress periods keep the projection treatment (bar scaled by `projectionFactor`, faded 0.45, dashed outline, solid line at actual-so-far, footnote) for the house stack above and the car bar below.
- Every total/headline/share shown is house-only; the car is its own line with kWh and $, outside the ranking.
- Reconciliation: house layers sum to the house figure shown (`houseKwh`); the car bar equals the car line.
- Intent URL (`grain`, `end`, `sel`) and email deep links unchanged: do not touch `lib/trendsUrl.ts`, `lib/trends.ts`, `/api/trends`.
- Car = the `Car` category of `pi/categories.json` (regex `Tesla|Car Charger|\bEV\b`), unchanged (see Decisions 1).
- $ mode: the prorated base charge stays with the house; the car's $ is energy-only, `costForKwh(carKwh)`.
- Reader-facing strings go in `web/lib/trendsCopy.ts` (the existing /trends copy module), never inline in components.
- Pure logic in `web/lib/*.ts` with vitest beside it; chart/React wiring is manual-verify.
- Pacific calendar periods come from `lib/trends.ts` as today; never `toISOString().slice(0,10)`.
- No new dependencies. Lint step is `cd web && npx tsc --noEmit`.
- Fresh worktree setup: `cd web && npm ci && npm run sync-config`. Tests: `cd web && npm test`.

## Review Focus

1. A window where no bar has car energy (or every car value rounds to 0): no space reserved below zero, no car legend entry, the chart looks as it does today. Test: `trendAxis` "no car" case in Task 2.
2. An in-progress period whose *projected* car is the window's largest: the bottom of the axis must fit the projected bar, not just the actual. Test: Task 2 "projection" case.
3. $ mode: the base charge must not leak into the car, and house shares must still sum to 100% with the base charge row included. Test: Task 3 "usd" case.
4. A selected bar (`sel`): the panel's house total and car line describe that one period only. Test: Task 3 "single period" case.
5. A period where the car exceeds the house (a heavy charging week in summer): the tick step must come from the larger side, so the axis doesn't sprout a dozen ticks. Test: Task 2 "car larger" case.

---

### Task 1: House total and house layer order

**Files:**
- Modify: `web/lib/trendLayers.ts` (after `LAYER_ORDER`, ~line 59; `TrendLayers` type ~line 40; `deriveLayers` return ~line 94)
- Test: `web/lib/trendLayers.test.ts`

**Interfaces:**
- Produces: `HOUSE_LAYER_ORDER: readonly HouseLayerKey[]` = `LAYER_ORDER` without `"car"`, same order; `type HouseLayerKey = Exclude<LayerKey, "car">`; `TrendLayers.houseKwh: number` = `totalKwh − car`. `LAYER_ORDER` and `totalKwh` stay as they are (other callers and the API payload keep their meaning).

- [ ] **Step 1: Write the failing tests** in the `deriveLayers` describe block:

```ts
it("gives a house total that excludes the car and matches the house layers", () => {
  const l = deriveLayers(
    energy({
      categories: { HVAC: 300, Car: 180, Lights: 40, Appliances: 60, Else: 70, Unmonitored: 50 },
      modes: { heat: 150, cool: 0, hotWater: 100, idle: 20, ambiguous: 25 },
    }),
  );
  expect(l.houseKwh).toBe(300 + 40 + 60 + 70 + 50);
  expect(HOUSE_LAYER_ORDER.reduce((s, k) => s + l[k], 0)).toBe(l.houseKwh);
  expect(l.houseKwh + l.car).toBe(l.totalKwh);
});

it("orders the house layers bottom to top without the car", () => {
  expect(HOUSE_LAYER_ORDER).toEqual([
    "hvacUnsplit", "heat", "cool", "hotWater", "hvacOther", "lights", "appliances", "rest",
  ]);
});
```

Add `HOUSE_LAYER_ORDER` to the import on line 2.

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run lib/trendLayers.test.ts`
Expected: FAIL (`HOUSE_LAYER_ORDER` undefined / `houseKwh` undefined).

- [ ] **Step 3: Implement** `HOUSE_LAYER_ORDER`, `HouseLayerKey` and `houseKwh` (sum over `HOUSE_LAYER_ORDER`, not `totalKwh − car`, so the reconciliation is by construction).

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run lib/trendLayers.test.ts`
Expected: PASS, all existing tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/lib/trendLayers.ts web/lib/trendLayers.test.ts
git commit -m "feat(web): house total and house layer order for /trends"
```

### Task 2: Two-sided axis

**Files:**
- Create: `web/lib/trendAxis.ts`
- Test: `web/lib/trendAxis.test.ts`
- Modify: `web/components/TrendsChart.tsx:32-39` (delete `niceMax`; it moves here as `niceStep`)

**Interfaces:**
- Consumes: Task 1's `houseKwh`; `projectionFactor` from `lib/trends.ts`; `costForKwh` from `lib/rates.ts`; `TrendBar` from `lib/trendsPayload.ts`; `TrendUnit` from `lib/whereItWent.ts`.
- Produces:
  - `type TrendAxis = { upMax: number; downMax: number; step: number; ticks: number[] }` — `ticks` signed, ascending, from `-downMax` to `upMax` in `step`s (car side negative).
  - `trendAxis(periods: TrendBar[], unit: TrendUnit): TrendAxis` — raw up = max over bars of `v(houseKwh) × (projectionFactor(p) ?? 1)`; raw down = the same for `layers.car`; `v` = `costForKwh` in `"usd"`, identity in `"kwh"`. Base charge is not drawn, so not included.
  - `axisY(axis: TrendAxis, value: number, top: number, height: number): number` — `top + (axis.upMax − value) / (axis.upMax + axis.downMax) × height`; car values are passed negative.

Algorithm (not determined by the signature):

```ts
/** Smallest of 1/2/2.5/5/10 × 10^n that is ≥ raw. */
export function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw)! * mag;
}
// trendAxis: if max(up, down) <= 0 → { upMax: 1, downMax: 0, step: 0.25, ticks: [0, .25, .5, .75, 1] }
// step = niceStep(max(up, down) / 4)
// upMax = max(step, ceil(up / step) * step); downMax = down > 0 ? ceil(down / step) * step : 0
// Compare with a 1e-9 tolerance before ceil so 100/50 stays 2, not 3.
```

- [ ] **Step 1: Write the failing tests** (build bars with `deriveLayers` as `whereItWent.test.ts` does; a helper `bar(houseCats, car, opts?)` with `complete`/`toMs`/`calendarToMs` overridable):

```ts
it("puts the house up and the car down on one step", () => {
  // house 120 + car 88 in one week, house 90 + car 30 in another
  const a = trendAxis([barWith({ house: 120, car: 88 }), barWith({ house: 90, car: 30 })], "kwh");
  expect(a).toEqual({ upMax: 150, downMax: 100, step: 50, ticks: [-100, -50, 0, 50, 100, 150] });
});

it("reserves nothing below zero when no bar has car energy", () => {
  const a = trendAxis([barWith({ house: 120, car: 0 })], "kwh");
  expect(a.downMax).toBe(0);
  expect(a.ticks[0]).toBe(0);
});

it("fits the projected car of an in-progress period", () => {
  // 10 of 30 days elapsed: factor 3; car 40 actual → 120 projected; house 30 → 90
  const a = trendAxis([barWith({ house: 30, car: 40, elapsedDays: 10, calendarDays: 30 })], "kwh");
  expect(a.downMax).toBeGreaterThanOrEqual(120);
  expect(a.upMax).toBeGreaterThanOrEqual(90);
});

it("takes the step from the larger side when the car exceeds the house", () => {
  const a = trendAxis([barWith({ house: 40, car: 400 })], "kwh");
  expect(a.step).toBe(100);
  expect(a.ticks.length).toBeLessThanOrEqual(6);
});

it("scales to dollars in usd mode", () => {
  const a = trendAxis([barWith({ house: 1000, car: 0 })], "usd"); // $124.10
  expect(a.upMax).toBe(150);
  expect(a.step).toBe(50);
});

it("keeps a 0–1 axis for an all-zero window", () => {
  expect(trendAxis([barWith({ house: 0, car: 0 })], "kwh")).toEqual({
    upMax: 1, downMax: 0, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1],
  });
});

it("maps values to y with zero between the two sides", () => {
  const a = { upMax: 150, downMax: 100, step: 50, ticks: [] };
  expect(axisY(a, 150, 8, 250)).toBe(8);
  expect(axisY(a, -100, 8, 250)).toBe(258);
  expect(axisY(a, 0, 8, 250)).toBe(8 + 150);
});
```

`barWith({ house, car })` puts `house` in `categories.Lights` (zero modes) so `houseKwh === house`.

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run lib/trendAxis.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `niceStep`, `trendAxis`, `axisY` in `web/lib/trendAxis.ts`; delete `niceMax` from `TrendsChart.tsx` and, for now, replace its one use (line 80) with `trendAxis(periods, unit).upMax` so `tsc` stays green until Task 4 (interim only: car-heavy bars can overflow the top until Task 4 moves the car below zero).

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run lib/trendAxis.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add web/lib/trendAxis.ts web/lib/trendAxis.test.ts web/components/TrendsChart.tsx
git commit -m "feat(web): two-sided axis for the /trends car split"
```

### Task 3: House-only "Where it went" and the new copy

**Files:**
- Modify: `web/lib/whereItWent.ts` (`ORDER` line 11-14; return block lines 41-49)
- Modify: `web/lib/trendsCopy.ts` (`COPY`, lines 41-63)
- Test: `web/lib/whereItWent.test.ts`, `web/lib/trendsCopy.test.ts`

**Interfaces:**
- Consumes: Task 1's `houseKwh`.
- Produces:
  - `panelRows(periods, unit)` returns `{ rows, totalValue, totalKwh, bathKwh, car: { kwh: number; usd: number } }`. `rows` never contains `"car"`; `totalKwh` = Σ `houseKwh`; `totalValue` = `v(totalKwh)` + (usd ? base charge : 0), computed from the unfiltered sum (not from the >0.05 kWh rows), and `share` = `row.value / totalValue`. `car.kwh` = Σ `layers.car`; `car.usd` = `costForKwh(car.kwh)`. `PanelKey` still includes `"car"` (the swatch uses `ROW_FILL.car`).
  - New `COPY` entries (exact text):
    - `houseTotal: "House"` (replaces `total: "Total"`; tooltip total row)
    - `houseHeadline: "House, not counting the car"` (label over the panel's big number)
    - `carLegend: "Car charging ↓"`
    - `carActualSoFar: "Car, actual so far"`
    - `carLine: (kwh: string, usd: string) => \`Car charging: ${kwh} · ${usd}. Not in the house figures.\``
    - `projectedFootnote: (name: string, daysDone: string, daysTotal: string, house: string, car: string | null) =>` — `` `* ${name} is projected to the full period at the pace so far: house ${house}${car ? `, car ${car}` : ""} in ${daysDone} of ${daysTotal} days. Faded bars = projection, solid lines = actual so far.` `` (signature replaces the 4-argument one; its only caller is `TrendsChart.tsx:262-270`, rewired in Task 4).

- [ ] **Step 1: Write the failing tests.** In `whereItWent.test.ts` change the first test's expected keys to `["heat", "hotWater", "unclassified", "hvacUnsplit", "standby", "lights", "other", "unmonitored"]`, delete its `car` value assertion, and add:

```ts
it("ranks the house only and reports the car on its own", () => {
  const r = panelRows(ps, "kwh");
  expect(r.rows.some((x) => x.key === "car")).toBe(false);
  expect(r.car).toEqual({ kwh: 120, usd: costForKwh(120) });
  expect(r.totalKwh).toBe(ps[0].layers.houseKwh + ps[1].layers.houseKwh);
  expect(r.totalValue).toBeCloseTo(r.totalKwh, 9);
  expect(r.rows.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 2);
});

it("keeps the base charge with the house in usd", () => {
  const r = panelRows(ps, "usd");
  expect(r.totalValue).toBeCloseTo(costForKwh(r.totalKwh) + 0.83 * 60, 9);
  expect(r.car.usd).toBeCloseTo(120 * 0.1241, 9);
});

it("describes one selected period only", () => {
  const r = panelRows([ps[1]], "kwh");
  expect(r.car.kwh).toBe(90);
  expect(r.totalKwh).toBe(ps[1].layers.houseKwh);
});
```

(`ps` = the existing two bars; import `costForKwh` from `./rates`.) The existing usd test's `totalValue === Σ rows` assertion becomes `toBeCloseTo(…, 2)` since rows under 0.05 kWh are dropped from the list but kept in the total. In `trendsCopy.test.ts` add:

```ts
it("words the projection footnote with house and car", () => {
  expect(COPY.projectedFootnote("Nov", "13", "30", "512 kWh", "120 kWh")).toBe(
    "* Nov is projected to the full period at the pace so far: house 512 kWh, car 120 kWh in 13 of 30 days. Faded bars = projection, solid lines = actual so far.",
  );
  expect(COPY.projectedFootnote("Nov", "13", "30", "512 kWh", null)).toContain("house 512 kWh in 13");
});

it("words the car line", () => {
  expect(COPY.carLine("54.6 kWh", "$6.78")).toBe("Car charging: 54.6 kWh · $6.78. Not in the house figures.");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run lib/whereItWent.test.ts lib/trendsCopy.test.ts`
Expected: FAIL (`car` row still present, `r.car` undefined, footnote wording).

- [ ] **Step 3: Implement** the `panelRows` change (drop `"car"` from `ORDER`, sum `layers.car` separately) and the `COPY` entries. Fix the two call sites so `tsc` passes: `TrendsChart.tsx:237` `COPY.total` → `COPY.houseTotal`; `TrendsChart.tsx:263-269` pass `null` as the fifth argument for now.

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npm test && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add web/lib/whereItWent.ts web/lib/whereItWent.test.ts web/lib/trendsCopy.ts web/lib/trendsCopy.test.ts web/components/TrendsChart.tsx
git commit -m "feat(web): /trends Where it went is house-only, car on its own line"
```

### Task 4: Draw the car below zero (chart + panel wiring)

**Files:**
- Modify: `web/components/TrendsChart.tsx`
- Modify: `web/components/WhereItWent.tsx`

**Interfaces:**
- Consumes: `HOUSE_LAYER_ORDER`, `houseKwh` (Task 1); `trendAxis`, `axisY` (Task 2); `panelRows(...).car`, `COPY.houseTotal / houseHeadline / carLegend / carActualSoFar / carLine / projectedFootnote` (Task 3).

`TrendsChart.tsx`, by anchor:

- [ ] **Step 1: Axis.** Lines 77-85: `present` = `HOUSE_LAYER_ORDER` filtered as today; `hasCar = periods.some((p) => p.layers.car > 0)`; `axis = trendAxis(periods, unit)`; `y = (val) => axisY(axis, val, PAD.top, plotH)`. Remove `yMax`.
- [ ] **Step 2: Legend** (line 93 `<ul>`): house entries as today, then, when `hasCar`, one entry with `layerFill("car")` and `COPY.carLegend`, last.
- [ ] **Step 3: Gridlines** (line 119): map over `axis.ticks` instead of `[0..4]`; label `fmtTick(Math.abs(val))`. After the bars (so it sits on top), draw the zero line `x1=PAD.left x2=width-PAD.right y=y(0)`, `stroke="currentColor" strokeWidth={1.5} className="text-zinc-500"`.
- [ ] **Step 4: House stack** (lines 138-201): `total = v(p.layers.houseKwh) * k`; iterate `HOUSE_LAYER_ORDER` (was `LAYER_ORDER`); the solid actual-so-far line uses `v(p.layers.houseKwh)`. Shape, clip, fade and dashed outline unchanged.
- [ ] **Step 5: Car bar**, in the same `<g>` per period, when `p.layers.car > 0`: add `bottomRoundedRect(x, y0, w, h, r)` beside `topRoundedRect` (square top, rounded bottom: the data end is the bottom); `carH = y(-v(p.layers.car) * k) - y(0)`; a `clipPath` id `trend-car-clip-${i}` around that path, a `<rect>` filled `layerFill("car")` from `y(0) + GAP` (the surface gap off the zero line) to the bar's bottom, with `opacity={isProjected ? 0.45 : 1}`; when projected, the same dashed outline on the car path and a solid 2px line at `y(-v(p.layers.car))` (actual so far), as the house side does. The hit-target rect already covers the whole plot height.
- [ ] **Step 6: Tooltip** (lines 203-260): house rows from `[...HOUSE_LAYER_ORDER].reverse()`; base charge row as today; total row label `COPY.houseTotal`, value `(v(houseKwh) + base) × scale`; projected "actual so far" row uses `houseKwh`. Then, when `hovered.layers.car > 0`, a top-bordered car row: swatch + `LAYER_LABELS.car`, value `fmt(v(car) × scale)`; and when projected a `COPY.carActualSoFar` row with `fmt(v(car))`.
- [ ] **Step 7: Footnote** (lines 262-270): `COPY.projectedFootnote(tickLabel(p, grain), daysDone, daysTotal, fmt(v(p.layers.houseKwh)), p.layers.car > 0 ? fmt(v(p.layers.car)) : null)`.
- [ ] **Step 8: Header comment** (line 3-4): "house layers bottom → top in HOUSE_LAYER_ORDER above zero; the car below zero".

`WhereItWent.tsx`:

- [ ] **Step 9:** line 45 destructure `car` too; above the big number (line 57) a `text-xs text-zinc-500` line `COPY.houseHeadline`; after the `<ul>` (before the explorer link, line 84) a `text-sm` line with a 2px-radius swatch `ROW_FILL.car` and `COPY.carLine(fmtKwh(car.kwh), fmtUsd(car.usd))`, shown always (both units, regardless of the kWh/$ toggle).

- [ ] **Step 10: Typecheck and tests**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: tsc clean; all tests pass.

- [ ] **Step 11: Manual verify** (`cd web && npm run dev`, needs the CF Access env from `docs/web-deploy.md`; otherwise verify on the Vercel preview of the pushed branch). Open http://localhost:3000/trends?grain=week then http://localhost:3000/trends (months) and http://localhost:3000/trends?grain=year. Pass looks like:
  1. Green car bars hang below a darker zero line; house bars above; tick labels positive both sides.
  2. The current period's bar is faded with a dashed outline and a solid line, above and below.
  3. Hover a bar: house rows, a "House" total, then a separate Car charging row.
  4. The panel's big number sits under "House, not counting the car"; no Car row in the ranking; the "Car charging: … · $… Not in the house figures." line under it.
  5. Click one week's bar: the panel's house total equals the tooltip's House total for that bar (kWh mode), and the car line equals the tooltip's Car row.
  6. Toggle `$`: same layout; tooltip House total includes the base charge; the car line still shows kWh and $.
  7. http://localhost:3000/trends?grain=week&end=2026-10-19&sel=2026-10-12 still opens with that bar selected (URL unchanged).
  Take a headless screenshot if a visual record is wanted; no headed browser.

- [ ] **Step 12: Commit**

```bash
git add web/components/TrendsChart.tsx web/components/WhereItWent.tsx
git commit -m "feat(web): /trends draws the car below zero"
```

### Task 5: Verify and document

**Files:**
- Modify: `CLAUDE.md` § web/, the `/trends (2026-11-13)` bullet only. Do not touch the "Decided 2026-11-23" Next Steps entry (other branches edit it).

- [ ] **Step 1: Full verification**

Run: `cd web && npx tsc --noEmit && npm test && npm run build`
Expected: tsc clean; vitest all pass (count = previous + the new tests); `next build` succeeds.

- [ ] **Step 2: Update the `/trends` bullet.** After the sentence ending "kWh/$ toggle." insert: "Since 2026-11-23 (option C, matching the weekly email) the house layers stack above zero and Car charging hangs below on the same axis (`lib/trendAxis.ts`: one tick step from the larger side, positive labels both sides); the Where-it-went total, shares and the tooltip total are house-only (`houseKwh`), the car is its own kWh + $ line, and the base charge stays with the house. Car is still the `categories.json` `Car` regex, which today matches only `Outdoor / Tesla Car Charger`, the circuit the email pins."

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: /trends car split"
```

## Decisions

1. **Car definition: unchanged.** `/trends` takes Car from `cachedQueryEnergyByCategory`, i.e. the `categories.json` regex `Tesla|Car Charger|\bEV\b`; the email (PR #28) pins the exact circuit `"Outdoor / Tesla Car Charger"`. They could differ if a second circuit matched the regex, but today they don't: `/api/energy?drill=Car` over the last 300 days (checked 2026-11-23) returns exactly one circuit, `Outdoor / Tesla Car Charger`, 2,217 kWh. Difference in practice: 0 kWh. Not aligned; revisit only if a second circuit ever matches.
2. **No new chart-top headline** with a 12-week-average comparison (the mock shows one). The brief binds only that existing totals become house-only; the panel's big number is the page's headline and becomes "House".
3. **Base charge stays with the house**; car $ is energy-only (same as PR #28 decision 4).
4. **Panel total is computed from the unfiltered house sum**, not the >0.05 kWh rows, so it equals the bar's house figure exactly.
5. **One tick step for both sides, taken from the larger side**, ≤4 steps a side; nothing reserved below zero when the window has no car energy.
6. **Car line always shown in the panel** (even 0.0 kWh), so the house-only meaning stays explicit; it shows kWh and $ whichever unit is toggled.
7. `LAYER_ORDER` and `totalKwh` are kept (API payload meaning unchanged); new `HOUSE_LAYER_ORDER` / `houseKwh` sit beside them.
8. No chips or "car below the axis" toggle from the mock: those belong to the Power Explorer option B work.
