# Power Explorer Category Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the explorer (option B, category level) a control panel of category checkboxes with per-category kWh, four presets, a stacked chart of only the ticked categories, and a headline for the selection, with the title "Power Explorer".

**Architecture:** A new pure `lib/selection.ts` owns the selection model (`OffSet`, what is turned *off*), presets, and URL (de)serialisation. `DashState.show` is replaced by `DashState.off`. Legacy `show=` URLs, which the Pi's emails still emit, are converted on parse. Pure `lib/selectionSummary.ts` derives panel rows and the headline from the energy rows the page already fetches (the snapped Pacific calendar period, so no new requests). Pure `lib/stack.ts` turns per-category kW into cumulative layers, which `PowerChart` draws as area series layered back to front. New components `CategoryPanel` and `SelectionHeadline` are wired into `ExplorerClient`, and the category chips in `QuickFilters` go away.

**Tech Stack:** Next.js 16 / React 19, TypeScript, Tailwind 4, lightweight-charts 5.2.0 (`AreaSeries`), vitest 4.

**Spec:** `CLAUDE.md`, first Next Steps bullet ("Decided 2026-11-23"), item (1); mock option B at https://claude.ai/artifact/YQj61hizkkU4AhJ7cg7TH5 (artboard `Panel.dc.html`). The mock's per-circuit boxes and "Clear" preset are out of scope here (circuits are a later plan stacked on this branch).

## Global Constraints

- Work on branch `explorer-categories` in worktree `/Users/nico/src/span-worktrees/explorer`. Do not push.
- No new dependencies. `lightweight-charts` stays at 5.2.0.
- Pure logic lives in `web/lib/*.ts` with a vitest file beside it (`cd web && npm test`); chart/React wiring is manual-verify.
- Reader-facing strings go in `web/lib/explorerCopy.ts` (created in Task 2), not inline in components.
- Calendar days are `America/Los_Angeles`. Never form a date with `toISOString().slice(0,10)`.
- The URL stays intent-only, written with `history.replaceState`; pan/zoom never navigates or writes the URL.
- The URL stores what is turned OFF: `off=Car,Unmonitored`. The default (everything on) has no `off` param.
- Old URLs keep working: `show=HVAC`, `show=HVAC,Lights`, `show=HVAC&drill=HVAC` (emitted by `pi/email_kit.py` `dash_url`, which this plan does not change).
- Title and h1 read exactly `Power Explorer`.
- Presets, in this order, with these labels: `Everything`, `House (no car)`, `HVAC only`, `Car only`.
- Selectable keys in stack and panel order: `HVAC`, `Car`, `Lights`, `Appliances`, `Else`, `Unmonitored` (the first five are `CATEGORY_ORDER` from `web/lib/drill.ts`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions

1. **`off` replaces `show` in state; `show` is read-only legacy.** `DashState.show: string[]` becomes `DashState.off: OffSet`. Parsing: if `off` is present it wins and `show` is ignored. Otherwise `show=A,B` becomes "everything except A,B is off" (so Unmonitored ends up off, matching today's filtered table, which never had it). The app never writes `show` again. Email deep links (`show=HVAC`) land on "HVAC only".
2. **Shape for circuits later:** `OffSet = { categories: string[] }`. The circuits plan adds `circuits: string[]` to the same object and its own URL param (`offc`, repeated rather than comma-joined, because circuit names contain commas, e.g. "Lights / Living room, Upstairs"; Next decodes `%2C` before we split, so per-item encoding cannot work). Every caller goes through `selection.ts` helpers, never `off.categories` directly, except the helpers themselves and tests.
3. **Unmonitored is selectable but has no line.** No power series exists for it (it is panel minus circuits, computed only for energy). It counts in the panel, headline and table. The panel carries a one-line note saying so. Turning it off changes the numbers, not the chart.
4. **The chart becomes stacked areas.** Today it is lines plus a dotted Total and a "Sum" line. Each ticked category becomes an `AreaSeries` whose value is the cumulative sum of the ticked categories at or below it (stack bottom `HVAC` → top `Else`). The top edge is the selection's sum, so the **Sum series is deleted**. Total (dotted) shows only when nothing is off and there is no drill. Autoscale follows visible series, so a filtered stack rescales by itself. A drill keeps today's behaviour: the drilled category's area is hidden and its circuits draw as lines (stacking circuits belongs to the circuits plan).
5. **Drill + selection:** drilling X sets `off` to every selectable key except X, and remembers the prior `off` (`offBeforeDrill`). Backing out restores it. A select that turns the drilled category off clears the drill. A URL drill whose category is off is dropped. Drill toggles move from the chips onto the panel rows (not on Unmonitored).
6. **Panel kWh, headline and table all describe the snapped calendar period** the breakdown table already uses (`rows` from `fetchEnergyCached`), labelled with its period name. No new fetch. The headline is `kWh` · `share of the period's total (all selectable rows, positive kWh only, same rule as BreakdownTable)` · `$` at the flat `costForKwh` rate (same as the table). The table keeps today's rule: it shows only the ticked categories.
7. **Empty selection is allowed** (presets cannot produce it; unticking everything can). The chart shows no areas, and the headline shows the "nothing selected" copy.
8. **Layout:** at `lg` (≥1024px) a 17rem sidebar sits to the left of the headline, chart and overview strip. Below `lg` the same panel renders above the chart inside a closed `<details>` whose summary names the active preset or "N of 6 on". Two instances are rendered and CSS shows one; labels wrap inputs, so no ids clash. Focus mode hides the panel and headline; a `globals.css` rule collapses the grid so the chart keeps full width.
9. **`QuickFilters` keeps only the Events chip.** Its category chips and drill carets are deleted.
10. **`layout.tsx` metadata title** becomes `Power Explorer`. `/trends` sets its own title, so it is unaffected. The `appleWebApp.title` "SPAN" stays (home-screen label, not asked for).
11. Selection keys unknown to this build (a stale or future category in `off`) are dropped on parse. Output is canonical: selectable order, no duplicates.

## Review Focus

1. An email deep link `/?range=7d&show=HVAC` or `/?show=HVAC&drill=HVAC` should land on HVAC only (drill kept); the next `replaceState` rewrites the URL to `off=…` form. Test in Task 4.
2. A hand-edited or stale `off` (`off=Furnace,Car,Car,,`) should behave as `off=Car`, and `off=` (empty) as everything on. Test in Task 1.
3. Unticking every box should give no crash, an empty chart, and the "nothing selected" headline. Tests in Tasks 2 and 3.
4. While energy rows are still loading (`rows=[]`) or a category has no row, the panel should show `—`, not `0.0`, and the headline share should be null, not NaN. Test in Task 2.
5. `off` and `show` both present (`?show=HVAC&off=Car`): `off` should win. A drill on an off category (`?off=HVAC&drill=HVAC`) should be dropped. Test in Task 4.

---

### Task 1: Selection model (`lib/selection.ts`)

**Files:**
- Create: `web/lib/selection.ts`
- Test: `web/lib/selection.test.ts`

**Interfaces:**
- Consumes: `CATEGORY_ORDER`, `categoryColor` from `web/lib/drill.ts`.
- Produces:
  - `type OffSet = { categories: string[] }`
  - `SELECTABLE: readonly string[]` = `[...CATEGORY_ORDER, "Unmonitored"]`
  - `UNMONITORED = "Unmonitored"`
  - `EVERYTHING: OffSet` (= `{ categories: [] }`)
  - `isOn(off: OffSet, key: string): boolean`
  - `isFiltered(off: OffSet): boolean`
  - `toggle(off: OffSet, key: string): OffSet`
  - `onlyThese(keys: readonly string[]): OffSet`
  - `chartCategories(off: OffSet): string[]` (on keys from `CATEGORY_ORDER`, in that order)
  - `type PresetId = "everything" | "house" | "hvac" | "car"`, `PRESET_IDS: readonly PresetId[]`
  - `presetOff(id: PresetId): OffSet`, `activePreset(off: OffSet): PresetId | null`
  - `offFromShow(show: readonly string[]): OffSet`
  - `parseOff(raw: string | undefined): OffSet`, `serializeOff(off: OffSet): string`
  - `sameOff(a: OffSet, b: OffSet): boolean`
  - `selectableColor(key: string): string`

- [ ] **Step 1: Write the failing test** `web/lib/selection.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  EVERYTHING, SELECTABLE, activePreset, chartCategories, isFiltered, isOn,
  offFromShow, onlyThese, parseOff, presetOff, sameOff, serializeOff, toggle,
} from "./selection";

describe("selectable keys", () => {
  it("are the five chart categories in stack order, then Unmonitored", () => {
    expect(SELECTABLE).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else", "Unmonitored"]);
  });
});

describe("isOn / toggle / isFiltered", () => {
  it("everything is on by default", () => {
    expect(SELECTABLE.every((k) => isOn(EVERYTHING, k))).toBe(true);
    expect(isFiltered(EVERYTHING)).toBe(false);
  });
  it("a key not in the off list is on, including one this build has never heard of", () => {
    expect(isOn({ categories: ["Car"] }, "Lights")).toBe(true);
    expect(isOn({ categories: ["Car"] }, "Solar")).toBe(true);
  });
  it("toggle turns off then back on, keeping canonical order", () => {
    const a = toggle(toggle(EVERYTHING, "Unmonitored"), "Car");
    expect(a.categories).toEqual(["Car", "Unmonitored"]);
    expect(toggle(a, "Car").categories).toEqual(["Unmonitored"]);
  });
  it("can turn everything off", () => {
    const none = SELECTABLE.reduce((o, k) => toggle(o, k), EVERYTHING);
    expect(SELECTABLE.some((k) => isOn(none, k))).toBe(false);
    expect(chartCategories(none)).toEqual([]);
  });
});

describe("chartCategories", () => {
  it("lists on categories that have a power line, never Unmonitored", () => {
    expect(chartCategories(EVERYTHING)).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else"]);
    expect(chartCategories({ categories: ["Car"] })).toEqual(["HVAC", "Lights", "Appliances", "Else"]);
  });
});

describe("presets", () => {
  it("map to off sets", () => {
    expect(presetOff("everything").categories).toEqual([]);
    expect(presetOff("house").categories).toEqual(["Car"]);
    expect(presetOff("hvac").categories).toEqual(["Car", "Lights", "Appliances", "Else", "Unmonitored"]);
    expect(presetOff("car").categories).toEqual(["HVAC", "Lights", "Appliances", "Else", "Unmonitored"]);
  });
  it("activePreset recognises each preset regardless of order, else null", () => {
    expect(activePreset(EVERYTHING)).toBe("everything");
    expect(activePreset({ categories: ["Car"] })).toBe("house");
    expect(activePreset({ categories: ["Unmonitored", "Else", "Appliances", "Lights", "Car"] })).toBe("hvac");
    expect(activePreset({ categories: ["Car", "Lights"] })).toBeNull();
  });
  it("onlyThese turns everything else off", () => {
    expect(onlyThese(["Lights"]).categories).toEqual(["HVAC", "Car", "Appliances", "Else", "Unmonitored"]);
  });
});

describe("URL form", () => {
  it("serialises in canonical order, empty when nothing is off", () => {
    expect(serializeOff(EVERYTHING)).toBe("");
    expect(serializeOff({ categories: ["Unmonitored", "Car"] })).toBe("Car,Unmonitored");
  });
  it("parses, dropping unknown, duplicate and empty items", () => {
    expect(parseOff("Furnace,Car,Car,,").categories).toEqual(["Car"]);
    expect(parseOff("").categories).toEqual([]);
    expect(parseOff(undefined).categories).toEqual([]);
  });
  it("round-trips", () => {
    const o = { categories: ["HVAC", "Unmonitored"] };
    expect(sameOff(parseOff(serializeOff(o)), o)).toBe(true);
  });
});

describe("offFromShow (legacy show= URLs)", () => {
  it("an empty show means everything on", () => {
    expect(offFromShow([]).categories).toEqual([]);
  });
  it("show=HVAC means only HVAC, Unmonitored off too", () => {
    expect(offFromShow(["HVAC"]).categories).toEqual(["Car", "Lights", "Appliances", "Else", "Unmonitored"]);
  });
  it("ignores unknown names", () => {
    expect(offFromShow(["HVAC", "Furnace"])).toEqual(offFromShow(["HVAC"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/selection.test.ts`
Expected: FAIL, cannot resolve `./selection`.

- [ ] **Step 3: Implement `web/lib/selection.ts`**

```ts
// What the explorer shows, stored as what is turned OFF, so the default URL is
// clean and a category added later defaults to on. Category level only; the
// circuits plan adds `circuits` to OffSet and its own URL param. Callers go
// through these helpers rather than reading `categories` directly.

import { CATEGORY_ORDER, categoryColor } from "./drill";

export type OffSet = { categories: string[] };

export const UNMONITORED = "Unmonitored";
export const SELECTABLE: readonly string[] = [...CATEGORY_ORDER, UNMONITORED];
export const EVERYTHING: OffSet = { categories: [] };

const canonical = (keys: Iterable<string>): string[] => {
  const set = new Set(keys);
  return SELECTABLE.filter((k) => set.has(k));
};

export const isOn = (off: OffSet, key: string): boolean => !off.categories.includes(key);
export const isFiltered = (off: OffSet): boolean => off.categories.length > 0;

export function toggle(off: OffSet, key: string): OffSet {
  return isOn(off, key)
    ? { ...off, categories: canonical([...off.categories, key]) }
    : { ...off, categories: off.categories.filter((k) => k !== key) };
}

export const onlyThese = (keys: readonly string[]): OffSet => ({
  categories: SELECTABLE.filter((k) => !keys.includes(k)),
});

export const chartCategories = (off: OffSet): string[] =>
  CATEGORY_ORDER.filter((c) => isOn(off, c));

export type PresetId = "everything" | "house" | "hvac" | "car";
export const PRESET_IDS: readonly PresetId[] = ["everything", "house", "hvac", "car"];

export function presetOff(id: PresetId): OffSet {
  switch (id) {
    case "everything": return EVERYTHING;
    case "house": return { categories: ["Car"] };
    case "hvac": return onlyThese(["HVAC"]);
    case "car": return onlyThese(["Car"]);
  }
}

export const sameOff = (a: OffSet, b: OffSet): boolean =>
  serializeOff(a) === serializeOff(b);

export const activePreset = (off: OffSet): PresetId | null =>
  PRESET_IDS.find((id) => sameOff(presetOff(id), off)) ?? null;

/** Legacy `show=` (a list of what is ON; empty = all) → OffSet. */
export const offFromShow = (show: readonly string[]): OffSet =>
  show.length === 0 ? EVERYTHING : onlyThese(show);

export const parseOff = (raw: string | undefined): OffSet => ({
  categories: canonical((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
});

export const serializeOff = (off: OffSet): string => canonical(off.categories).join(",");

const UNMONITORED_COLOR = "#94a3b8";
export const selectableColor = (key: string): string =>
  key === UNMONITORED ? UNMONITORED_COLOR : categoryColor(key);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run lib/selection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/selection.ts web/lib/selection.test.ts
git commit -m "feat(web): category selection model stored as what is off"
```

---

### Task 2: Panel rows, headline numbers and explorer copy

**Files:**
- Create: `web/lib/selectionSummary.ts`, `web/lib/explorerCopy.ts`
- Test: `web/lib/selectionSummary.test.ts`, `web/lib/explorerCopy.test.ts`

**Interfaces:**
- Consumes: Task 1 `OffSet`, `SELECTABLE`, `isOn`, `selectableColor`, `PresetId`; `costForKwh` (`web/lib/rates.ts`); `EnergyRow` (`web/lib/queryCache` re-export of `web/lib/influx.ts:239`); `periodLabel` (`web/lib/energyWindow.ts:172`).
- Produces:
  - `type PanelRow = { key: string; kwh: number | null; on: boolean; color: string }`
  - `panelRows(rows: EnergyRow[], off: OffSet): PanelRow[]` (one per `SELECTABLE`, in order; `kwh` null when there is no top-level row for that key)
  - `type SelectionSummary = { kwh: number; totalKwh: number; share: number | null; cost: number; onCount: number; count: number }`
  - `selectionSummary(rows: EnergyRow[], off: OffSet): SelectionSummary`
  - `EXPLORER_COPY` (object of strings below), `periodText(rows: EnergyRow[]): string | null`, `headline(s: SelectionSummary, period: string | null): { main: string; detail: string }`, `panelSummary(preset: PresetId | null, s: SelectionSummary): string`

- [ ] **Step 1: Write the failing tests**

`web/lib/selectionSummary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { panelRows, selectionSummary } from "./selectionSummary";
import { EVERYTHING, SELECTABLE, presetOff, toggle } from "./selection";
import type { EnergyRow } from "./queryCache";

const rows: EnergyRow[] = [
  { category: "HVAC", kwh: 119 },
  { category: "Heating", kwh: 80, parent: "HVAC" }, // child rows never count
  { category: "Car", kwh: 54.6 },
  { category: "Lights", kwh: 52.1 },
  { category: "Appliances", kwh: 21.4 },
  { category: "Else", kwh: 3.4 },
  { category: "Unmonitored", kwh: 20 },
];

describe("selectionSummary", () => {
  it("everything on: share is 1 and kWh is the total", () => {
    const s = selectionSummary(rows, EVERYTHING);
    expect(s.kwh).toBeCloseTo(270.5);
    expect(s.totalKwh).toBeCloseTo(270.5);
    expect(s.share).toBeCloseTo(1);
    expect(s.onCount).toBe(6);
    expect(s.count).toBe(6);
  });
  it("house (no car): drops the car from the selection, not from the total", () => {
    const s = selectionSummary(rows, presetOff("house"));
    expect(s.kwh).toBeCloseTo(215.9);
    expect(s.totalKwh).toBeCloseTo(270.5);
    expect(s.share).toBeCloseTo(215.9 / 270.5);
    expect(s.cost).toBeCloseTo(215.9 * 0.1241);
    expect(s.onCount).toBe(5);
  });
  it("ignores negative kWh in both sums", () => {
    const s = selectionSummary([...rows.slice(0, 6), { category: "Unmonitored", kwh: -5 }], EVERYTHING);
    expect(s.totalKwh).toBeCloseTo(250.5);
  });
  it("nothing selected: zero kWh, share 0", () => {
    const none = SELECTABLE.reduce((o, k) => toggle(o, k), EVERYTHING);
    const s = selectionSummary(rows, none);
    expect(s.kwh).toBe(0);
    expect(s.share).toBe(0);
    expect(s.onCount).toBe(0);
  });
  it("no rows yet: share is null, not NaN", () => {
    expect(selectionSummary([], EVERYTHING).share).toBeNull();
  });
});

describe("panelRows", () => {
  it("lists every selectable key in order with its kWh and on flag", () => {
    const p = panelRows(rows, presetOff("house"));
    expect(p.map((r) => r.key)).toEqual(SELECTABLE);
    expect(p.find((r) => r.key === "Car")).toMatchObject({ kwh: 54.6, on: false });
    expect(p.find((r) => r.key === "HVAC")).toMatchObject({ kwh: 119, on: true });
  });
  it("kWh is null for a key with no row (still loading, or no data)", () => {
    expect(panelRows([], EVERYTHING).every((r) => r.kwh === null)).toBe(true);
  });
});
```

`web/lib/explorerCopy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EXPLORER_COPY, headline, panelSummary, periodText } from "./explorerCopy";

const s = { kwh: 215.94, totalKwh: 270.5, share: 215.94 / 270.5, cost: 26.8, onCount: 5, count: 6 };

describe("explorer copy", () => {
  it("title is Power Explorer", () => {
    expect(EXPLORER_COPY.title).toBe("Power Explorer");
  });
  it("headline: kWh, share of the period total, dollars, period", () => {
    expect(headline(s, "Nov 2026 so far")).toEqual({
      main: "215.9 kWh",
      detail: "80% of 270.5 kWh · $26.80 · Nov 2026 so far",
    });
  });
  it("headline with no share and no period drops those parts", () => {
    expect(headline({ ...s, share: null }, null).detail).toBe("$26.80");
  });
  it("headline when nothing is selected", () => {
    expect(headline({ ...s, kwh: 0, cost: 0, onCount: 0 }, null).main).toBe(EXPLORER_COPY.nothingSelected);
  });
  it("mobile summary names the preset, else counts", () => {
    expect(panelSummary("house", s)).toBe("What to show · House (no car)");
    expect(panelSummary(null, { ...s, onCount: 3 })).toBe("What to show · 3 of 6 on");
  });
  it("periodText reads the snap metadata off the first row", () => {
    const fromMs = Date.parse("2026-11-01T00:00:00-07:00");
    expect(periodText([{ category: "HVAC", kwh: 1, periodFromMs: fromMs, periodGrain: "month", periodComplete: false }]))
      .toBe("Nov 2026 so far");
    expect(periodText([])).toBeNull();
  });
});
```

`periodLabel(fromMs, "month")` (`web/lib/energyWindow.ts:172`) returns `"Nov 2026"` for that instant; `periodText` appends ` so far` when `periodComplete === false`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/selectionSummary.test.ts lib/explorerCopy.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `web/lib/selectionSummary.ts`**

```ts
import { costForKwh } from "./rates";
import { SELECTABLE, isOn, selectableColor, type OffSet } from "./selection";
import type { EnergyRow } from "./queryCache";

export type PanelRow = { key: string; kwh: number | null; on: boolean; color: string };
export type SelectionSummary = {
  kwh: number; totalKwh: number; share: number | null; cost: number; onCount: number; count: number;
};

/** Top-level kWh per selectable key; drill and HVAC-mode child rows are excluded. */
const kwhByKey = (rows: EnergyRow[]) =>
  new Map(rows.filter((r) => !r.parent).map((r) => [r.category, r.kwh]));

export function panelRows(rows: EnergyRow[], off: OffSet): PanelRow[] {
  const by = kwhByKey(rows);
  return SELECTABLE.map((key) => ({
    key, kwh: by.get(key) ?? null, on: isOn(off, key), color: selectableColor(key),
  }));
}

export function selectionSummary(rows: EnergyRow[], off: OffSet): SelectionSummary {
  const by = kwhByKey(rows);
  let kwh = 0;
  let totalKwh = 0;
  for (const key of SELECTABLE) {
    const v = by.get(key) ?? 0;
    if (v <= 0) continue; // same rule as BreakdownTable: negatives are bad data
    totalKwh += v;
    if (isOn(off, key)) kwh += v;
  }
  const onCount = SELECTABLE.filter((k) => isOn(off, k)).length;
  return {
    kwh, totalKwh, share: totalKwh > 0 ? kwh / totalKwh : null,
    cost: costForKwh(kwh), onCount, count: SELECTABLE.length,
  };
}
```

- [ ] **Step 4: Implement `web/lib/explorerCopy.ts`**

`EXPLORER_COPY` holds exactly these keys and strings:

```ts
export const EXPLORER_COPY = {
  title: "Power Explorer",
  panelHeading: "What to show",
  presets: { everything: "Everything", house: "House (no car)", hvac: "HVAC only", car: "Car only" } as Record<PresetId, string>,
  noKwh: "—",
  unmonitoredNote: "Unmonitored is the subpanel (washer, dryer, …). It counts in the totals but has no line on the chart.",
  nothingSelected: "Nothing selected",
  nothingSelectedHint: "Tick a category or pick a preset.",
  events: "Events",
  eventsTitle: "Heat-pump mode strip + bath/EV events under the chart",
  drillShow: (cat: string) => `Show ${cat} circuits`,
  drillHide: (cat: string) => `Hide ${cat} circuits`,
};
```

Plus:
- `periodText(rows)`: reads `periodFromMs`, `periodGrain` and `periodComplete` from `rows[0]`. It returns `periodLabel(fromMs, grain)` with ` so far` appended when `periodComplete === false`, or `null` when the row or its fields are missing.
- `headline(s, period)`: `main` is `` `${s.kwh.toFixed(1)} kWh` ``, or `EXPLORER_COPY.nothingSelected` when `s.onCount === 0`. `detail` joins with ` · ` the parts that exist: `` `${Math.round(share*100)}% of ${totalKwh.toFixed(1)} kWh` `` (when share is not null), `` `$${cost.toFixed(2)}` ``, `period` (when not null). When `onCount === 0`, `detail` is `nothingSelectedHint`.
- `panelSummary(preset, s)`: `` `${panelHeading} · ${preset ? presets[preset] : `${s.onCount} of ${s.count} on`}` ``.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/selectionSummary.test.ts lib/explorerCopy.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/lib/selectionSummary.ts web/lib/selectionSummary.test.ts web/lib/explorerCopy.ts web/lib/explorerCopy.test.ts
git commit -m "feat(web): selection headline numbers, panel rows and explorer copy"
```

---

### Task 3: Stacked layers (`lib/stack.ts`)

**Files:**
- Create: `web/lib/stack.ts`
- Test: `web/lib/stack.test.ts`

**Interfaces:**
- Produces: `stackLayers<T extends number>(order: readonly string[], on: readonly string[], byCat: Map<string, Map<T, number>>, times: readonly T[]): Map<string, { time: T; value: number }[]>`. Keys are the categories in both `order` and `on`. Each layer's value at a time is the sum, over on categories from `order[0]` up to and including itself, of `max(0, value ?? 0)`. Layers come back in `order`.

- [ ] **Step 1: Write the failing test** `web/lib/stack.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { stackLayers } from "./stack";

const order = ["HVAC", "Car", "Lights"];
const byCat = new Map([
  ["HVAC", new Map([[1, 2], [2, 3]])],
  ["Car", new Map([[1, 7]])],          // missing at t=2 → 0
  ["Lights", new Map([[1, 0.5], [2, -0.2]])], // negative → 0
]);

describe("stackLayers", () => {
  it("cumulates bottom-up over the on categories", () => {
    const s = stackLayers(order, ["HVAC", "Car", "Lights"], byCat, [1, 2]);
    expect(s.get("HVAC")).toEqual([{ time: 1, value: 2 }, { time: 2, value: 3 }]);
    expect(s.get("Car")).toEqual([{ time: 1, value: 9 }, { time: 2, value: 3 }]);
    expect(s.get("Lights")).toEqual([{ time: 1, value: 9.5 }, { time: 2, value: 3 }]);
  });
  it("skips off categories entirely, so the layer above drops down", () => {
    const s = stackLayers(order, ["HVAC", "Lights"], byCat, [1]);
    expect([...s.keys()]).toEqual(["HVAC", "Lights"]);
    expect(s.get("Lights")).toEqual([{ time: 1, value: 2.5 }]);
  });
  it("keeps stack order even if `on` is in another order", () => {
    expect([...stackLayers(order, ["Lights", "HVAC"], byCat, [1]).keys()]).toEqual(["HVAC", "Lights"]);
  });
  it("nothing on: empty map", () => {
    expect(stackLayers(order, [], byCat, [1, 2]).size).toBe(0);
  });
  it("an on category with no data still gets a (flat) layer", () => {
    const s = stackLayers(["HVAC", "Else"], ["HVAC", "Else"], byCat, [1]);
    expect(s.get("Else")).toEqual([{ time: 1, value: 2 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/stack.test.ts`
Expected: FAIL, cannot resolve `./stack`.

- [ ] **Step 3: Implement `stackLayers` in `web/lib/stack.ts`**

One running-sum array per time, walking `order` and adding each on category's clamped value before emitting its layer. Add a header comment: the chart draws these as area series with the top layer at the back, so each band shows its own category.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run lib/stack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/stack.ts web/lib/stack.test.ts
git commit -m "feat(web): cumulative stack layers for the power chart"
```

---

### Task 4: State and URL move from `show` to `off`

Replaces `DashState.show` with `DashState.off` in the URL parser and the reducer, with legacy `show=` support. It also makes the mechanical edits that keep the app compiling and behaving as before. The UI changes come in Tasks 5 and 6.

**Files:**
- Modify: `web/lib/url-state.ts` (type at :12-27, `buildIntentSearch` :35-48, `parseDrill` :91-98, `parseState` :100-130)
- Modify: `web/lib/viewState.ts` (`ViewState` :17, `Action` :25-31, `initView` :34-37, cases `show` :73-86 and `drill` :87-108)
- Modify: `web/lib/url-state.test.ts`, `web/lib/viewState.test.ts`
- Modify (compile-keeping only): `web/components/ExplorerClient.tsx:69-77,161-168,223-230`, `web/components/PowerChart.tsx:332-351,620-624,659,700-714,733-738` (QuickFilters itself is untouched; ExplorerClient adapts its props)

**Interfaces:**
- Consumes: Task 1 `OffSet`, `EVERYTHING`, `isOn`, `onlyThese`, `offFromShow`, `parseOff`, `serializeOff`, `chartCategories`, `isFiltered`.
- Produces:
  - `DashState.off: OffSet` (field `show` removed)
  - `buildIntentSearch(range: RangePreset | null, off: OffSet, drill?: string | null, events?: boolean): string`, which emits `off=<serializeOff>` only when non-empty and never emits `show`
  - `parseDrill(raw: string | undefined, off: OffSet): string | null`
  - `ViewState = DashState & { offBeforeDrill: OffSet | null }`
  - Action `{ type: "select"; off: OffSet }` replaces `{ type: "show"; show: string[] }`

- [ ] **Step 1: Rewrite the tests first**

In `web/lib/url-state.test.ts`:
- `buildIntentSearch` cases: change the second argument to an `OffSet`. Expected strings: `buildIntentSearch(null, EVERYTHING)` → `""`; `buildIntentSearch("7d", { categories: ["Car", "Unmonitored"] })` → `"range=7d&off=Car,Unmonitored"`; `buildIntentSearch("7d", onlyThese(["HVAC"]), "HVAC")` → `"range=7d&off=Car,Lights,Appliances,Else,Unmonitored&drill=HVAC"`; `buildIntentSearch(null, EVERYTHING, "Car")` → `"drill=Car"`.
- `parseDrill`: the second argument becomes an OffSet. `parseDrill("HVAC", EVERYTHING)` → `"HVAC"`; `parseDrill("HVAC", { categories: ["HVAC"] })` → `null`.
- Replace the "narrows show" block with these, each a separate `it`:

```ts
it("off= wins and is canonical", () => {
  expect(parseState({ off: "Unmonitored,Car" }).off.categories).toEqual(["Car", "Unmonitored"]);
});
it("legacy show= (email deep links) becomes only-these", () => {
  expect(parseState({ range: "7d", show: "HVAC" }).off).toEqual(onlyThese(["HVAC"]));
  expect(parseState({ show: "HVAC,Lights" }).off).toEqual(onlyThese(["HVAC", "Lights"]));
});
it("off beats show when both are present", () => {
  expect(parseState({ show: "HVAC", off: "Car" }).off.categories).toEqual(["Car"]);
});
it("no off and no show: everything on", () => {
  expect(parseState({ range: "24h" }).off).toEqual(EVERYTHING);
  expect(parseState({ off: "" }).off).toEqual(EVERYTHING);
});
it("a drill focuses the selection on its category", () => {
  expect(parseState({ range: "7d", drill: "Lights" }).off).toEqual(onlyThese(["Lights"]));
  expect(parseState({ show: "HVAC", drill: "HVAC" })).toMatchObject({ drill: "HVAC", off: onlyThese(["HVAC"]) });
});
it("drops a drill whose category is off", () => {
  expect(parseState({ off: "HVAC", drill: "HVAC" }).drill).toBeNull();
});
```

In `web/lib/viewState.test.ts`, port every test in "drill focuses the Show filter" and `initView` from `show` to `off`, keeping each test's meaning:
- `show: ["HVAC","Car"]` becomes `off: onlyThese(["HVAC","Car"])`.
- `show: []` becomes `off: EVERYTHING`.
- `expect(s.show).toEqual(["Lights"])` becomes `expect(s.off).toEqual(onlyThese(["Lights"]))`.
- `showBeforeDrill` becomes `offBeforeDrill`.
- `{ type: "show", show: X }` becomes `{ type: "select", off: X }`.

Rename the describe to "drill focuses the selection". Add one test: `select` with `off: { categories: ["Lights"] }` while drilled into Lights clears the drill and sets `offBeforeDrill` to null.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/url-state.test.ts lib/viewState.test.ts`
Expected: FAIL (`off` undefined, `select` action unknown).

- [ ] **Step 3: Implement in `url-state.ts` and `viewState.ts`**

- `DashState`: replace the `show` field and its comment with `off: OffSet`. New comment: "What is turned off (see lib/selection). Client-side only; never affects Influx queries."
- `parseState`: `const off = params.off !== undefined ? parseOff(first(params.off)) : offFromShow(parseList(first(params.show)));`, then `drill = parseDrill(first(params.drill), off)`, and return `off: drill ? onlyThese([drill]) : off`. Keep the existing comment about drill focus, reworded for `off`.
- `parseDrill`: `if (!isOn(off, raw)) return null;` replaces the `show` check.
- Reducer `select`: `dropped = !!s.drill && !isOn(a.off, s.drill)`. Then `{ ...s, off: a.off, drill: dropped ? null : s.drill, offBeforeDrill: dropped ? null : s.offBeforeDrill }`.
- Reducer `drill` on: `off: onlyThese([a.category])`, `offBeforeDrill: s.drill ? s.offBeforeDrill : s.off`. Off: `off: s.offBeforeDrill ?? s.off`, `offBeforeDrill: null`.

- [ ] **Step 4: Keep the components compiling, with behaviour unchanged**

1. `ExplorerClient.tsx:69-77`: pass `view.off`. Deps become `[view.rangePreset, serializeOff(view.off), view.drill, view.events]`.
2. `ExplorerClient.tsx:161-168`: `filtered = rows.filter((r) => isOn(view.off, r.parent ?? r.category))`.
3. `ExplorerClient.tsx:223-225`: `show={isFiltered(view.off) ? SELECTABLE.filter((k) => isOn(view.off, k)) : []}` and `onChange={(show) => dispatch({ type: "select", off: offFromShow(show) })}`. This is temporary; Task 6 deletes it.
4. `PowerChart.tsx`: replace `(state.show.length === 0 || state.show.includes(cat))` with `isOn(state.off, cat)` at :623 and :707. Replace `applySum(state.show)` (:659, :712) with `applySum(isFiltered(state.off) ? chartCategories(state.off) : [])`. Replace the effect dep `state.show.join(",")` (:714) with `serializeOff(state.off)`. In the legend (:733-737), replace `state.show.length >= 2` with `isFiltered(state.off) && chartCategories(state.off).length >= 2` and the filter with `isOn(state.off, c)`. This is temporary; Task 5 replaces it.

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (If `node_modules` is missing, run `npm ci` first.)

- [ ] **Step 5: Run all tests**

Run: `cd web && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/lib/url-state.ts web/lib/url-state.test.ts web/lib/viewState.ts web/lib/viewState.test.ts web/components/ExplorerClient.tsx web/components/PowerChart.tsx
git commit -m "refactor(web): explorer state stores what is off; legacy show= still parses"
```

---

### Task 5: Stacked area chart

**Files:**
- Modify: `web/components/PowerChart.tsx`

**Interfaces:**
- Consumes: Task 3 `stackLayers`; Task 1 `chartCategories`, `isFiltered`, `serializeOff`; `DashState.off`.
- Produces: no new exports. `catSeriesRef` becomes `Map<string, ISeriesApi<"Area">>`.

- [ ] **Step 1: Category series become areas, added back to front**

In the create-once effect (:395-426):
1. Import `AreaSeries` from `lightweight-charts`.
2. Delete the Sum series and `sumSeriesRef`, `SUM_COLOR`, `applySum` (:332-351).
3. Add the category series in **reverse** `CATEGORY_ORDER` (Else first, at the back) as `AreaSeries` with `lineColor: categoryColor(cat)`, `topColor` and `bottomColor` set to the same color with alpha `cc` (opaque enough that the band in front hides the one behind), `lineWidth: 1`, `priceLineVisible: false`, `lastValueVisible: false`.
4. Add the Total series **after** them, so its dotted line draws on top.

- [ ] **Step 2: One function draws the stack from loaded data**

Inside the component, replace `applySum` with `applyStack(off: OffSet, drill: string | null)`. It reads `dataRef.current` and computes `stackLayers(CATEGORY_ORDER, chartCategories(off).filter((c) => c !== drill), d.byCat, d.sortedTimes)`. For each `CATEGORY_ORDER` category: if it has a layer, `setData(toChartData(padBounds(layer, outerFromSec, outerToSec)))` and `visible: true`; otherwise `visible: false`. Total gets `visible: !isFiltered(off) && !drill`. Guard with `chartAliveRef` and wrap each `setData` in try/catch with `console.warn`, as the code does today. It never calls `setVisibleRange`, so zoom is kept.

- [ ] **Step 3: Use it in both places**

1. In the fetch-render effect, replace the per-category `setData` + visibility loop (:611-625) and the `totalSeriesRef.applyOptions` + `applySum` lines (:657-659) with: Total `setData` as today, then `applyStack(state.off, load.drill)`.
2. Replace the toggle effect body (:700-714) with `applyStack(state.off, state.drill)`, deps `[serializeOff(state.off), state.drill]`. Update the comments that mention "Show filter" or "Sum".

- [ ] **Step 4: Legend matches the stack**

The legend (:729-761) lists, in order:
1. Total (dotted), only when `!isFiltered(state.off) && !state.drill`.
2. The on chart categories from top of the stack to bottom (`chartCategories(state.off).slice().reverse()`), with a filled square swatch (`h-2.5 w-2.5`, `background: color`) instead of the line swatch.
3. The drilled category as a header, with circuits as today.

Add a `filled?: boolean` to `LegendEntry` for the square swatch.

- [ ] **Step 5: Manual verify**

Run `cd web && npx tsc --noEmit` (no errors), then `npm run dev`. In a browser, open http://localhost:3000/?range=7d. Pass when all of these hold:
1. The bands stack HVAC at the bottom through Else at the top, and the dotted Total traces the top edge.
2. http://localhost:3000/?range=7d&show=HVAC shows only the HVAC band with no Total, and the y-axis rescales to HVAC's peak.
3. http://localhost:3000/?range=7d&show=HVAC&drill=HVAC shows HVAC circuit lines with no bands.
4. Panning, then toggling a chip, does not reset the zoom.

Fail: bands hide each other, the axis stays at whole-house scale when filtered, or the zoom jumps.

- [ ] **Step 6: Commit**

```bash
git add web/components/PowerChart.tsx
git commit -m "feat(web): power chart stacks the selected categories as areas"
```

---

### Task 6: Control panel, headline, title and layout

**Files:**
- Create: `web/components/CategoryPanel.tsx`, `web/components/SelectionHeadline.tsx`
- Modify: `web/components/QuickFilters.tsx` (whole file), `web/components/ExplorerClient.tsx:172-252`, `web/app/layout.tsx:5`, `web/app/globals.css:55-63`

**Interfaces:**
- Consumes: Task 1 `toggle`, `presetOff`, `activePreset`, `PRESET_IDS`, `UNMONITORED`, `serializeOff`; Task 2 `panelRows`, `selectionSummary`, `EXPLORER_COPY`, `headline`, `panelSummary`, `periodText`; Task 4 `select` / `drill` actions.
- Produces:
  - `CategoryPanel({ rows, off, drill, period, onSelect, onDrill }: { rows: PanelRow[]; off: OffSet; drill: string | null; period: string | null; onSelect: (off: OffSet) => void; onDrill: (cat: string | null) => void })`
  - `SelectionHeadline({ summary, period }: { summary: SelectionSummary; period: string | null })`
  - `QuickFilters({ events, onEvents }: { events: boolean; onEvents: (on: boolean) => void })`

- [ ] **Step 1: `CategoryPanel.tsx`**

Top to bottom:
1. A header row: `EXPLORER_COPY.panelHeading` on the left, `period` on the right (muted).
2. The presets as pill buttons (reuse the `Chip` look from `QuickFilters`; `aria-pressed` = `activePreset(off) === id`), calling `onSelect(presetOff(id))`.
3. One `<label>` row per `PanelRow`, `min-h-[44px]` touch target, containing: `<input type="checkbox" checked={row.on} onChange={() => onSelect(toggle(off, row.key))}>`, a color dot, the key, and kWh right-aligned in `tabular-nums` (`row.kwh?.toFixed(1) ?? EXPLORER_COPY.noKwh`). Muted when off.
4. On rows other than `UNMONITORED`, when `row.on`, a drill button after the label (the same ⌄/✕ toggle as today's `DrillToggle`, moved here, `aria-label` from `drillShow` / `drillHide`), calling `onDrill(drill === row.key ? null : row.key)`.
5. Below the rows, `EXPLORER_COPY.unmonitoredNote` in `text-xs` muted text.

- [ ] **Step 2: `SelectionHeadline.tsx`**

A rounded `bg-zinc-100 dark:bg-zinc-900` bar: `headline(summary, period).main` large (`text-xl font-semibold tabular-nums`), and `.detail` beside it, wrapping under it on narrow screens (`text-sm text-zinc-600 dark:text-zinc-400`).

- [ ] **Step 3: `QuickFilters.tsx` keeps only Events**

Delete `CHIPS`, `nextShow`, `DrillToggle`, and the show/drill props. Render the Events `Chip` with `EXPLORER_COPY.events` and `eventsTitle`.

- [ ] **Step 4: Wire `ExplorerClient.tsx`**

1. Derive from `rows` (the unfiltered category rows, :80): `const panel = panelRows(rows, view.off)`, `const summary = selectionSummary(rows, view.off)`, `const period = periodText(rows)`.
2. h1 (:175): `{EXPLORER_COPY.title}` with `className="text-2xl font-semibold tracking-tight sm:text-3xl"`.
3. Replace the QuickFilters row (:221-233) with a row of `<QuickFilters events onEvents>` and `<FocusToggle />`.
4. Replace the PowerChart + OverviewStrip block (:235-252) with `<div className="explorer-grid flex flex-col gap-4 lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start lg:gap-6">`, containing:
   1. `<aside className="focus-hide hidden lg:block rounded-md border …">` holding a `CategoryPanel`.
   2. `<div className="flex min-w-0 flex-col gap-4">` holding:
      1. `<details className="focus-hide lg:hidden rounded-md border …">`, whose `<summary>` is `panelSummary(activePreset(view.off), summary)` and whose body is a second `CategoryPanel` with the same props.
      2. `<div className="focus-hide"><SelectionHeadline …/></div>`.
      3. The existing `PowerChart`.
      4. The existing OverviewStrip block.

   Both panels get `onSelect={(off) => dispatch({ type: "select", off })}` and `onDrill={(category) => dispatch({ type: "drill", category })}`.
5. Remove the Task 4 temporary `show`/`offFromShow` props and any now-unused imports.

- [ ] **Step 5: Title and focus-mode grid**

1. `web/app/layout.tsx:5`: set `title: "Power Explorer"`.
2. `web/app/globals.css`, after the `body.focus-mode main` rule: add `body.focus-mode .explorer-grid { display: block !important; }`.

- [ ] **Step 6: Manual verify**

Run `cd web && npx tsc --noEmit` (no errors), then `npm run dev`. Pass when all of these hold:
1. http://localhost:3000/ has the browser tab title "Power Explorer" and a large "Power Explorer" h1.
2. At 1280px wide, the sidebar lists HVAC, Car, Lights, Appliances, Else and Unmonitored with kWh and a period label. The headline reads e.g. "270.5 kWh · 100% of 270.5 kWh · $33.57 · Nov 2026 so far".
3. Clicking "House (no car)" removes the Car band and the Total line, the headline share drops below 100%, the Car row is muted, and the URL becomes `/?off=Car`. Reloading keeps it.
4. "HVAC only" gives URL `/?off=Car,Lights,Appliances,Else,Unmonitored`. "Everything" returns to `/`.
5. Unticking Unmonitored changes the headline but not the chart.
6. Unticking all six shows "Nothing selected", an empty chart and no console errors.
7. The drill caret on HVAC shows its circuit lines; ✕ restores the previous selection.
8. http://localhost:3000/?range=7d&show=HVAC opens on HVAC only and rewrites the URL to `off=…`.
9. At 390px wide (devtools), the panel is a closed "What to show · Everything" disclosure above the chart, with no horizontal page scroll.
10. Focus mode (⤢) hides the panel and headline, and the chart spans the full width.
11. Panning the chart never changes the URL.

Fail: any of these does not hold.

- [ ] **Step 7: Commit**

```bash
git add web/components/CategoryPanel.tsx web/components/SelectionHeadline.tsx web/components/QuickFilters.tsx web/components/ExplorerClient.tsx web/app/layout.tsx web/app/globals.css
git commit -m "feat(web): Power Explorer category panel, presets and selection headline"
```

---

### Task 7: Verify the whole branch and update docs

**Files:**
- Modify: `CLAUDE.md` (§ web/: the "Client-driven state" bullet's URL example `?range=7d&show=HVAC`; the first Next Steps bullet "Decided 2026-11-23" item (1))

- [ ] **Step 1: Install and type-check**

Run: `cd web && npm ci && npx tsc --noEmit`
Expected: exit 0, no errors. (There is no `lint` script or ESLint config in `web/`; `tsc --noEmit` is the lint gate. Do not add ESLint.)

- [ ] **Step 2: Unit tests**

Run: `cd web && npm test`
Expected: all files pass, including `selection`, `selectionSummary`, `explorerCopy`, `stack`, `url-state` and `viewState`.

- [ ] **Step 3: Production build**

Run: `cd web && npm run build`
Expected: `next build` completes and lists route `/`, with no type errors.

- [ ] **Step 4: Check that nothing still uses `show` state**

Run: `cd web && grep -rn "\.show\b\|showBeforeDrill\|type: \"show\"\|applySum\|SUM_COLOR" app components lib`
Expected: no matches.

- [ ] **Step 5: Update `CLAUDE.md`**

1. In § web/ "Client-driven state", change the example to `?range=7d&off=Car`. Add one sentence: "Selection is stored as what is off (`lib/selection.ts`); legacy `show=` (email deep links) still parses into it."
2. Add a § web/ bullet for the control panel. It says: sidebar or disclosure with presets; a stacked area chart of the ticked categories, Total only when unfiltered; the headline for the snapped period; Unmonitored has no line; the plan path.
3. In Next Steps item (1), mark the category step built on branch `explorer-categories`, with circuits next.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: Power Explorer category selection built"
```
