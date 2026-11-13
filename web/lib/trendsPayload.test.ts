import { describe, expect, it, vi } from "vitest";
import { trendsPayload } from "./trendsPayload";
import type { PeriodEnergy } from "./trendLayers";

const nowMs = Date.parse("2026-10-26T19:00:00-07:00");
const flat: PeriodEnergy = {
  categories: { HVAC: 100, Car: 10 },
  preSplitHvacKwh: 0,
  modes: { heat: 50, cool: 0, hotWater: 20, idle: 5, ambiguous: 5 },
  bathKwh: 1,
};

describe("trendsPayload", () => {
  it("returns one period with layers per bar", async () => {
    const fetch = vi.fn(async () => flat);
    const ps = await trendsPayload({ grain: "month", endKey: null }, nowMs, fetch);
    expect(ps).toHaveLength(10);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(ps[0].key).toBe("2026-01");
    expect(ps[3].layers.totalKwh).toBe(110);
    expect(ps[3].layers.detail.unclassified).toBe(25);
  });

  it("falls back to the default window for an invalid end", async () => {
    const ps = await trendsPayload({ grain: "month", endKey: "nope" }, nowMs, async () => flat);
    expect(ps[ps.length - 1].key).toBe("2026-10");
  });

  it("warns when the HVAC residual exceeds 5%", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const off = { ...flat, modes: { ...flat.modes, ambiguous: 0 } }; // residual 25 of 100
    await trendsPayload({ grain: "year", endKey: null }, nowMs, async () => off);
    expect(warn).toHaveBeenCalled();
    warn.mockClear();
    await trendsPayload({ grain: "year", endKey: null }, nowMs, async () => ({
      ...flat,
      modes: { heat: 50, cool: 0, hotWater: 20, idle: 5, ambiguous: 23 },
    }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
