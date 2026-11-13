// One period's energy → the /trends stack layers. Pure.
// The HVAC layers always add up to the HVAC circuit total (counter-based):
// "unclassified" absorbs `ambiguous` plus any disagreement between hvac_mode's
// integral energy and the circuit counter. When modes exceed the circuit,
// unclassified clamps to 0 and residualKwh goes negative (logged upstream).

export type PeriodEnergy = {
  /** Top-level category kWh for the split part of the period, with the
   *  pre-split part's non-HVAC energy already added in. */
  categories: Record<string, number>;
  /** HVAC circuit kWh before HVAC_SPLIT_START_MS. */
  preSplitHvacKwh: number;
  modes: { heat: number; cool: number; hotWater: number; idle: number; ambiguous: number };
  bathKwh: number;
};

export type TrendLayers = {
  hvacUnsplit: number;
  heat: number;
  cool: number;
  hotWater: number;
  hvacOther: number;
  car: number;
  lights: number;
  appliances: number;
  rest: number;
  detail: { standby: number; unclassified: number; bath: number; other: number; unmonitored: number };
  totalKwh: number;
  residualKwh: number;
};

export const LAYER_ORDER = [
  "hvacUnsplit",
  "heat",
  "cool",
  "hotWater",
  "hvacOther",
  "car",
  "lights",
  "appliances",
  "rest",
] as const;

export type LayerKey = (typeof LAYER_ORDER)[number];

export function deriveLayers(e: PeriodEnergy): TrendLayers {
  const c = (k: string) => e.categories[k] ?? 0;
  const hvac = c("HVAC");
  const { heat, cool, hotWater, idle, ambiguous } = e.modes;
  const unclassified = Math.max(0, hvac - heat - cool - hotWater - idle);
  const other = c("Else");
  const unmonitored = c("Unmonitored");
  const layers = {
    hvacUnsplit: e.preSplitHvacKwh,
    heat,
    cool,
    hotWater,
    hvacOther: idle + unclassified,
    car: c("Car"),
    lights: c("Lights"),
    appliances: c("Appliances"),
    rest: other + unmonitored,
  };
  return {
    ...layers,
    detail: {
      standby: idle,
      unclassified,
      bath: Math.min(e.bathKwh, hotWater),
      other,
      unmonitored,
    },
    totalKwh: LAYER_ORDER.reduce((s, k) => s + layers[k], 0),
    residualKwh: hvac - (heat + cool + hotWater + idle + ambiguous),
  };
}

type Row = { category: string; kwh: number; parent?: string };

/** Merge the two sides of a period cut at HVAC_SPLIT_START_MS (either may be
 *  null when the period lies wholly on one side). Only top-level rows count;
 *  nested HVAC mode rows are ignored — modes come from `modeSums`, queried
 *  over the split side only. */
export function combinePeriodEnergy(p: {
  pre: Row[] | null;
  post: Row[] | null;
  modeSums: Record<string, number>;
  bathKwh: number;
}): PeriodEnergy {
  const categories: Record<string, number> = {};
  let preSplitHvacKwh = 0;
  const add = (rows: Row[] | null, side: "pre" | "post") => {
    for (const r of rows ?? []) {
      if (r.parent) continue;
      if (side === "pre" && r.category === "HVAC") preSplitHvacKwh += r.kwh;
      else categories[r.category] = (categories[r.category] ?? 0) + r.kwh;
    }
  };
  add(p.pre, "pre");
  add(p.post, "post");
  const m = (f: string) => p.modeSums[`energy_${f}_kwh`] ?? 0;
  return {
    categories,
    preSplitHvacKwh,
    modes: { heat: m("heat"), cool: m("cool"), hotWater: m("hot_water"), idle: m("idle"), ambiguous: m("ambiguous") },
    bathKwh: p.bathKwh,
  };
}
