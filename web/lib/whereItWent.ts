// "Where it went" panel rows: every purpose summed over the ranked periods,
// sorted by size (ties in the spec's fixed order). Pure. House only: the car
// is reported on its own line (`car`), outside the ranking and every total.

import { costForKwh, proratedBaseCharge } from "./rates";
import type { TrendBar } from "./trendsPayload";
import type { PANEL_LABELS } from "./trendsCopy";

export type TrendUnit = "kwh" | "usd";
export type PanelKey = keyof typeof PANEL_LABELS;
export type PanelRow = { key: PanelKey; kwh: number; value: number; share: number };

const ORDER: Exclude<PanelKey, "baseCharge" | "car">[] = [
  "hvacUnsplit", "heat", "cool", "hotWater", "unclassified", "controls", "standby",
  "lights", "appliances", "other", "unmonitored",
];

export function panelRows(periods: TrendBar[], unit: TrendUnit) {
  const kwh: Record<string, number> = Object.fromEntries(ORDER.map((k) => [k, 0]));
  let bathKwh = 0;
  let carKwh = 0;
  let houseKwh = 0;
  let baseCharge = 0;
  for (const p of periods) {
    const l = p.layers;
    kwh.hvacUnsplit += l.hvacUnsplit;
    kwh.heat += l.heat;
    kwh.cool += l.cool;
    kwh.hotWater += l.hotWater;
    kwh.unclassified += l.detail.unclassified;
    kwh.standby += l.detail.standby;
    kwh.controls += l.detail.controls;
    carKwh += l.car;
    houseKwh += l.houseKwh;
    kwh.lights += l.lights;
    kwh.appliances += l.appliances;
    kwh.other += l.detail.other;
    kwh.unmonitored += l.detail.unmonitored;
    bathKwh += l.detail.bath;
    baseCharge += proratedBaseCharge(p.toMs - p.fromMs);
  }
  const val = (k: number) => (unit === "usd" ? costForKwh(k) : k);
  const rows: Omit<PanelRow, "share">[] = ORDER.filter((k) => kwh[k] > 0.05)
    .map((k) => ({ key: k, kwh: kwh[k], value: val(kwh[k]) }))
    .sort((a, b) => b.kwh - a.kwh || ORDER.indexOf(a.key as never) - ORDER.indexOf(b.key as never));
  if (unit === "usd") rows.push({ key: "baseCharge", kwh: 0, value: baseCharge });
  // From the unfiltered sums, not the listed rows: rows under 0.05 kWh are dropped.
  const totalKwh = houseKwh;
  const totalValue = val(totalKwh) + (unit === "usd" ? baseCharge : 0);
  return {
    rows: rows.map((r) => ({ ...r, share: totalValue > 0 ? r.value / totalValue : 0 })),
    totalValue,
    totalKwh,
    bathKwh,
    car: { kwh: carKwh, usd: costForKwh(carKwh) },
  };
}
