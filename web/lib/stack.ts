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
