import { describe, it, expect } from "vitest";
import { stackLayers } from "./stack";

const order = ["HVAC", "Car", "Lights"];
const byCat = new Map([
  ["HVAC", new Map([[1, 2], [2, 3]])],
  ["Car", new Map([[1, 7]])],          // missing at t=2 → 0
  ["Lights", new Map([[1, 0.5], [2, -0.2]])], // negative → 0
]);

describe("stackLayers", () => {
  it("cumulates bottom-up over the on categories", () => {
    const s = stackLayers(order, ["HVAC", "Car", "Lights"], byCat, [1, 2]);
    expect(s.get("HVAC")).toEqual([{ time: 1, value: 2 }, { time: 2, value: 3 }]);
    expect(s.get("Car")).toEqual([{ time: 1, value: 9 }, { time: 2, value: 3 }]);
    expect(s.get("Lights")).toEqual([{ time: 1, value: 9.5 }, { time: 2, value: 3 }]);
  });
  it("skips off categories entirely, so the layer above drops down", () => {
    const s = stackLayers(order, ["HVAC", "Lights"], byCat, [1]);
    expect([...s.keys()]).toEqual(["HVAC", "Lights"]);
    expect(s.get("Lights")).toEqual([{ time: 1, value: 2.5 }]);
  });
  it("keeps stack order even if `on` is in another order", () => {
    expect([...stackLayers(order, ["Lights", "HVAC"], byCat, [1]).keys()]).toEqual(["HVAC", "Lights"]);
  });
  it("nothing on: empty map", () => {
    expect(stackLayers(order, [], byCat, [1, 2]).size).toBe(0);
  });
  it("an on category with no data still gets a (flat) layer", () => {
    const s = stackLayers(["HVAC", "Else"], ["HVAC", "Else"], byCat, [1]);
    expect(s.get("Else")).toEqual([{ time: 1, value: 2 }]);
  });
});

import { subtractOffCircuits } from "./stack";

const m = (pairs: [number, number][]) => new Map(pairs);
const catOf = (n: string) => (n.startsWith("hp") ? "HVAC" : "Lights");

describe("subtractOffCircuits", () => {
  const byCat = new Map([["HVAC", m([[1, 3], [2, 5]])], ["Lights", m([[1, 1], [2, 1]])]]);
  const circuits = new Map([["hp-ctrl", m([[1, 0.5], [2, 6], [3, 9]])], ["hp-main", m([[1, 2.5], [2, -1]])]]);

  it("removes off circuits from their category, clamped at zero", () => {
    const out = subtractOffCircuits(byCat, circuits, ["hp-ctrl"], catOf);
    expect([...out.get("HVAC")!]).toEqual([[1, 2.5], [2, 0]]);
  });
  it("leaves other categories as the same map", () => {
    const out = subtractOffCircuits(byCat, circuits, ["hp-ctrl"], catOf);
    expect(out.get("Lights")).toBe(byCat.get("Lights"));
  });
  it("skips off circuits with no data yet", () => {
    const out = subtractOffCircuits(byCat, circuits, ["hp-unloaded"], catOf);
    expect(out.get("HVAC")).toBe(byCat.get("HVAC"));
  });
});
