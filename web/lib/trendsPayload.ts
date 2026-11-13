// Periods + layers for a /trends view, shared by the API route and the SSR
// page. The energy fetcher is injected so this stays testable without Influx.

import { trendPeriods, type TrendGrain, type TrendPeriod } from "./trends";
import { deriveLayers, type PeriodEnergy, type TrendLayers } from "./trendLayers";

export type TrendBar = TrendPeriod & { layers: TrendLayers };

/** Above this share of the HVAC circuit, the hvac_mode/counter disagreement is
 *  worth a log line (spec: flag it if it's more than a few percent). */
const RESIDUAL_WARN_SHARE = 0.05;

export async function trendsPayload(
  s: { grain: TrendGrain; endKey: string | null },
  nowMs: number,
  fetchPeriod: (p: TrendPeriod) => Promise<PeriodEnergy>,
): Promise<TrendBar[]> {
  const periods = trendPeriods({ grain: s.grain, endKey: s.endKey, nowMs });
  const energies = await Promise.all(periods.map(fetchPeriod));
  return periods.map((p, i) => {
    const e = energies[i];
    const layers = deriveLayers(e);
    const hvac = e.categories.HVAC ?? 0;
    if (Math.abs(layers.residualKwh) > RESIDUAL_WARN_SHARE * hvac && hvac > 0) {
      console.warn(
        `[trends] ${s.grain} ${p.key}: hvac_mode residual ${layers.residualKwh.toFixed(1)} kWh of HVAC ${hvac.toFixed(1)} kWh`,
      );
    }
    return { ...p, layers };
  });
}
