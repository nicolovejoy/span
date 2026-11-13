import { describe, expect, it } from "vitest";
import { LAYER_ORDER, combinePeriodEnergy, deriveLayers, type PeriodEnergy } from "./trendLayers";

const zeroModes = { heat: 0, cool: 0, hotWater: 0, idle: 0, ambiguous: 0 };

function energy(p: Partial<Omit<PeriodEnergy, "modes">> & { modes?: Partial<PeriodEnergy["modes"]> }): PeriodEnergy {
  return {
    categories: { HVAC: 0, Car: 0, Lights: 0, Appliances: 0, Else: 0, Unmonitored: 0, ...p.categories },
    preSplitHvacKwh: p.preSplitHvacKwh ?? 0,
    modes: { ...zeroModes, ...p.modes },
    bathKwh: p.bathKwh ?? 0,
    controlsKwh: p.controlsKwh ?? 0,
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

  it("carves the unclassified circuits out as controls, leaving ambiguous as unclassified", () => {
    const l = deriveLayers(
      energy({
        categories: { HVAC: 300 },
        controlsKwh: 60,
        modes: { heat: 100, cool: 0, hotWater: 100, idle: 10, ambiguous: 30 },
      }),
    );
    expect(l.detail.controls).toBe(60);
    expect(l.detail.unclassified).toBe(30);
    expect(l.residualKwh).toBe(0);
    expect(l.hvacOther).toBe(100);
    expect(l.heat + l.cool + l.hotWater + l.hvacOther).toBe(300);
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

describe("combinePeriodEnergy", () => {
  const modeSums = {
    energy_heat_kwh: 10,
    energy_cool_kwh: 1,
    energy_hot_water_kwh: 5,
    energy_idle_kwh: 2,
    energy_ambiguous_kwh: 0.5,
  };

  it("puts the pre-split side's HVAC in preSplitHvacKwh and adds the rest", () => {
    const e = combinePeriodEnergy({
      pre: [
        { category: "HVAC", kwh: 40 },
        { category: "Car", kwh: 3 },
        { category: "Unmonitored", kwh: 2 },
      ],
      post: [
        { category: "HVAC", kwh: 260 },
        { category: "Car", kwh: 7 },
        { category: "Heating", kwh: 99, parent: "HVAC" },
      ],
      modeSums,
      bathKwh: 4,
      hvacCircuits: [
        { category: "Heat pump (HP)", kwh: 230, parent: "HVAC" },
        { category: "Auxiliary / Heat pump (HP)", kwh: 10, parent: "HVAC" },
        { category: "Heat pump (HP) / Control", kwh: 20, parent: "HVAC" },
      ],
    });
    expect(e.controlsKwh).toBe(20);
    expect(e.preSplitHvacKwh).toBe(40);
    expect(e.categories).toEqual({ HVAC: 260, Car: 10, Unmonitored: 2 });
    expect(e.modes).toEqual({ heat: 10, cool: 1, hotWater: 5, idle: 2, ambiguous: 0.5 });
    expect(e.bathKwh).toBe(4);
  });

  it("handles a wholly pre-split period", () => {
    const e = combinePeriodEnergy({
      pre: [{ category: "HVAC", kwh: 400 }, { category: "Lights", kwh: 9 }],
      post: null,
      modeSums: {},
      bathKwh: 0,
    });
    expect(e.preSplitHvacKwh).toBe(400);
    expect(e.categories).toEqual({ Lights: 9 });
    expect(e.modes).toEqual({ heat: 0, cool: 0, hotWater: 0, idle: 0, ambiguous: 0 });
  });
});
