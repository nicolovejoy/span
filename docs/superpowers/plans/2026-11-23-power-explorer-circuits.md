# Power Explorer Circuit Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-circuit selection on top of the category selection (option B step 2): each category in the panel expands to circuit checkboxes with kWh, a partly-off category shows an indeterminate box, the chart band for that category shrinks to its ticked circuits, and the headline, panel and URL (`offc=`) follow.

**Architecture:** `OffSet` gains `circuits: string[]` (names of circuits turned off; a circuit's category comes from the shared regex rules, `categorize()` in `lib/categories.ts`). A full-state key `offKey` replaces `serializeOff` everywhere a dependency or a preset comparison needs the whole selection; `serializeOff` stays the `off=` URL form. Circuit data comes from the existing drill endpoints, fetched only for categories that need it: `/api/power?drill=X` at the *category* bucket for each partly-off category (the band is category minus its off circuits, `lib/stack.ts`), and `/api/energy?drill=X` for each expanded or partly-off category (panel and headline kWh). The drill's per-circuit chart lines and its narrow-to-one-category focus are retired; the panel's ⌄ button now expands a category's circuit rows instead.

**Tech Stack:** Next.js 16 / React 19, TypeScript, Tailwind 4, lightweight-charts 5.2.0, vitest 4.

**Spec:** `CLAUDE.md` Next Steps, "Decided 2026-11-23", item (1); the six binding points in this plan's brief (restated under Global Constraints); mock option B at https://claude.ai/artifact/YQj61hizkkU4AhJ7cg7TH5 (artboard `project/Panel.dc.html`: circuit rows indented under each category, own checkbox and kWh); risks in `.superpowers/sdd/2026-11-23-power-explorer-categories/final-review.md` § 5. Builds on `docs/superpowers/plans/2026-11-23-power-explorer-categories.md`.

## Global Constraints

- Work on branch `explorer-circuits` (stacked on `explorer-categories`) in worktree `/Users/nico/src/span-worktrees/explorer`. Do not push.
- No new dependencies. No lint script exists; `cd web && npx tsc --noEmit` is the lint step.
- Pure logic in `web/lib/*.ts` with a vitest file beside it (`cd web && npm test`, 298 pass before this plan). Chart/React wiring is manual-verify.
- Reader-facing strings in `web/lib/explorerCopy.ts`.
- Calendar days are `America/Los_Angeles`; never `toISOString().slice(0,10)`.
- URL is intent-only, written with `history.replaceState`; pan/zoom never writes it.
- URL stores what is OFF. Categories: `off=Car,Unmonitored` (literal commas, unchanged). Circuits: one repeated `offc` param per circuit, each value `encodeURIComponent`-encoded (`offc=Heat%20pump%20(HP)%20%2F%20Control`). Everything on = no `off`, no `offc`. Order: `range`, `off`, `offc`…, `events=0`.
- Old links keep working: `show=HVAC`, `show=HVAC,Lights`, `show=HVAC&drill=HVAC` (still emitted by `pi/email_kit.py`, not changed here), and `off=…&drill=…`.
- A partly-off category shows an indeterminate checkbox; ticking or unticking the category sets all its circuits.
- The Total line shows only while nothing that has a power series is off: all five chart categories on and no circuit off.
- Presets keep their four ids, labels and order, and every preset clears circuit-level state.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions

1. **The drill's chart lines are retired; ⌄ now expands circuit rows in the panel.** Keeping the lines next to circuit checkboxes means two ways to look at one category, two bucket sizes on two time axes, and the `offBeforeDrill` narrow/restore machinery. With checkboxes, one circuit is isolated by unticking its siblings (it draws as a band). Removed: `DashState.drill`, the reducer's `drill` action and `offBeforeDrill`, `PowerChart`'s circuit `LineSeries`, `reconcileCircuitSeries`, its drill legend, and the now-dead `drillInterval`, `DRILL_POINT_BUDGET_FACTOR`, `ASSUMED_CIRCUITS_PER_CATEGORY`, `circuitShades`, `LEGEND_MAX_CIRCUITS` in `lib/drill.ts` (with their tests). The drill *endpoints* (`?drill=` on `/api/power` and `/api/energy`, `fetchSeriesCached`/`fetchEnergyCached` with `drill`) are reused unchanged, as are `mergeDrillRows` (table nesting) and the server-side HVAC drill in `lib/trendsQuery.ts`.
2. **(a) Effect keys.** New `offKey(off)` serialises categories *and* circuits. `sameOff` (therefore `activePreset`), ExplorerClient's `replaceState` effect and PowerChart's redraw effect key on it. `serializeOff` remains the `off=` value only. A circuit off means no preset is active.
3. **(b) Chart circuit data.** One `/api/power?drill=<cat>` per *partly-off* category, at `load.interval` (the category bucket, same `fromMs/toMs`), never `drillInterval`, so its bucket stamps are the category series' stamps and need no resampling. The band for a partly-off category is `max(0, category(t) − Σ off circuits(t))` (`subtractOffCircuits`, Task 4). The category series is the sum of the same per-circuit bucket means (`powerFlux` in `lib/influx.ts`), so the subtraction is exact. The load effect fetches the partly-off categories alongside the category series so a range change draws consistent data. A toggle that makes a new category partly off fetches just that category, then redraws. Until it lands, the band draws the full category.
4. **(c) URL encoding.** `buildIntentSearch(range, off, events)` writes `offc=${encodeURIComponent(name)}` per circuit, sorted. `parseState` reads every `offc` value (Next passes a repeated param as `string[]`, already decoded). Category `off=` stays literal; category names are plain words.
5. **(d) Circuit kWh.** ExplorerClient fetches `/api/energy?drill=<cat>` for each category in `categoriesNeedingCircuits(off, expanded)` (expanded ∪ partly off) for the visible window, into `Map<cat, EnergyRow[]>`. The rows are the same snapped Pacific period as the category rows (same route). `panelRows` and `selectionSummary` take the flattened rows and subtract off circuits' kWh from their category, clamped at 0. Rows not yet loaded subtract nothing.
6. **Normalised `OffSet`.** `circuits` is sorted (plain `.sort()`), deduped, non-empty, and holds no circuit whose category is in `categories`. Unticking the last on circuit of a category turns the category off and drops its names. Ticking one circuit of an off category turns the category on with every other member in `circuits`.
7. **Stale circuit names** (a circuit renamed in the SPAN app): an `offc` name that matches no live circuit would otherwise leave its category falsely partial and hide Total. When a category's circuit energy rows arrive, ExplorerClient dispatches `pruneCircuits(off, cat, members)`, which drops that category's names not among the members and returns the same object when nothing changes (so no render loop). Never prunes on an empty member list (a failed fetch). The renamed circuit turns back on, as the categories plan's Decision 11 accepts for unknown keys.
8. **Expansion is panel state, not URL intent.** `DashState.expanded: string[]` (any number, `CATEGORY_ORDER` order), toggled by a reducer `expand` action. It is never written to the URL. Legacy `drill=X` (X a category that is on) parses as `expanded: [X]` plus the old narrowing to X only, so email links land where they did, minus the lines. The URL is then rewritten without `drill`.
9. **Panel numbers.** Category rows show the full category kWh, except a partly-off row shows `on of total` (`EXPLORER_COPY.partKwh`, "100.8 of 119.0"). Circuit rows, when expanded, are sorted by kWh descending, each with its own kWh and checkbox, muted when off. Unmonitored has no ⌄ (no circuits). The ⌄ shows on every other category, on or off. A category whose circuit rows have not arrived shows `EXPLORER_COPY.circuitsLoading`.
10. **Table.** Each expanded category gets its *on* circuits nested under it (`mergeDrillRows` once per expanded category). Category subtotals stay whole-category, as with the HVAC mode rows today.
11. **Chart legend.** A partly-off category's label reads `EXPLORER_COPY.legendPartial(cat)` ("HVAC (part)").
12. **Network cost.** Clean page load: unchanged (SSR energy, 1 `/api/power`, events). A page load whose URL has circuits off in k categories: + k `/api/power?drill` + k `/api/energy?drill`. Expand a category: + 1 `/api/energy?drill` (then a cache hit for that window). Untick the first circuit of a category: + 1 `/api/power?drill` (energy is already loaded, since unticking needs the rows shown). Further circuit toggles in that category, category toggles and presets: 0. A range/bucket change or edge extension: 1 + k power requests; a visible-window change: 1 + (expanded ∪ partly off) energy requests. All are client-cached by window (`lib/clientFetch`). Worst case is all five categories, ≤ 5 + 5. Response size at the category bucket: about circuits × loaded buckets rows (Else, ~10 circuits, × ~525 buckets for a padded 175-point view ≈ 5k rows). The Influx scan is the same as the category query, which already reads every circuit.

## Review Focus

1. A circuit ticked off in a category that is also off (`?off=HVAC&offc=Heat%20pump%20(HP)`) should drop the circuit and behave as `off=HVAC`. Test in Task 1 (`withCircuits`) and Task 2 (`parseState`).
2. Unticking every circuit of a category one by one should end with the category off (plain unticked box, no `offc` for it), not "partial with nothing on". Test in Task 1.
3. A circuit name containing `&`, `#`, `+`, `,` or `/` should survive build → `URLSearchParams` → `parseState` unchanged. Test in Task 2.
4. Off circuits whose bucket values exceed their category at some instant (rounding, a late batch) should clamp the band at 0, never draw negative; the same clamp applies to kWh. Tests in Tasks 3 and 4.
5. A stale `offc` name, and a failed circuit-energy fetch (empty rows), should neither crash nor wipe the user's other circuit choices. Test in Task 1 (`pruneCircuits` on empty members is a no-op).

---

### Task 1: Circuits in the selection model (`lib/selection.ts`)

**Files:**
- Modify: `web/lib/selection.ts` (whole file; currently 72 lines)
- Test: `web/lib/selection.test.ts`

**Interfaces:**
- Consumes: `categorize(name: string): string` from `web/lib/categories.ts`; `CATEGORY_ORDER` from `web/lib/drill.ts`.
- Produces (existing names keep their signatures unless listed):
  - `type OffSet = { categories: string[]; circuits: string[] }`; `EVERYTHING = { categories: [], circuits: [] }`
  - `type CategoryState = "on" | "partial" | "off"`
  - `categoryState(off: OffSet, cat: string): CategoryState`
  - `isCircuitOn(off: OffSet, name: string): boolean`
  - `offCircuitsIn(off: OffSet, cat: string): string[]`
  - `partialCategories(off: OffSet): string[]` (in `CATEGORY_ORDER` order)
  - `toggle(off: OffSet, key: string): OffSet` (now: partial → all on; on → off; off → on; always drops `key`'s circuits)
  - `toggleCircuit(off: OffSet, name: string, members: readonly string[]): OffSet`
  - `withCircuits(off: OffSet, names: readonly string[]): OffSet` (sets `circuits` to `names`, normalised per Decision 6)
  - `pruneCircuits(off: OffSet, cat: string, members: readonly string[]): OffSet`
  - `categoriesNeedingCircuits(off: OffSet, expanded: readonly string[]): string[]`
  - `offKey(off: OffSet): string`
  - `showTotal(off)`: also false when `off.circuits.length > 0`
  - `onlyThese`, `presetOff`, `offFromShow`, `parseOff` return `circuits: []`
  - Removed: `isFiltered` (unused since `showTotal`)

- [ ] **Step 1: Update the existing tests, then write the failing tests**

In `web/lib/selection.test.ts`, every `OffSet` literal and `toEqual({ categories: [...] })` gains `circuits: []`; delete the `isFiltered` assertions and import. Then add:

```ts
import {
  EVERYTHING, activePreset, categoriesNeedingCircuits, categoryState, isCircuitOn,
  offCircuitsIn, offKey, partialCategories, presetOff, pruneCircuits, sameOff,
  showTotal, toggle, toggleCircuit, withCircuits, type OffSet,
} from "./selection";

const HP = "Heat pump (HP)";
const CTRL = "Heat pump (HP) / Control";
const AUX = "Auxiliary / Heat pump (HP)";
const HVAC_MEMBERS = [HP, CTRL, AUX];
const LIV = "Lights / Living room, Upstairs";
const os = (categories: string[], circuits: string[] = []): OffSet => ({ categories, circuits });

describe("circuit state", () => {
  it("a circuit is on unless it or its category is off", () => {
    const off = os(["Car"], [CTRL]);
    expect(isCircuitOn(off, HP)).toBe(true);
    expect(isCircuitOn(off, CTRL)).toBe(false);
    expect(isCircuitOn(off, "Tesla Car Charger")).toBe(false);
  });
  it("categoryState is on, partial or off", () => {
    const off = os(["Car"], [CTRL]);
    expect(categoryState(off, "HVAC")).toBe("partial");
    expect(categoryState(off, "Car")).toBe("off");
    expect(categoryState(off, "Lights")).toBe("on");
  });
  it("offCircuitsIn and partialCategories group circuits by category", () => {
    const off = os([], [CTRL, LIV]);
    expect(offCircuitsIn(off, "HVAC")).toEqual([CTRL]);
    expect(partialCategories(off)).toEqual(["HVAC", "Lights"]);
  });
});

describe("toggleCircuit", () => {
  it("turns one circuit off and back on", () => {
    const a = toggleCircuit(EVERYTHING, CTRL, HVAC_MEMBERS);
    expect(a).toEqual(os([], [CTRL]));
    expect(toggleCircuit(a, CTRL, HVAC_MEMBERS)).toEqual(EVERYTHING);
  });
  it("unticking the last on circuit turns the whole category off", () => {
    let off = toggleCircuit(EVERYTHING, HP, HVAC_MEMBERS);
    off = toggleCircuit(off, CTRL, HVAC_MEMBERS);
    off = toggleCircuit(off, AUX, HVAC_MEMBERS);
    expect(off).toEqual(os(["HVAC"]));
  });
  it("ticking one circuit of an off category turns on only that circuit", () => {
    expect(toggleCircuit(os(["HVAC", "Car"]), HP, HVAC_MEMBERS)).toEqual(os(["Car"], [AUX, CTRL]));
  });
  it("drops this category's names that are not among its members, keeps others", () => {
    const off = toggleCircuit(os([], ["Heat pump (old name)", LIV]), CTRL, HVAC_MEMBERS);
    expect(off.circuits).toEqual([CTRL, LIV]);
  });
});

describe("category toggle with circuits", () => {
  it("a partly-off category ticks back to all on", () => {
    expect(toggle(os([], [CTRL, LIV]), "HVAC")).toEqual(os([], [LIV]));
  });
  it("an all-on category turns off; an off one turns on with every circuit", () => {
    expect(toggle(EVERYTHING, "HVAC")).toEqual(os(["HVAC"]));
    expect(toggle(os(["HVAC"]), "HVAC")).toEqual(EVERYTHING);
  });
});

describe("withCircuits / pruneCircuits", () => {
  it("normalises: sorted, deduped, no empties, none in an off category", () => {
    expect(withCircuits(os(["HVAC"]), [LIV, "", CTRL, LIV])).toEqual(os(["HVAC"], [LIV]));
  });
  it("prunes a category's stale names and returns the same object when nothing changes", () => {
    const off = os([], ["Heat pump (old name)", LIV]);
    expect(pruneCircuits(off, "HVAC", HVAC_MEMBERS)).toEqual(os([], [LIV]));
    const clean = os([], [CTRL]);
    expect(pruneCircuits(clean, "HVAC", HVAC_MEMBERS)).toBe(clean);
  });
  it("never prunes on an empty member list (a failed fetch)", () => {
    const off = os([], [CTRL]);
    expect(pruneCircuits(off, "HVAC", [])).toBe(off);
  });
});

describe("whole-selection key, presets and Total with circuits", () => {
  it("offKey and sameOff tell circuit selections apart", () => {
    expect(offKey(EVERYTHING)).not.toBe(offKey(os([], [CTRL])));
    expect(sameOff(os([], [CTRL, LIV]), os([], [LIV, CTRL]))).toBe(true);
  });
  it("no preset is active while a circuit is off, and every preset clears circuits", () => {
    expect(activePreset(os([], [CTRL]))).toBeNull();
    expect(activePreset(os(["Car"], [CTRL]))).toBeNull();
    for (const id of ["everything", "house", "hvac", "car"] as const) {
      expect(presetOff(id).circuits).toEqual([]);
    }
  });
  it("Total hides when any circuit is off", () => {
    expect(showTotal(os([], [CTRL]))).toBe(false);
    expect(showTotal(os(["Unmonitored"]))).toBe(true);
  });
  it("categoriesNeedingCircuits is expanded ∪ partly off, in stack order, never Unmonitored", () => {
    expect(categoriesNeedingCircuits(os([], [LIV]), ["Car", "HVAC", "Unmonitored"])).toEqual(["HVAC", "Car", "Lights"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/selection.test.ts`
Expected: FAIL (`toggleCircuit` etc. not exported; literals missing `circuits`).

- [ ] **Step 3: Implement in `web/lib/selection.ts`**

Update the header comment (circuits are now here). `categoryOf = categorize`. `toggleCircuit` rules, in order: drop `name`'s category's names not in `members` (when `members` is non-empty); if the category is off → category on, `circuits` += every member except `name`; else if `name` is off → remove it; else add it, and if every member is now off → category off and its names dropped. Normalise the result with `withCircuits`. `offKey = JSON.stringify([serializeOff(off), [...normalised circuits]])`; `sameOff` compares `offKey`. `categoriesNeedingCircuits` filters `CATEGORY_ORDER` by `expanded.includes(c) || categoryState(off, c) === "partial"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/selection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/selection.ts web/lib/selection.test.ts
git commit -m "feat(web): circuit-level off set, toggles and whole-selection key"
```

---

### Task 2: URL (`offc`) and reducer (`expand` replaces `drill`)

**Files:**
- Modify: `web/lib/url-state.ts:20-145`, `web/lib/viewState.ts` (whole file)
- Test: `web/lib/url-state.test.ts`, `web/lib/viewState.test.ts`

**Interfaces:**
- Consumes: Task 1 `withCircuits`, `onlyThese`, `parseOff`, `offFromShow`, `serializeOff`, `isOn`, `type OffSet`; `CATEGORY_ORDER`.
- Produces:
  - `DashState`: `drill` removed; `expanded: string[]` added (categories whose circuit rows show in the panel; never in the URL).
  - `buildIntentSearch(range: RangePreset | null, off: OffSet, events?: boolean): string` (the `drill` parameter is gone)
  - `parseState(params)`: reads all `offc` values; legacy `drill=X` → `expanded: [X]` and `off` narrowed to X (circuits kept, via `withCircuits`).
  - `parseDrill` unchanged.
  - `viewState.ts`: `type ViewState = DashState`; `initView(s: DashState): ViewState` (returns `s`); `Action` loses `drill`, gains `{ type: "expand"; category: string }` (toggles membership, result in `CATEGORY_ORDER` order); `select` only sets `off`.

After this task `npx tsc --noEmit` reports errors in `PowerChart.tsx`, `ExplorerClient.tsx` and `CategoryPanel.tsx` (they still read `drill`); Tasks 5 and 6 clear them. vitest must pass.

- [ ] **Step 1: Write the failing tests**

In `url-state.test.ts`: delete "omits the drill…" and "carries the drilled category"; fix `OffSet` literals to carry `circuits: []`. Add:

```ts
const CTRL = "Heat pump (HP) / Control";
const LIV = "Lights / Living room, Upstairs";

it("writes each off circuit as its own encoded offc, after off and before events", () => {
  expect(buildIntentSearch("7d", { categories: ["Car"], circuits: [CTRL, LIV] }, false)).toBe(
    "range=7d&off=Car&offc=Heat%20pump%20(HP)%20%2F%20Control&offc=Lights%20%2F%20Living%20room%2C%20Upstairs&events=0",
  );
});
it("never writes drill", () => {
  expect(buildIntentSearch("7d", onlyThese(["HVAC"]))).not.toContain("drill=");
});
it("round-trips circuit names with & # + , / through URLSearchParams", () => {
  const off = withCircuits(EVERYTHING, ["A & B #1 + C", CTRL, LIV]);
  const p = new URLSearchParams(buildIntentSearch(null, off));
  expect(parseState({ offc: p.getAll("offc") }).off).toEqual(off);
});
it("reads a single offc as a string and drops circuits of off categories", () => {
  expect(parseState({ offc: CTRL }).off.circuits).toEqual([CTRL]);
  expect(parseState({ off: "HVAC", offc: [CTRL, LIV] }).off).toEqual({ categories: ["HVAC"], circuits: [LIV] });
});
it("legacy drill expands its category and narrows to it; expanded is empty otherwise", () => {
  const s = parseState({ show: "HVAC", drill: "HVAC" });
  expect(s.expanded).toEqual(["HVAC"]);
  expect(s.off).toEqual(onlyThese(["HVAC"]));
  expect(parseState({ range: "7d" }).expanded).toEqual([]);
  expect(parseState({ off: "HVAC", drill: "HVAC" }).expanded).toEqual([]);
});
```

In `viewState.test.ts`: delete the "drill focuses the selection" and `initView` describes and the drill case in "select action". Add:

```ts
describe("expand action", () => {
  it("toggles a category's circuit rows, keeping stack order", () => {
    let s = reducer(base(), { type: "expand", category: "Lights" });
    s = reducer(s, { type: "expand", category: "HVAC" });
    expect(s.expanded).toEqual(["HVAC", "Lights"]);
    expect(reducer(s, { type: "expand", category: "HVAC" }).expanded).toEqual(["Lights"]);
  });
  it("leaves the selection alone; select leaves the expansion alone", () => {
    const s = reducer(base(), { type: "expand", category: "HVAC" });
    expect(s.off).toEqual(EVERYTHING);
    const t = reducer(s, { type: "select", off: onlyThese(["Car"]) });
    expect(t.expanded).toEqual(["HVAC"]);
    expect(t.off).toEqual(onlyThese(["Car"]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/url-state.test.ts lib/viewState.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`url-state.ts`: add `const all = (v: string | string[] | undefined): string[] => v === undefined ? [] : Array.isArray(v) ? v : [v]`. In `parseState`, `off = withCircuits(base, all(params.offc))`, then if `drill` survives `parseDrill`, `off = withCircuits(onlyThese([drill]), off.circuits)` and `expanded = [drill]`. Update the `DashState` doc comments and the long comment in `parseState` (the narrowing is now legacy-link compatibility only). `viewState.ts`: drop `offBeforeDrill`, the drill comments and the `isOn`/`onlyThese` imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add web/lib/url-state.ts web/lib/url-state.test.ts web/lib/viewState.ts web/lib/viewState.test.ts
git commit -m "feat(web): offc URL param per circuit; expand replaces drill in explorer state"
```

---

### Task 3: Panel rows, headline and copy with circuits

**Files:**
- Modify: `web/lib/selectionSummary.ts` (whole file), `web/lib/explorerCopy.ts:9-27`
- Test: `web/lib/selectionSummary.test.ts`, `web/lib/explorerCopy.test.ts`

**Interfaces:**
- Consumes: Task 1 `categoryState`, `isCircuitOn`, `isOn`, `type CategoryState`.
- Produces:
  - `type CircuitRow = { name: string; kwh: number; on: boolean }`
  - `type PanelRow = { key: string; kwh: number | null; on: boolean; state: CategoryState; onKwh: number | null; color: string; circuits: CircuitRow[] }` — `onKwh` is the kWh counted in the selection (`kwh` when on, `max(0, kwh − off circuits)` when partial, `0` when off, `null` when `kwh` is null); `circuits` are the rows whose `parent === key`, sorted by kWh descending.
  - `panelRows(rows: EnergyRow[], off: OffSet, circuitRows?: EnergyRow[]): PanelRow[]` (default `[]`)
  - `selectionSummary(rows: EnergyRow[], off: OffSet, circuitRows?: EnergyRow[]): SelectionSummary` (default `[]`; an on category contributes `max(0, v − off circuits' kWh)`; `totalKwh` unchanged)
  - `EXPLORER_COPY.partKwh(on: number, total: number): string` → `"100.8 of 119.0"`; `EXPLORER_COPY.legendPartial(cat: string): string` → `"HVAC (part)"`; `EXPLORER_COPY.circuitsLoading = "Loading circuits…"`. `drillShow`/`drillHide` keep their text ("Show HVAC circuits") and now label the expand button.

- [ ] **Step 1: Write the failing tests**

In `selectionSummary.test.ts` (reuses its `rows` fixture):

```ts
const CTRL = "Heat pump (HP) / Control";
const hvacCircuits: EnergyRow[] = [
  { category: "Auxiliary / Heat pump (HP)", kwh: 2.5, parent: "HVAC" },
  { category: "Heat pump (HP)", kwh: 98.3, parent: "HVAC" },
  { category: CTRL, kwh: 18.2, parent: "HVAC" },
];
const ctrlOff = { categories: [], circuits: [CTRL] };

describe("circuits in the summary", () => {
  it("an off circuit leaves the selection, not the total", () => {
    const s = selectionSummary(rows, ctrlOff, hvacCircuits);
    expect(s.kwh).toBeCloseTo(270.5 - 18.2);
    expect(s.totalKwh).toBeCloseTo(270.5);
  });
  it("circuit rows not loaded yet subtract nothing", () => {
    expect(selectionSummary(rows, ctrlOff, []).kwh).toBeCloseTo(270.5);
  });
  it("clamps a category at zero when its off circuits exceed it", () => {
    const big = [{ category: CTRL, kwh: 500, parent: "HVAC" }];
    expect(selectionSummary(rows, ctrlOff, big).kwh).toBeCloseTo(270.5 - 119);
  });
});

describe("panelRows with circuits", () => {
  it("a partly-off row carries its state, on kWh and circuits sorted by kWh", () => {
    const hvac = panelRows(rows, ctrlOff, hvacCircuits).find((r) => r.key === "HVAC")!;
    expect(hvac.state).toBe("partial");
    expect(hvac.on).toBe(true);
    expect(hvac.onKwh).toBeCloseTo(100.8);
    expect(hvac.circuits.map((c) => [c.name, c.on])).toEqual([
      ["Heat pump (HP)", true], [CTRL, false], ["Auxiliary / Heat pump (HP)", true],
    ]);
  });
  it("on, off and missing rows", () => {
    const p = panelRows([], { categories: ["Car"], circuits: [] });
    expect(p.find((r) => r.key === "Car")).toMatchObject({ state: "off", kwh: null, onKwh: null, circuits: [] });
    const q = panelRows(rows, { categories: ["Car"], circuits: [] });
    expect(q.find((r) => r.key === "Car")!.onKwh).toBe(0);
    expect(q.find((r) => r.key === "Lights")!.onKwh).toBeCloseTo(52.1);
  });
});
```

In `explorerCopy.test.ts`:

```ts
it("partly-off kWh and legend label", () => {
  expect(EXPLORER_COPY.partKwh(100.84, 119)).toBe("100.8 of 119.0");
  expect(EXPLORER_COPY.legendPartial("HVAC")).toBe("HVAC (part)");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/selectionSummary.test.ts lib/explorerCopy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** in `selectionSummary.ts` and `explorerCopy.ts` per the Interfaces block. One private helper, `offKwhIn(circuitRows, off, cat)`, sums `kwh` of rows with `parent === cat` whose circuit is off; both exports use it. Update the `kwhByKey` comment (circuit rows now arrive separately).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/selectionSummary.test.ts lib/explorerCopy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/selectionSummary.ts web/lib/selectionSummary.test.ts web/lib/explorerCopy.ts web/lib/explorerCopy.test.ts
git commit -m "feat(web): panel rows and headline subtract off circuits"
```

---

### Task 4: Band minus off circuits (`lib/stack.ts`)

**Files:**
- Modify: `web/lib/stack.ts` (add one export)
- Test: `web/lib/stack.test.ts`

**Interfaces:**
- Produces: `subtractOffCircuits<T extends number>(byCat: Map<string, Map<T, number>>, circuits: Map<string, Map<T, number>>, offCircuits: readonly string[], categoryOf: (name: string) => string): Map<string, Map<T, number>>` — returns a new outer map; a category with at least one off circuit present in `circuits` gets a new inner map `t → max(0, cat(t) − Σ off(t))` over the category's own times (circuit times missing from the category are ignored, a missing circuit value counts 0); every other category is the same inner `Map` object. Off circuits absent from `circuits` are skipped (their data has not loaded).

- [ ] **Step 1: Write the failing test**

```ts
import { subtractOffCircuits } from "./stack";

const m = (pairs: [number, number][]) => new Map(pairs);
const catOf = (n: string) => (n.startsWith("hp") ? "HVAC" : "Lights");

describe("subtractOffCircuits", () => {
  const byCat = new Map([["HVAC", m([[1, 3], [2, 5]])], ["Lights", m([[1, 1], [2, 1]])]]);
  const circuits = new Map([["hp-ctrl", m([[1, 0.5], [2, 6], [3, 9]])], ["hp-main", m([[1, 2.5], [2, -1]])]]);

  it("removes off circuits from their category, clamped at zero", () => {
    const out = subtractOffCircuits(byCat, circuits, ["hp-ctrl"], catOf);
    expect([...out.get("HVAC")!]).toEqual([[1, 2.5], [2, 0]]);
  });
  it("leaves other categories as the same map", () => {
    const out = subtractOffCircuits(byCat, circuits, ["hp-ctrl"], catOf);
    expect(out.get("Lights")).toBe(byCat.get("Lights"));
  });
  it("skips off circuits with no data yet", () => {
    const out = subtractOffCircuits(byCat, circuits, ["hp-unloaded"], catOf);
    expect(out.get("HVAC")).toBe(byCat.get("HVAC"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/stack.test.ts`
Expected: FAIL ("subtractOffCircuits is not a function").

- [ ] **Step 3: Implement** in `web/lib/stack.ts`, with a comment naming why subtraction is exact (category series = sum of the same per-circuit bucket means).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run lib/stack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/stack.ts web/lib/stack.test.ts
git commit -m "feat(web): stacked band minus its off circuits"
```

---

### Task 5: Chart draws partly-off bands; drill lines retired

**Files:**
- Modify: `web/components/PowerChart.tsx` (anchors below are today's line numbers), `web/lib/drill.ts`, `web/lib/drill.test.ts`

**Interfaces:**
- Consumes: Task 1 `partialCategories`, `offKey`, `showTotal`, `chartCategories`, `categoryState`; Task 3 `EXPLORER_COPY.legendPartial`; Task 4 `subtractOffCircuits`; `categorize` from `lib/categories`; `fetchSeriesCached(fromMs, toMs, interval, drill)` (unchanged).
- Produces: `PowerChart` props unchanged (`state: DashState` now without `drill`).

- [ ] **Step 1: Remove the drill from the chart**

1. `LoadWindow.drill` (:53-54) and every `load.drill` / `state.drill` read; `circuitSeriesRef` (:310), `circuitNames` state (:325), `reconcileCircuitSeries` (:210-247), the drill branch of `Promise.all` (:605-614), the drilled shaping and line `setData` (:622-627, :643-660), the "drill toggled on its own" branch of the window effect (:551-560; drop `state.drill` from its deps at :579), the drill-dependent `setLoading` condition (:596 → `load.resetView` only), the drill legend (:718-761) and `LegendEntry.indent`/`header` if unused.
2. `applyStack(off)` (:347) loses its `drill` parameter; Total visibility (:373) is `showTotal(off)`.
3. `lib/drill.ts`: delete `LEGEND_MAX_CIRCUITS`, the Shades section, the Point budget section (`DRILL_POINT_BUDGET_FACTOR`, `ASSUMED_CIRCUITS_PER_CATEGORY`, `drillInterval`) and the now-unused `interval` import; update the header comment (colors and order only). Delete the `circuitShades` and `drillInterval` describes in `drill.test.ts`; if nothing is left, delete the file.

- [ ] **Step 2: Circuit data for partly-off categories**

1. New ref beside `dataRef` (:315): `circuitDataRef = useRef<{ loadKey: string; byName: Map<string, Map<UTCTimestamp, number>>; cats: Set<string> } | null>(null)`, with `loadKey = \`${load.fromMs}|${load.toMs}|${load.interval}\``. Clear it in the chart teardown (:517).
2. Load effect (:603): fetch `[fetchSeriesCached(load.fromMs, load.toMs, load.interval), ...partialCategories(offRef.current).map((c) => fetchSeriesCached(load.fromMs, load.toMs, load.interval, c))]`. In `.then`, merge every circuit response through `shapeData(...).byCat` into one `byName` and store it with the load's key and the fetched categories.
3. `applyStack` (:350): compute `const byCat = circuitDataRef.current?.loadKey === keyOf(loadRef.current) ? subtractOffCircuits(d.byCat, circuitDataRef.current.byName, off.circuits, categorize) : d.byCat` and pass `byCat` to `stackLayers`.
4. Selection effect (:713-716): deps `[offKey(state.off)]`. It calls `applyStack(state.off)` at once, then, for `partialCategories(state.off)` not in `circuitDataRef.current.cats` for the current load, fetches them at `loadRef.current.interval`, merges into `byName` (only if the load key still matches and the chart is alive; ignore late results otherwise), and calls `applyStack(offRef.current)` again. No spinner and no `setVisibleRange`.

- [ ] **Step 3: Legend**

Bands only: `Total` when `showTotal(state.off)`, then `chartCategories(state.off)` reversed, each `filled`, labelled `EXPLORER_COPY.legendPartial(c)` when `categoryState(state.off, c) === "partial"`, else `c`.

- [ ] **Step 4: Verify**

Run: `cd web && npm test` (PASS; the count drops by the deleted drill tests). `npx tsc --noEmit` reports errors only in `ExplorerClient.tsx` and `CategoryPanel.tsx` (Task 6).

- [ ] **Step 5: Commit**

```bash
git add web/components/PowerChart.tsx web/lib/drill.ts web/lib/drill.test.ts
git commit -m "feat(web): chart bands follow circuit selection; drill lines retired"
```

---

### Task 6: Circuit rows in the panel, circuit energy, URL and table wiring

**Files:**
- Modify: `web/components/CategoryPanel.tsx` (whole file), `web/components/ExplorerClient.tsx:18-24, 72-82, 105-124, 166-181`

**Interfaces:**
- Consumes: Task 1 `toggle`, `toggleCircuit`, `pruneCircuits`, `categoriesNeedingCircuits`, `isCircuitOn`, `offKey`, `activePreset`, `presetOff`; Task 2 `expand` action, `buildIntentSearch(range, off, events)`, `view.expanded`; Task 3 `panelRows`, `selectionSummary`, `PanelRow`, `EXPLORER_COPY.partKwh`/`circuitsLoading`/`drillShow`/`drillHide`; `fetchEnergyCached(fromMs, toMs, drill)`; `mergeDrillRows(rows, circuitRows, drill)`.
- Produces: `CategoryPanel({ rows, off, expanded, period, onSelect, onExpand }: { rows: PanelRow[]; off: OffSet; expanded: readonly string[]; period: string | null; onSelect: (off: OffSet) => void; onExpand: (cat: string) => void })`.

- [ ] **Step 1: `CategoryPanel.tsx`**

1. Category checkbox: `checked={row.state === "on"}`, plus `ref={(el) => { if (el) el.indeterminate = row.state === "partial"; }}` (React has no `indeterminate` prop); `onChange` → `onSelect(toggle(off, row.key))`.
2. kWh cell: `row.state === "partial" && row.onKwh !== null && row.kwh !== null ? EXPLORER_COPY.partKwh(row.onKwh, row.kwh) : row.kwh?.toFixed(1) ?? EXPLORER_COPY.noKwh`. Muted when `state === "off"`.
3. The ⌄/✕ button (today :79-95) shows on every row except `UNMONITORED`, whether on or off; `aria-expanded={expanded.includes(row.key)}`, labels from `drillShow`/`drillHide`, `onClick={() => onExpand(row.key)}`.
4. When expanded: if `row.circuits` is empty, one muted `text-xs` line `EXPLORER_COPY.circuitsLoading`; else one indented (`pl-6`) `<label>` per circuit, `min-h-[36px]`, checkbox `checked={c.on}` → `onSelect(toggleCircuit(off, c.name, row.circuits.map((x) => x.name)))`, the name (`truncate`, `title={c.name}`), and `c.kwh.toFixed(1)` in `tabular-nums`, muted when off.
5. Update the component's doc comment.

- [ ] **Step 2: `ExplorerClient.tsx`**

1. URL effect (:74-82): `buildIntentSearch(view.rangePreset, view.off, view.events)`, deps `[view.rangePreset, offKey(view.off), view.events]`.
2. Replace the drilled circuit-rows effect (:105-124) with circuit energy: `const needCats = categoriesNeedingCircuits(view.off, view.expanded)`; state `circuitEnergy: Map<string, EnergyRow[]>`; effect on `[visible.fromMs, visible.toMs, needCats.join(",")]` runs `Promise.all(needCats.map((c) => fetchEnergyCached(visible.fromMs, visible.toMs, c).catch(() => [])))` and sets the map (cancel guard as today).
3. Prune effect on `[circuitEnergy]`: for each `(cat, rows)`, `next = pruneCircuits(next, cat, rows.map((r) => r.category))`; dispatch `select` only if `next !== view.off`.
4. Derivations (:166-181): `const circuitRows = [...circuitEnergy.values()].flat()`; `panelRows(rows, view.off, circuitRows)`; `selectionSummary(rows, view.off, circuitRows)`; table: `view.expanded.reduce((acc, cat) => mergeDrillRows(acc, (circuitEnergy.get(cat) ?? []).filter((r) => isCircuitOn(view.off, r.category)), cat), filtered)`.
5. `panelProps`: replace `drill`/`onDrill` with `expanded: view.expanded` and `onExpand: (category) => dispatch({ type: "expand", category })`. Drop unused imports (`serializeOff`).

- [ ] **Step 3: Manual verify**

Run `cd web && npx tsc --noEmit` (no errors), then `npm run dev`. Pass when all hold:
1. http://localhost:3000/?range=7d loads with no `offc` and no extra `/api/*?drill=` request in devtools Network.
2. Clicking ⌄ on HVAC lists its circuits sorted by kWh with checkboxes and kWh (one `/api/energy?drill=HVAC` request).
3. Unticking `Heat pump (HP) / Control`: HVAC's box goes indeterminate, its row reads "N of M", the headline kWh drops by that circuit's kWh, the HVAC band shrinks and the y-axis rescales, Total and the "Everything" highlight disappear, the legend reads "HVAC (part)", and the URL becomes `/?range=7d&offc=Heat%20pump%20(HP)%20%2F%20Control`. One `/api/power?drill=HVAC` request.
4. Reloading that URL restores the same state (box indeterminate, band shrunk).
5. Clicking the indeterminate HVAC box ticks every HVAC circuit and the URL drops `offc`.
6. Unticking all three HVAC circuits one by one leaves HVAC plainly unticked and the URL at `off=HVAC`.
7. "Everything" after any circuit change clears all circuit state.
8. Expanding Lights and unticking `Lights / Living room, Upstairs` writes `offc=Lights%20%2F%20Living%20room%2C%20Upstairs`.
9. http://localhost:3000/?range=7d&show=HVAC&drill=HVAC opens HVAC only with HVAC expanded, draws no circuit lines, and the URL is rewritten without `drill`.
10. http://localhost:3000/?offc=Heat%20pump%20(gone) shows HVAC partly off until its circuit rows load (expand HVAC), then HVAC is all on and `offc` is gone.
11. Changing range with a circuit off keeps the band shrunk after the reload; panning never changes the URL; no console errors.

Fail: any of these does not hold.

- [ ] **Step 4: Commit**

```bash
git add web/components/CategoryPanel.tsx web/components/ExplorerClient.tsx
git commit -m "feat(web): circuit checkboxes with kWh in the Power Explorer panel"
```

---

### Task 7: Verify the whole branch and update docs

**Files:**
- Modify: `CLAUDE.md` (§ web/ "Selection" bullet at :146; Next Steps "Decided 2026-11-23" item (1) at :221-227 only)

- [ ] **Step 1: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 2: Tests**

Run: `cd web && npm test`
Expected: all pass (298 minus the deleted `drill.test.ts` cases plus the new ones); report the count.

- [ ] **Step 3: Build**

Run: `cd web && npm run build`
Expected: succeeds and lists `/`.

- [ ] **Step 4: Leftover grep**

Run: `cd web && grep -rn "offBeforeDrill\|drillInterval\|circuitShades\|isFiltered\|view\.drill\|state\.drill" app components lib`
Expected: no matches.

- [ ] **Step 5: CLAUDE.md**

1. § web/ "Selection" bullet (:146): add, in this repo's prose style, that the off set also holds circuits (`offc=`, repeated, one `encodeURIComponent`-encoded value per circuit); a partly-off category shows an indeterminate box and draws as category minus its off circuits (`subtractOffCircuits` in `lib/stack.ts`); circuit data is the drill endpoints fetched only for expanded or partly-off categories at the category bucket; Total shows only while all five chart categories are on and no circuit is off; the drill's circuit lines and narrow-to-one focus are retired (⌄ expands circuit rows; legacy `drill=` parses as expanded + narrowed); a renamed circuit drops out of `offc` once its category's rows load. Name this plan's path. Say "built on branch `explorer-circuits`, not merged" (the merging session edits it).
2. Next Steps item (1) (:221-227): replace "step 2 (circuits) is still to do" with "step 2 (circuits) is built on branch `explorer-circuits`, stacked on it, not merged". Do not touch the entry's heading line (:219) or item (2).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: Power Explorer circuit selection built"
```
