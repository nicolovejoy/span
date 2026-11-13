// One period's energy → the /trends stack layers. Pure.
// The HVAC layers always add up to the HVAC circuit total (counter-based):
// "controls" is the HVAC circuits the classifier never reads (the heat pump's
// control circuit: controller, pumps); "unclassified" absorbs `ambiguous` plus
// any disagreement between hvac_mode's integral energy and the classified
// circuits' counter (under 1% in practice). When modes exceed the circuit,
// unclassified clamps to 0 and residualKwh goes negative (logged upstream).

/** The circuits pi/hvac_classifier.py reads (HP_CIRCUIT, AUX_CIRCUIT). Any
 *  other circuit in the HVAC category has no hvac_mode energy. */
export const HVAC_CLASSIFIED_CIRCUITS = ["Heat pump (HP)", "Auxiliary / Heat pump (HP)"];

export type PeriodEnergy = {
  /** Top-level category kWh for the split part of the period, with the
   *  pre-split part's non-HVAC energy already added in. */
  categories: Record<string, number>;
  /** HVAC circuit kWh before HVAC_SPLIT_START_MS. */
  preSplitHvacKwh: number;
  modes: { heat: number; cool: number; hotWater: number; idle: number; ambiguous: number };
  bathKwh: number;
  /** kWh of HVAC-category circuits outside HVAC_CLASSIFIED_CIRCUITS (split side). */
  controlsKwh: number;
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
  detail: { standby: number; controls: number; unclassified: number; bath: number; other: number; unmonitored: number };
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
  const controls = Math.min(e.controlsKwh, hvac);
  const unclassified = Math.max(0, hvac - controls - heat - cool - hotWater - idle);
  const other = c("Else");
  const unmonitored = c("Unmonitored");
  const layers = {
    hvacUnsplit: e.preSplitHvacKwh,
    heat,
    cool,
    hotWater,
    hvacOther: idle + controls + unclassified,
    car: c("Car"),
    lights: c("Lights"),
    appliances: c("Appliances"),
    rest: other + unmonitored,
  };
  return {
    ...layers,
    detail: {
      standby: idle,
      controls,
      unclassified,
      bath: Math.min(e.bathKwh, hotWater),
      other,
      unmonitored,
    },
    totalKwh: LAYER_ORDER.reduce((s, k) => s + layers[k], 0),
    residualKwh: hvac - controls - (heat + cool + hotWater + idle + ambiguous),
  };
}

type Row = { category: string; kwh: number; parent?: string };

/** Merge the two sides of a period cut at HVAC_SPLIT_START_MS (either may be
 *  null when the period lies wholly on one side). Only top-level rows count;
 *  nested HVAC mode rows are ignored — modes come from `modeSums`, queried
 *  over the split side only. `hvacCircuits` is the split side's HVAC category
 *  drilled into circuits (row.category = circuit name). */
export function combinePeriodEnergy(p: {
  pre: Row[] | null;
  post: Row[] | null;
  modeSums: Record<string, number>;
  bathKwh: number;
  hvacCircuits?: Row[] | null;
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
    controlsKwh: (p.hvacCircuits ?? [])
      .filter((r) => !HVAC_CLASSIFIED_CIRCUITS.includes(r.category))
      .reduce((s, r) => s + r.kwh, 0),
  };
}
