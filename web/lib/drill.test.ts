import { describe, it, expect } from "vitest";
import {
  ASSUMED_CIRCUITS_PER_CATEGORY,
  DRILL_POINT_BUDGET_FACTOR,
  CATEGORY_COLORS,
  categoryColor,
  circuitShades,
  drillInterval,
} from "./drill";
import { INTERVAL_ORDER, MAX_BUCKETS, intervalSeconds } from "./interval";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("circuitShades", () => {
  it("returns one color per circuit", () => {
    expect(circuitShades("#ef4444", 4)).toHaveLength(4);
    expect(circuitShades("#ef4444", 0)).toEqual([]);
  });

  it("emits valid 6-digit hex", () => {
    for (const c of circuitShades("#3b82f6", 5)) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("makes every shade distinct", () => {
    const shades = circuitShades("#eab308", 8);
    expect(new Set(shades).size).toBe(8);
  });

  it("goes dark → light, so order is meaningful", () => {
    const lum = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) +
      parseInt(hex.slice(3, 5), 16) +
      parseInt(hex.slice(5, 7), 16);
    const shades = circuitShades("#ef4444", 6);
    for (let i = 1; i < shades.length; i++) {
      expect(lum(shades[i]!)).toBeGreaterThan(lum(shades[i - 1]!));
    }
  });

  it("keeps the parent hue (red stays reddest, blue bluest)", () => {
    const chan = (hex: string, i: number) =>
      parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    for (const c of circuitShades("#ef4444", 5)) {
      expect(chan(c, 0)).toBeGreaterThan(chan(c, 2));
    }
    for (const c of circuitShades("#3b82f6", 5)) {
      expect(chan(c, 2)).toBeGreaterThan(chan(c, 0));
    }
  });

  it("is deterministic — same input, same shades", () => {
    expect(circuitShades("#6b7280", 7)).toEqual(circuitShades("#6b7280", 7));
  });

  it("falls back to grey for an unknown category color", () => {
    expect(circuitShades(categoryColor("Nope"), 3)).toHaveLength(3);
  });

  it("handles a single circuit without dividing by zero", () => {
    const [only] = circuitShades("#ef4444", 1);
    expect(only).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("drillInterval", () => {
  const budget = DRILL_POINT_BUDGET_FACTOR * MAX_BUCKETS;
  const points = (interval: (typeof INTERVAL_ORDER)[number], spanMs: number) =>
    ASSUMED_CIRCUITS_PER_CATEGORY * (spanMs / 1000 / intervalSeconds(interval));

  it("leaves a small window's bucket alone", () => {
    // 24h at 15m = 96 buckets × 12 circuits = 1152, well inside the budget.
    expect(drillInterval("15m", 0, DAY)).toBe("15m");
  });

  it("coarsens when circuits × buckets would blow the budget", () => {
    // 30d at 1m would be 43,200 buckets per circuit.
    const out = drillInterval("1m", 0, 30 * DAY);
    expect(points(out, 30 * DAY)).toBeLessThanOrEqual(budget);
    expect(INTERVAL_ORDER.indexOf(out)).toBeGreaterThan(
      INTERVAL_ORDER.indexOf("1m"),
    );
  });

  it("never returns a finer bucket than requested", () => {
    for (const key of INTERVAL_ORDER) {
      expect(INTERVAL_ORDER.indexOf(drillInterval(key, 0, HOUR))).toBeGreaterThanOrEqual(
        INTERVAL_ORDER.indexOf(key),
      );
    }
  });

  it("respects an explicit circuit count — fewer circuits, no coarsening", () => {
    const span = 7 * DAY;
    expect(drillInterval("5m", 0, span, 1)).toBe("5m");
    expect(INTERVAL_ORDER.indexOf(drillInterval("5m", 0, span, 20))).toBeGreaterThan(
      INTERVAL_ORDER.indexOf("5m"),
    );
  });

  it("bottoms out at the coarsest bucket rather than failing", () => {
    expect(drillInterval("1m", 0, 100 * 365 * DAY, 100)).toBe(
      INTERVAL_ORDER[INTERVAL_ORDER.length - 1],
    );
  });

  it("treats a zero/negative circuit count as one circuit", () => {
    expect(drillInterval("1h", 0, DAY, 0)).toBe("1h");
  });
});

describe("explorer palette", () => {
  it("Appliances is violet, matching /trends", () => {
    expect(categoryColor("Appliances")).toBe("#8b5cf6");
  });

  it("no category color is reused by a mode lane or event marker", async () => {
    const { MODE_COLOR, EVENT_COLOR } = await import("./eventLanes");
    const lanes = new Set(
      [...Object.values(MODE_COLOR), ...Object.values(EVENT_COLOR)].map((c) =>
        c.toLowerCase(),
      ),
    );
    // Car blue is shared with charge events on purpose (same thing, the car).
    for (const [cat, hex] of Object.entries(CATEGORY_COLORS)) {
      if (cat === "Car") continue;
      expect(lanes.has(hex.toLowerCase()), cat).toBe(false);
    }
  });
});
