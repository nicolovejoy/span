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
