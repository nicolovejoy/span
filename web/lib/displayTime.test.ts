import { describe, it, expect } from "vitest";
import { fromDisplay, isChartSeriesSafe, toChartTimes, toDisplay } from "./displayTime";

const sec = (iso: string) => Date.parse(iso) / 1000;
const grid = (fromIso: string, toIso: string, step: number) => {
  const out: { time: number; value: number }[] = [];
  for (let t = sec(fromIso); t <= sec(toIso); t += step) out.push({ time: t, value: 1 });
  return out;
};
const strictlyAscending = (xs: { time: number }[]) =>
  xs.every((x, i) => i === 0 || x.time > xs[i - 1]!.time);

describe("toDisplay / fromDisplay", () => {
  it("reads Pacific wall-clock as fake UTC (PST and PDT)", () => {
    expect(toDisplay(sec("2026-01-15T20:00:00Z"))).toBe(sec("2026-01-15T12:00:00Z"));
    expect(toDisplay(sec("2026-07-15T19:00:00Z"))).toBe(sec("2026-07-15T12:00:00Z"));
  });
  it("round-trips outside the fall-back hour", () => {
    const t = sec("2026-11-10T03:15:00Z");
    expect(fromDisplay(toDisplay(t))).toBe(t);
  });
});

describe("toChartTimes", () => {
  // 2026-11-01 09:00Z is 01:00 PST, an hour the wall clock already showed as
  // 01:00 PDT (08:00Z). Mapped one by one the display times run backwards by
  // an hour there, and lightweight-charts' render loop throws "Value is null".
  it.each([300, 900, 3600])(
    "a %is grid across the fall-back hour comes out strictly ascending",
    (step) => {
      const raw = grid("2026-10-31T20:00:00Z", "2026-11-01T14:00:00Z", step);
      expect(strictlyAscending(raw.map((p) => ({ time: toDisplay(p.time) })))).toBe(false);
      expect(strictlyAscending(toChartTimes(raw))).toBe(true);
    },
  );
  it("keeps the first pass over the repeated hour and every other point", () => {
    const raw = grid("2026-11-01T07:00:00Z", "2026-11-01T11:00:00Z", 3600);
    // 07Z 00:00 PDT, 08Z 01:00 PDT, 09Z 01:00 PST (repeat), 10Z 02:00 PST, 11Z 03:00 PST
    expect(toChartTimes(raw).map((p) => p.time)).toEqual(
      [sec("2026-11-01T07:00:00Z"), sec("2026-11-01T08:00:00Z"), sec("2026-11-01T10:00:00Z"), sec("2026-11-01T11:00:00Z")]
        .map((t) => toDisplay(t)),
    );
  });
  it("carries whitespace entries and leaves ordinary data untouched", () => {
    const raw = [{ time: sec("2026-11-10T00:00:00Z") }, { time: sec("2026-11-10T01:00:00Z"), value: 2 }];
    const out = toChartTimes(raw);
    expect(out).toEqual([
      { time: toDisplay(raw[0]!.time) },
      { time: toDisplay(raw[1]!.time), value: 2 },
    ]);
    expect("value" in out[0]!).toBe(false);
  });
});

describe("isChartSeriesSafe", () => {
  it("accepts ascending data with whitespace", () => {
    expect(isChartSeriesSafe([{ time: 1 }, { time: 2, value: 0 }, { time: 3 }])).toBe(true);
    expect(isChartSeriesSafe([])).toBe(true);
  });
  it("rejects repeated, backwards and non-finite times or values", () => {
    expect(isChartSeriesSafe([{ time: 1, value: 1 }, { time: 1, value: 1 }])).toBe(false);
    expect(isChartSeriesSafe([{ time: 2, value: 1 }, { time: 1, value: 1 }])).toBe(false);
    expect(isChartSeriesSafe([{ time: NaN, value: 1 }])).toBe(false);
    expect(isChartSeriesSafe([{ time: 1, value: NaN }])).toBe(false);
  });
});
