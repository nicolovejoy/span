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

/** The dotted Total line (whole house) is the reference for the full stack, so
 *  it shows unless a chart category is off. Unmonitored has no power series:
 *  turning only it off changes the numbers, not the chart. */
export const showTotal = (off: OffSet): boolean =>
  chartCategories(off).length === CATEGORY_ORDER.length;

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

/** Legacy `show=` (a list of what is ON; empty = all) → OffSet. A list with no
 *  known name (`show=Furnace`) is treated like an empty one: everything on. */
export const offFromShow = (show: readonly string[]): OffSet =>
  show.some((k) => SELECTABLE.includes(k)) ? onlyThese(show) : EVERYTHING;

export const parseOff = (raw: string | undefined): OffSet => ({
  categories: canonical((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
});

export const serializeOff = (off: OffSet): string => canonical(off.categories).join(",");

const UNMONITORED_COLOR = "#94a3b8";
export const selectableColor = (key: string): string =>
  key === UNMONITORED ? UNMONITORED_COLOR : categoryColor(key);
