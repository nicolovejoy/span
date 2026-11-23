// What the explorer shows, stored as what is turned OFF, so the default URL is
// clean and a category added later defaults to on. Category level only; the
// circuits are stored the same way, as `circuits` (names that are off inside a
// category that is otherwise on; a category that is off carries no circuit
// names). Callers go through these helpers rather than reading the arrays
// directly.

import { categorize } from "./categories";
import { CATEGORY_ORDER, categoryColor } from "./drill";

export type OffSet = { categories: string[]; circuits: string[] };
export type CategoryState = "on" | "partial" | "off";

export const UNMONITORED = "Unmonitored";
export const SELECTABLE: readonly string[] = [...CATEGORY_ORDER, UNMONITORED];
export const EVERYTHING: OffSet = { categories: [], circuits: [] };

const canonical = (keys: Iterable<string>): string[] => {
  const set = new Set(keys);
  return SELECTABLE.filter((k) => set.has(k));
};

const categoryOf = categorize;
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const isOn = (off: OffSet, key: string): boolean => !off.categories.includes(key);

export const offCircuitsIn = (off: OffSet, cat: string): string[] =>
  off.circuits.filter((c) => categoryOf(c) === cat);

export const isCircuitOn = (off: OffSet, name: string): boolean =>
  isOn(off, categoryOf(name)) && !off.circuits.includes(name);

export function categoryState(off: OffSet, cat: string): CategoryState {
  if (!isOn(off, cat)) return "off";
  return offCircuitsIn(off, cat).length > 0 ? "partial" : "on";
}

/** Categories with some but not all circuits off, in stack order. */
export const partialCategories = (off: OffSet): string[] =>
  CATEGORY_ORDER.filter((c) => categoryState(off, c) === "partial");

/** Sorted, deduped, no empty names, none inside a category that is off. */
const normalCircuits = (off: OffSet, names: readonly string[]): string[] =>
  [...new Set(names)]
    .filter((n) => n !== "" && isOn(off, categoryOf(n)))
    .sort(byName);

export const withCircuits = (off: OffSet, names: readonly string[]): OffSet => ({
  ...off,
  circuits: normalCircuits(off, names),
});

/** Category click: partly off → all on; on → off; off → on (every circuit). */
export function toggle(off: OffSet, key: string): OffSet {
  const rest = off.circuits.filter((c) => categoryOf(c) !== key);
  if (categoryState(off, key) === "on") {
    return { categories: canonical([...off.categories, key]), circuits: rest };
  }
  return {
    categories: off.categories.filter((k) => k !== key),
    circuits: rest,
  };
}

/** Circuit click. `members` is the category's full circuit list; an empty list
 *  (not loaded) never prunes and never counts as "all off". */
export function toggleCircuit(off: OffSet, name: string, members: readonly string[]): OffSet {
  const cat = categoryOf(name);
  const known = members.length > 0;
  const kept = off.circuits.filter(
    (c) => categoryOf(c) !== cat || !known || members.includes(c) || c === name,
  );
  if (!isOn(off, cat)) {
    // Category off: tick just this circuit, leaving its siblings off.
    return withCircuits(
      { ...off, categories: off.categories.filter((k) => k !== cat) },
      [...kept, ...members.filter((m) => m !== name)],
    );
  }
  if (kept.includes(name)) {
    return withCircuits(off, kept.filter((c) => c !== name));
  }
  const next = [...kept, name];
  const inCat = new Set(next.filter((c) => categoryOf(c) === cat));
  if (known && members.every((m) => inCat.has(m))) {
    return withCircuits(
      { ...off, categories: canonical([...off.categories, cat]) },
      next.filter((c) => categoryOf(c) !== cat),
    );
  }
  return withCircuits(off, next);
}

/** Forget a category's off-circuit names that no longer exist (renamed or
 *  removed on the panel). Same object back when nothing changes; an empty
 *  `members` (a failed fetch) never prunes. */
export function pruneCircuits(off: OffSet, cat: string, members: readonly string[]): OffSet {
  if (members.length === 0) return off;
  const kept = off.circuits.filter((c) => categoryOf(c) !== cat || members.includes(c));
  return kept.length === off.circuits.length ? off : { ...off, circuits: kept };
}

/** Categories whose circuit list must be fetched: expanded in the panel or
 *  partly off, in stack order. Unmonitored has no circuits. */
export const categoriesNeedingCircuits = (off: OffSet, expanded: readonly string[]): string[] =>
  CATEGORY_ORDER.filter((c) => expanded.includes(c) || categoryState(off, c) === "partial");

export const onlyThese = (keys: readonly string[]): OffSet => ({
  categories: SELECTABLE.filter((k) => !keys.includes(k)),
  circuits: [],
});

export const chartCategories = (off: OffSet): string[] =>
  CATEGORY_ORDER.filter((c) => isOn(off, c));

/** The dotted Total line (whole house) is the reference for the full stack, so
 *  it shows unless a chart category or a circuit is off. Unmonitored has no
 *  power series: turning only it off changes the numbers, not the chart. */
export const showTotal = (off: OffSet): boolean =>
  chartCategories(off).length === CATEGORY_ORDER.length && off.circuits.length === 0;

export type PresetId = "everything" | "house" | "hvac" | "car";
export const PRESET_IDS: readonly PresetId[] = ["everything", "house", "hvac", "car"];

export function presetOff(id: PresetId): OffSet {
  switch (id) {
    case "everything": return EVERYTHING;
    case "house": return { categories: ["Car"], circuits: [] };
    case "hvac": return onlyThese(["HVAC"]);
    case "car": return onlyThese(["Car"]);
  }
}

/** One string for the whole selection, categories and circuits, for equality
 *  and cache keys. */
export const offKey = (off: OffSet): string =>
  JSON.stringify([serializeOff(off), normalCircuits(off, off.circuits)]);

export const sameOff = (a: OffSet, b: OffSet): boolean => offKey(a) === offKey(b);

export const activePreset = (off: OffSet): PresetId | null =>
  PRESET_IDS.find((id) => sameOff(presetOff(id), off)) ?? null;

/** Legacy `show=` (a list of what is ON; empty = all) → OffSet. A list with no
 *  known name (`show=Furnace`) is treated like an empty one: everything on. */
export const offFromShow = (show: readonly string[]): OffSet =>
  show.some((k) => SELECTABLE.includes(k)) ? onlyThese(show) : EVERYTHING;

export const parseOff = (raw: string | undefined): OffSet => ({
  categories: canonical((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  circuits: [],
});

export const serializeOff = (off: OffSet): string => canonical(off.categories).join(",");

const UNMONITORED_COLOR = "#94a3b8";
export const selectableColor = (key: string): string =>
  key === UNMONITORED ? UNMONITORED_COLOR : categoryColor(key);
