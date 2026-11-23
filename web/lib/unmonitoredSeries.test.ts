import { describe, it, expect } from "vitest";
import { unmonitoredSeries } from "./unmonitoredSeries";

const T1 = "2026-11-20T10:00:00Z";
const T2 = "2026-11-20T10:05:00Z";
const T3 = "2026-11-20T10:10:00Z";
const cat = (time: string, series: string, watts: number) => ({ time, series, watts });

describe("unmonitoredSeries", () => {
  it("is grid minus the sum of the categories, per bucket", () => {
    const cats = [cat(T1, "HVAC", 400), cat(T1, "Else", 300), cat(T2, "HVAC", 500)];
    const grid = [{ time: T1, watts: 960 }, { time: T2, watts: 750 }];
    expect(unmonitoredSeries(cats, grid)).toEqual([
      { time: T1, series: "Unmonitored", watts: 260 },
      { time: T2, series: "Unmonitored", watts: 250 },
    ]);
  });
  it("clamps a negative residual to 0 but keeps the point", () => {
    const out = unmonitoredSeries([cat(T1, "HVAC", 1000)], [{ time: T1, watts: 980 }]);
    expect(out).toEqual([{ time: T1, series: "Unmonitored", watts: 0 }]);
  });
  it("skips a bucket with grid data but no category point (no whole-house spike)", () => {
    const out = unmonitoredSeries([cat(T1, "HVAC", 100)], [{ time: T1, watts: 300 }, { time: T2, watts: 900 }]);
    expect(out.map((p) => p.time)).toEqual([T1]);
  });
  it("emits nothing for a bucket without grid data, or with no grid at all", () => {
    expect(unmonitoredSeries([cat(T1, "HVAC", 100), cat(T2, "HVAC", 100)], [{ time: T1, watts: 300 }]))
      .toHaveLength(1);
    expect(unmonitoredSeries([cat(T1, "HVAC", 100)], [])).toEqual([]);
  });
  it("matches buckets by instant, not by string", () => {
    const out = unmonitoredSeries([cat("2026-11-20T10:00:00.000Z", "HVAC", 100)], [{ time: T1, watts: 350 }]);
    expect(out).toEqual([{ time: T1, series: "Unmonitored", watts: 250 }]);
  });
  it("ignores a non-finite grid value", () => {
    expect(unmonitoredSeries([cat(T1, "HVAC", 100)], [{ time: T1, watts: Number.NaN }])).toEqual([]);
  });
  it("stack top = max(grid, Σ categories) at every bucket, so it equals the Total line", () => {
    const cats = [cat(T1, "HVAC", 400), cat(T2, "HVAC", 900), cat(T3, "Car", 7000)];
    const grid = [{ time: T1, watts: 700 }, { time: T2, watts: 850 }, { time: T3, watts: 7300 }];
    const all = [...cats, ...unmonitoredSeries(cats, grid)];
    const top = (t: string) => all.filter((p) => p.time === t).reduce((s, p) => s + p.watts, 0);
    expect([top(T1), top(T2), top(T3)]).toEqual([700, 900, 7300]);
  });
  it("band area exceeds the once-floored period residual by exactly the clamped buckets", () => {
    // Period kWh method (energyWindow.unmonitoredKwh): floor once on the sum.
    const cats = [cat(T1, "HVAC", 400), cat(T2, "HVAC", 900)];
    const grid = [{ time: T1, watts: 700 }, { time: T2, watts: 850 }];
    const bandW = unmonitoredSeries(cats, grid).reduce((s, p) => s + p.watts, 0);
    const periodW = Math.max(0, 700 + 850 - (400 + 900));
    expect(bandW - periodW).toBe(50); // the T2 bucket's −50 W, clamped away
  });
});
