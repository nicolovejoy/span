// The Unmonitored chart band: the overflow subpanel (washer, dryer, …) plus
// metering slop, as the panel's grid power minus every named circuit — the same
// residual as the Unmonitored kWh row (energyWindow.unmonitoredKwh, #17), so
// the band reconciles with it. Not panel.feedthrough_power_w: that meter reads
// ~2% off this residual and swings negative.
//
// Floored at 0 per bucket, so the six series sum to max(grid, Σ categories) =
// the top of the stack = the Total line. The kWh row floors once per period,
// so over a period the band's area is >= the row by the clamped buckets.

import type { SeriesPoint } from "./influx";

export type GridPoint = { time: string; watts: number };

const SERIES = "Unmonitored";

export function unmonitoredSeries(
  categories: readonly SeriesPoint[],
  grid: readonly GridPoint[],
): SeriesPoint[] {
  const circuitsAt = new Map<number, number>();
  for (const p of categories) {
    const t = Date.parse(p.time);
    circuitsAt.set(t, (circuitsAt.get(t) ?? 0) + p.watts);
  }
  const out: SeriesPoint[] = [];
  for (const g of grid) {
    if (!Number.isFinite(g.watts)) continue;
    const circuits = circuitsAt.get(Date.parse(g.time));
    // No category point: a gap in circuit data, not a bucket where the whole
    // house was the subpanel.
    if (circuits === undefined) continue;
    out.push({ time: g.time, series: SERIES, watts: Math.max(0, g.watts - circuits) });
  }
  return out;
}
