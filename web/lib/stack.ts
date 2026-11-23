// Cumulative layers for the stacked power chart. The chart draws these as area
// series with the top layer at the back, so each visible band shows its own
// category: a layer's value is the running total of every on category up to
// and including itself, and a category that is off contributes nothing, so the
// layer above it drops down to close the gap.

export function stackLayers<T extends number>(
  order: readonly string[],
  on: readonly string[],
  byCat: Map<string, Map<T, number>>,
  times: readonly T[],
): Map<string, { time: T; value: number }[]> {
  const running = new Array<number>(times.length).fill(0);
  const layers = new Map<string, { time: T; value: number }[]>();
  for (const cat of order) {
    if (!on.includes(cat)) continue;
    const series = byCat.get(cat);
    layers.set(
      cat,
      times.map((time, i) => {
        running[i] += Math.max(0, series?.get(time) ?? 0);
        return { time, value: running[i] };
      }),
    );
  }
  return layers;
}

/** Each category's series minus the series of its off circuits, so a band
 *  shows only what is ticked. Subtraction is exact because the category series
 *  is the sum of the same per-circuit bucket means. A category with no off
 *  circuit loaded keeps its original inner map (same object); results clamp at
 *  0 and only the category's own times appear. */
export function subtractOffCircuits<T extends number>(
  byCat: Map<string, Map<T, number>>,
  circuits: Map<string, Map<T, number>>,
  offCircuits: readonly string[],
  categoryOf: (name: string) => string,
): Map<string, Map<T, number>> {
  const out = new Map(byCat);
  const offByCat = new Map<string, Map<T, number>[]>();
  for (const name of offCircuits) {
    const series = circuits.get(name);
    if (!series) continue; // not loaded yet
    const cat = categoryOf(name);
    offByCat.set(cat, [...(offByCat.get(cat) ?? []), series]);
  }
  for (const [cat, seriesList] of offByCat) {
    const base = byCat.get(cat);
    if (!base) continue;
    const next = new Map<T, number>();
    for (const [t, v] of base) {
      const off = seriesList.reduce((sum, s) => sum + (s.get(t) ?? 0), 0);
      next.set(t, Math.max(0, v - off));
    }
    out.set(cat, next);
  }
  return out;
}
