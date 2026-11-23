// The explorer's band palette and stack order. Which circuits belong to a
// category is decided by the shared regex rules in ./categories; this module
// only holds how a band looks and where it sits in the stack. Unmonitored is a
// band but not a category: it has no circuits (see lib/unmonitoredSeries).

export const UNMONITORED = "Unmonitored";

export const CATEGORY_COLORS: Record<string, string> = {
  HVAC: "#ef4444",
  Car: "#3b82f6",
  Lights: "#eab308",
  Appliances: "#8b5cf6",
  Else: "#6b7280",
  [UNMONITORED]: "#94a3b8",
};

/** The five circuit categories, bottom of the stack first. Circuit code paths
 *  (drill, partial, expand) iterate this, never BAND_ORDER. */
export const CATEGORY_ORDER = [
  "HVAC",
  "Car",
  "Lights",
  "Appliances",
  "Else",
] as const;

/** Every chart band, bottom first: the categories, then Unmonitored on top. */
export const BAND_ORDER = [...CATEGORY_ORDER, UNMONITORED] as const;

export const categoryColor = (cat: string): string =>
  CATEGORY_COLORS[cat] ?? "#888";
