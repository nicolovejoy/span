import { describe, it, expect } from "vitest";
import { panelRows, selectionSummary } from "./selectionSummary";
import { EVERYTHING, SELECTABLE, presetOff, toggle } from "./selection";
import type { EnergyRow } from "./queryCache";

const rows: EnergyRow[] = [
  { category: "HVAC", kwh: 119 },
  { category: "Heating", kwh: 80, parent: "HVAC" }, // child rows never count
  { category: "Car", kwh: 54.6 },
  { category: "Lights", kwh: 52.1 },
  { category: "Appliances", kwh: 21.4 },
  { category: "Else", kwh: 3.4 },
  { category: "Unmonitored", kwh: 20 },
];

describe("selectionSummary", () => {
  it("everything on: share is 1 and kWh is the total", () => {
    const s = selectionSummary(rows, EVERYTHING);
    expect(s.kwh).toBeCloseTo(270.5);
    expect(s.totalKwh).toBeCloseTo(270.5);
    expect(s.share).toBeCloseTo(1);
    expect(s.onCount).toBe(6);
    expect(s.count).toBe(6);
  });
  it("house (no car): drops the car from the selection, not from the total", () => {
    const s = selectionSummary(rows, presetOff("house"));
    expect(s.kwh).toBeCloseTo(215.9);
    expect(s.totalKwh).toBeCloseTo(270.5);
    expect(s.share).toBeCloseTo(215.9 / 270.5);
    expect(s.cost).toBeCloseTo(215.9 * 0.1241);
    expect(s.onCount).toBe(5);
  });
  it("ignores negative kWh in both sums", () => {
    const s = selectionSummary([...rows.slice(0, 6), { category: "Unmonitored", kwh: -5 }], EVERYTHING);
    expect(s.totalKwh).toBeCloseTo(250.5);
  });
  it("nothing selected: zero kWh, share 0", () => {
    const none = SELECTABLE.reduce((o, k) => toggle(o, k), EVERYTHING);
    const s = selectionSummary(rows, none);
    expect(s.kwh).toBe(0);
    expect(s.share).toBe(0);
    expect(s.onCount).toBe(0);
  });
  it("no rows yet: share is null, not NaN", () => {
    expect(selectionSummary([], EVERYTHING).share).toBeNull();
  });
});

describe("panelRows", () => {
  it("lists every selectable key in order with its kWh and on flag", () => {
    const p = panelRows(rows, presetOff("house"));
    expect(p.map((r) => r.key)).toEqual(SELECTABLE);
    expect(p.find((r) => r.key === "Car")).toMatchObject({ kwh: 54.6, on: false });
    expect(p.find((r) => r.key === "HVAC")).toMatchObject({ kwh: 119, on: true });
  });
  it("kWh is null for a key with no row (still loading, or no data)", () => {
    expect(panelRows([], EVERYTHING).every((r) => r.kwh === null)).toBe(true);
  });
});
