import { describe, expect, it } from "vitest";
import { axisY, trendAxis } from "./trendAxis";
import { deriveLayers } from "./trendLayers";
import type { TrendBar } from "./trendsPayload";

const DAY = 86400_000;

function barWith(o: { house: number; car: number; elapsedDays?: number; calendarDays?: number }): TrendBar {
  const calendarDays = o.calendarDays ?? 30;
  const elapsedDays = o.elapsedDays ?? calendarDays;
  return {
    key: "p",
    fromMs: 0,
    toMs: elapsedDays * DAY,
    calendarToMs: calendarDays * DAY,
    complete: elapsedDays >= calendarDays,
    partialStart: false,
    layers: deriveLayers({
      categories: { Lights: o.house, Car: o.car },
      preSplitHvacKwh: 0,
      modes: { heat: 0, cool: 0, hotWater: 0, idle: 0, ambiguous: 0 },
      bathKwh: 0,
      controlsKwh: 0,
    }),
  };
}

describe("trendAxis", () => {
  it("puts the house up and the car down on one step", () => {
    // house 120 + car 88 in one week, house 90 + car 30 in another
    const a = trendAxis([barWith({ house: 120, car: 88 }), barWith({ house: 90, car: 30 })], "kwh");
    expect(a).toEqual({ upMax: 150, downMax: 100, step: 50, ticks: [-100, -50, 0, 50, 100, 150] });
  });

  it("reserves nothing below zero when no bar has car energy", () => {
    const a = trendAxis([barWith({ house: 120, car: 0 })], "kwh");
    expect(a.downMax).toBe(0);
    expect(a.ticks[0]).toBe(0);
  });

  it("fits the projected car of an in-progress period", () => {
    // 10 of 30 days elapsed: factor 3; car 40 actual → 120 projected; house 30 → 90
    const a = trendAxis([barWith({ house: 30, car: 40, elapsedDays: 10, calendarDays: 30 })], "kwh");
    expect(a.downMax).toBeGreaterThanOrEqual(120);
    expect(a.upMax).toBeGreaterThanOrEqual(90);
  });

  it("takes the step from the larger side when the car exceeds the house", () => {
    const a = trendAxis([barWith({ house: 40, car: 400 })], "kwh");
    expect(a.step).toBe(100);
    expect(a.ticks.length).toBeLessThanOrEqual(6);
  });

  it("scales to dollars in usd mode", () => {
    const a = trendAxis([barWith({ house: 1000, car: 0 })], "usd"); // $124.10
    expect(a.upMax).toBe(150);
    expect(a.step).toBe(50);
  });

  it("keeps a 0–1 axis for an all-zero window", () => {
    expect(trendAxis([barWith({ house: 0, car: 0 })], "kwh")).toEqual({
      upMax: 1, downMax: 0, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1],
    });
  });

  it("does not round an exact multiple of the step up a notch", () => {
    // 200 / 4 = 50 → step 50; 200 is exactly 4 steps, 100 exactly 2
    const a = trendAxis([barWith({ house: 200, car: 100 })], "kwh");
    expect(a).toMatchObject({ upMax: 200, downMax: 100, step: 50 });
  });
});

describe("axisY", () => {
  it("maps values to y with zero between the two sides", () => {
    const a = { upMax: 150, downMax: 100, step: 50, ticks: [] };
    expect(axisY(a, 150, 8, 250)).toBe(8);
    expect(axisY(a, -100, 8, 250)).toBe(258);
    expect(axisY(a, 0, 8, 250)).toBe(8 + 150);
  });
});
