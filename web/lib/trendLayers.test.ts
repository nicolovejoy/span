import { describe, expect, it } from "vitest";
import { LAYER_ORDER, deriveLayers, type PeriodEnergy } from "./trendLayers";

const zeroModes = { heat: 0, cool: 0, hotWater: 0, idle: 0, ambiguous: 0 };

function energy(p: Partial<PeriodEnergy> & { categories?: Record<string, number> }): PeriodEnergy {
  return {
    categories: { HVAC: 0, Car: 0, Lights: 0, Appliances: 0, Else: 0, Unmonitored: 0, ...p.categories },
    preSplitHvacKwh: p.preSplitHvacKwh ?? 0,
    modes: { ...zeroModes, ...p.modes },
    bathKwh: p.bathKwh ?? 0,
  };
}

const sumLayers = (l: ReturnType<typeof deriveLayers>) =>
  LAYER_ORDER.reduce((s, k) => s + l[k], 0);

describe("deriveLayers", () => {
  it("splits a typical month and sums to the house total", () => {
    const l = deriveLayers(
      energy({
        categories: { HVAC: 300, Car: 180, Lights: 40, Appliances: 60, Else: 70, Unmonitored: 50 },
        modes: { heat: 150, cool: 0, hotWater: 100, idle: 20, ambiguous: 25 },
      }),
    );
    expect(l.detail.unclassified).toBe(30);
    expect(l.hvacOther).toBe(50);
    expect(l.residualKwh).toBe(5);
    expect(l.rest).toBe(120);
    expect(l.detail.other).toBe(70);
    expect(l.detail.unmonitored).toBe(50);
    expect(l.totalKwh).toBe(300 + 180 + 40 + 60 + 70 + 50);
    expect(sumLayers(l)).toBe(l.totalKwh);
  });

  it("clamps unclassified at 0 when modes exceed the circuit", () => {
    const l = deriveLayers(
      energy({ categories: { HVAC: 100 }, modes: { heat: 90, hotWater: 20, idle: 5 } }),
    );
    expect(l.detail.unclassified).toBe(0);
    expect(l.residualKwh).toBe(-15);
    expect(l.heat).toBe(90);
    expect(l.hotWater).toBe(20);
  });

  it("draws a pre-split month as HVAC (not split)", () => {
    const l = deriveLayers(energy({ preSplitHvacKwh: 400 }));
    expect(l.hvacUnsplit).toBe(400);
    for (const k of ["heat", "cool", "hotWater", "hvacOther"] as const) expect(l[k]).toBe(0);
    expect(l.totalKwh).toBe(400);
  });

  it("adds a straddling month's HVAC layers to the circuit total", () => {
    const l = deriveLayers(
      energy({
        preSplitHvacKwh: 40,
        categories: { HVAC: 260 },
        modes: { heat: 200, cool: 0, hotWater: 40, idle: 10, ambiguous: 6 },
      }),
    );
    expect(l.hvacUnsplit).toBe(40);
    expect(l.hvacUnsplit + l.heat + l.cool + l.hotWater + l.hvacOther).toBe(300);
  });

  it("caps baths at hot water", () => {
    expect(deriveLayers(energy({ bathKwh: 12, modes: { hotWater: 8 } })).detail.bath).toBe(8);
  });

  it("orders layers bottom to top", () => {
    expect(LAYER_ORDER).toEqual([
      "hvacUnsplit", "heat", "cool", "hotWater", "hvacOther", "car", "lights", "appliances", "rest",
    ]);
  });
});
