// Per-circuit drill-down (#12). One category at a time can be expanded into its
// member circuits: the chart swaps that category's single line for one line per
// circuit, and the table indents circuit rows under the category subtotal.
//
// Everything here is pure — colors, the point budget, and the palette/order the
// chart used to own inline. Membership itself is not duplicated: which circuits
// belong to a category is decided by the shared regex rules in ./categories.

import {
  INTERVAL_ORDER,
  MAX_BUCKETS,
  intervalSeconds,
  type IntervalKey,
} from "./interval";

export const CATEGORY_COLORS: Record<string, string> = {
  HVAC: "#ef4444",
  Car: "#3b82f6",
  Lights: "#eab308",
  Appliances: "#8b5cf6",
  Else: "#6b7280",
};

export const CATEGORY_ORDER = [
  "HVAC",
  "Car",
  "Lights",
  "Appliances",
  "Else",
] as const;

export const categoryColor = (cat: string): string =>
  CATEGORY_COLORS[cat] ?? "#888";

/** Most circuit lines the legend lists before collapsing to "+N more". The
 *  chart still draws every circuit — this only bounds the label stack, which
 *  otherwise overruns the plot area for a big category (Else is 10+). */
export const LEGEND_MAX_CIRCUITS = 6;

// ---------------------------------------------------------------------------
// Shades
// ---------------------------------------------------------------------------

type Hsl = { h: number; s: number; l: number };

function hexToHsl(hex: string): Hsl {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  // Unknown categories fall back to the neutral grey the chart already uses.
  const int = m ? parseInt(m[1]!, 16) : 0x888888;
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex({ h, s, l }: Hsl): string {
  const sat = s / 100;
  const lum = l / 100;
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lum - c / 2;
  const seg = Math.floor(((h % 360) + 360) % 360 / 60);
  const [r1, g1, b1] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[seg] ?? [c, x, 0];
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

/** Lightness swing either side of the parent color, in HSL percentage points. */
const SPREAD_L = 22;
/** Clamps — outside this band shades stop being legible on either theme. */
const MIN_L = 26;
const MAX_L = 76;

/**
 * `n` tints/shades of the parent category color, evenly spaced in lightness and
 * keeping the parent's hue so the family still reads as one category. Index
 * order is the caller's (circuits are sorted by name), so a circuit keeps the
 * same shade across renders as long as the member set doesn't change.
 */
export function circuitShades(baseHex: string, n: number): string[] {
  if (n <= 0) return [];
  const base = hexToHsl(baseHex);
  if (n === 1) return [hslToHex(base)];
  const lo = Math.max(MIN_L, base.l - SPREAD_L);
  const hi = Math.min(MAX_L, base.l + SPREAD_L);
  return Array.from({ length: n }, (_, i) =>
    hslToHex({ ...base, l: lo + ((hi - lo) * i) / (n - 1) }),
  );
}

// ---------------------------------------------------------------------------
// Point budget
// ---------------------------------------------------------------------------

/**
 * A drilled fetch returns one series *per circuit* instead of one per category,
 * so the row count is multiplied by the member count. MAX_BUCKETS bounds a
 * single category series; allow the drilled fetch this multiple of it before
 * coarsening — enough that a typical 3–5 circuit category never coarsens at all,
 * while a 12-circuit Else at a fine bucket still can't hand the Pi a query an
 * order of magnitude bigger than anything the category view ever issues.
 */
export const DRILL_POINT_BUDGET_FACTOR = 4;

/**
 * Circuits assumed to be in a category when planning the fetch. The panel has
 * 21 circuits total and the biggest bucket (Else) holds roughly half of them.
 * A static estimate — not the live count — keeps `drillInterval` pure and the
 * cache key stable: deriving it from the response would change the interval
 * *after* the fetch and force a second round trip. Being wrong only costs one
 * coarser bucket step.
 */
export const ASSUMED_CIRCUITS_PER_CATEGORY = 12;

/**
 * Bucket to fetch drilled data at: the requested one, coarsened just far enough
 * that circuits × buckets fits the budget above. Never *finer* than requested.
 */
export function drillInterval(
  requested: IntervalKey,
  fromMs: number,
  toMs: number,
  circuitCount: number = ASSUMED_CIRCUITS_PER_CATEGORY,
): IntervalKey {
  const budget = DRILL_POINT_BUDGET_FACTOR * MAX_BUCKETS;
  const spanSec = Math.max(1, (toMs - fromMs) / 1000);
  const circuits = Math.max(1, circuitCount);
  const start = Math.max(0, INTERVAL_ORDER.indexOf(requested));
  for (let i = start; i < INTERVAL_ORDER.length; i++) {
    const key = INTERVAL_ORDER[i]!;
    if (circuits * (spanSec / intervalSeconds(key)) <= budget) return key;
  }
  return INTERVAL_ORDER[INTERVAL_ORDER.length - 1]!;
}
