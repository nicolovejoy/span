import type { EventKind, Mode } from "./eventRuns";

/** ms → chart x in px, or null when the chart can't place it (outside the
 *  loaded data). Built from lightweight-charts' timeToCoordinate. */
export type XOf = (ms: number) => number | null;

export type Block<T> = { x: number; w: number; item: T; clipped: boolean };

export const LANE_H = 22;
const LABEL_MIN_PX = 56;

export const MODE_COLOR: Record<Mode, string> = {
  heat: "#f97316",
  cool: "#38bdf8",
  hot_water: "#14b8a6",
  ambiguous: "#9ca3af",
};
export const EVENT_COLOR: Record<EventKind, string> = {
  bath: "#14b8a6",
  charge: "#3b82f6",
};

export function layoutBlocks<T extends { fromMs: number; toMs: number }>(
  items: T[],
  vis: { fromMs: number; toMs: number },
  xOf: XOf,
  minPx = 1,
): Block<T>[] {
  const out: Block<T>[] = [];
  for (const item of items) {
    if (item.toMs <= vis.fromMs || item.fromMs >= vis.toMs) continue;
    const from = Math.max(item.fromMs, vis.fromMs);
    const to = Math.min(item.toMs, vis.toMs);
    const x1 = xOf(from);
    const x2 = xOf(to);
    if (x1 === null || x2 === null) continue;
    out.push({
      x: x1,
      w: Math.max(minPx, x2 - x1),
      item,
      clipped: from !== item.fromMs || to !== item.toMs,
    });
  }
  return out;
}

export const labelFits = (w: number): boolean => w >= LABEL_MIN_PX;

export type Anchor = { ms: number; x: number };

/** Linear time→x map from two resolved chart anchors. The chart's time axis is
 *  index-linear, so between two real grid points this is exact; across an
 *  interior data gap it degrades to a small misplacement rather than a dropped
 *  block. Returns null when the anchors coincide. */
export function affineXOf(a: Anchor, b: Anchor): XOf | null {
  if (a.ms === b.ms) return null;
  const slope = (b.x - a.x) / (b.ms - a.ms);
  return (ms) => a.x + (ms - a.ms) * slope;
}

/**
 * Resolve the two bucket anchors that define the visible window's time→x map.
 *
 * lightweight-charts' `timeToCoordinate` only resolves times that are actual
 * points on the series — it returns null anywhere between two buckets, and the
 * chart does *not* carry a point at every bucket (the power query uses
 * `createEmpty: false`, so interior buckets can be missing; only the loaded
 * window's outer edges carry whitespace sentinels). So we start at the buckets
 * containing `fromMs`/`toMs` and step inward until both sides resolve.
 *
 * @param timeToX ms → px, or null when the chart can't place that instant.
 * @returns [left, right] anchors, or null if either side never resolves or the
 *          two land on the same bucket.
 */
export function resolveAnchors(
  fromMs: number,
  toMs: number,
  bucketMs: number,
  timeToX: (ms: number) => number | null,
  maxSteps = 8,
): [Anchor, Anchor] | null {
  const tA0 = Math.floor(fromMs / bucketMs) * bucketMs;
  const tB0 = Math.floor(toMs / bucketMs) * bucketMs;

  let left: Anchor | null = null;
  for (let i = 0; i <= maxSteps; i++) {
    const ms = tA0 + i * bucketMs;
    const x = timeToX(ms);
    if (x !== null) {
      left = { ms, x };
      break;
    }
  }
  if (left === null) return null;

  let right: Anchor | null = null;
  for (let i = 0; i <= maxSteps; i++) {
    const ms = tB0 - i * bucketMs;
    const x = timeToX(ms);
    if (x !== null) {
      right = { ms, x };
      break;
    }
  }
  if (right === null) return null;
  if (left.ms === right.ms) return null;
  return [left, right];
}
