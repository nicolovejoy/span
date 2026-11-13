import { describe, expect, it } from "vitest";
import { panelRows } from "./whereItWent";
import { deriveLayers } from "./trendLayers";
import type { TrendBar } from "./trendsPayload";

const DAY = 86400_000;
function bar(key: string, cats: Record<string, number>, pre = 0): TrendBar {
  return {
    key,
    fromMs: 0,
    toMs: 30 * DAY,
    complete: true,
    partialStart: false,
    layers: deriveLayers({
      categories: cats,
      preSplitHvacKwh: pre,
      modes: { heat: 50, cool: 0, hotWater: 20, idle: 5, ambiguous: 0 },
      bathKwh: 4,
      controlsKwh: 0,
    }),
  };
}

describe("panelRows", () => {
  const ps = [bar("a", { HVAC: 100, Car: 30, Lights: 10, Else: 6, Unmonitored: 4 }, 12), bar("b", { HVAC: 80, Car: 90 })];

  it("sums the given periods, ranks by kWh, drops zero rows", () => {
    const r = panelRows(ps, "kwh");
    expect(r.rows.map((x) => x.key)).toEqual([
      "car", "heat", "hotWater", "unclassified", "hvacUnsplit", "standby", "lights", "other", "unmonitored",
    ]);
    expect(r.rows.find((x) => x.key === "car")!.value).toBe(120);
    expect(r.rows.find((x) => x.key === "unclassified")!.value).toBe(25 + 5);
    expect(r.totalValue).toBe(r.rows.reduce((s, x) => s + x.value, 0));
    expect(r.bathKwh).toBe(8);
  });

  it("adds a base charge row in $ mode, included in the total", () => {
    const r = panelRows(ps, "usd");
    const base = r.rows.find((x) => x.key === "baseCharge")!;
    expect(base.value).toBeCloseTo(0.83 * 60, 6);
    expect(r.totalValue).toBeCloseTo(r.rows.reduce((s, x) => s + x.value, 0), 9);
  });
});
