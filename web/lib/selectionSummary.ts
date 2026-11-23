import { costForKwh } from "./rates";
import {
  SELECTABLE, categoryState, isCircuitOn, isOn, selectableColor,
  type CategoryState, type OffSet,
} from "./selection";
import type { EnergyRow } from "./queryCache";

export type CircuitRow = { name: string; kwh: number; on: boolean };
export type PanelRow = {
  key: string;
  kwh: number | null;
  on: boolean;
  state: CategoryState;
  /** kWh counted in the selection: all of it when on, the category minus its
   *  off circuits (floored at 0) when partial, 0 when off, null while unknown. */
  onKwh: number | null;
  color: string;
  circuits: CircuitRow[];
};
export type SelectionSummary = {
  kwh: number; totalKwh: number; share: number | null; cost: number; onCount: number; count: number;
};

/** Top-level kWh per selectable key; the category rows. Per-circuit rows
 *  (`parent` set) arrive separately as `circuitRows`. */
const kwhByKey = (rows: EnergyRow[]) =>
  new Map(rows.filter((r) => !r.parent).map((r) => [r.category, r.kwh]));

/** kWh of a category's circuits that are turned off. Circuit rows not loaded
 *  yet contribute nothing. */
const offKwhIn = (circuitRows: EnergyRow[], off: OffSet, cat: string): number =>
  circuitRows
    .filter((r) => r.parent === cat && !isCircuitOn(off, r.category))
    .reduce((sum, r) => sum + r.kwh, 0);

export function panelRows(
  rows: EnergyRow[],
  off: OffSet,
  circuitRows: EnergyRow[] = [],
): PanelRow[] {
  const by = kwhByKey(rows);
  return SELECTABLE.map((key) => {
    const kwh = by.get(key) ?? null;
    const state = categoryState(off, key);
    const onKwh =
      kwh === null ? null
      : state === "off" ? 0
      : state === "partial" ? Math.max(0, kwh - offKwhIn(circuitRows, off, key))
      : kwh;
    const circuits = circuitRows
      .filter((r) => r.parent === key)
      .map((r) => ({ name: r.category, kwh: r.kwh, on: isCircuitOn(off, r.category) }))
      .sort((a, b) => b.kwh - a.kwh);
    return { key, kwh, on: isOn(off, key), state, onKwh, color: selectableColor(key), circuits };
  });
}

export function selectionSummary(
  rows: EnergyRow[],
  off: OffSet,
  circuitRows: EnergyRow[] = [],
): SelectionSummary {
  const by = kwhByKey(rows);
  let kwh = 0;
  let totalKwh = 0;
  for (const key of SELECTABLE) {
    const v = by.get(key) ?? 0;
    if (v <= 0) continue; // same rule as BreakdownTable: negatives are bad data
    totalKwh += v;
    if (isOn(off, key)) kwh += Math.max(0, v - offKwhIn(circuitRows, off, key));
  }
  const onCount = SELECTABLE.filter((k) => isOn(off, k)).length;
  return {
    kwh, totalKwh, share: totalKwh > 0 ? kwh / totalKwh : null,
    cost: costForKwh(kwh), onCount, count: SELECTABLE.length,
  };
}
