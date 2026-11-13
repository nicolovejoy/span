import { describe, expect, it } from "vitest";
import {
  DATA_START_MS,
  HVAC_SPLIT_START_MS,
  parsePeriodKey,
  periodKey,
  shiftEndKey,
  trendPeriods,
} from "./trends";

const HOUR = 3600_000;
const nowMs = Date.parse("2026-10-26T19:00:00-07:00");

describe("constants", () => {
  it("are Pacific midnights", () => {
    expect(DATA_START_MS).toBe(Date.parse("2026-01-03T00:00:00-08:00"));
    expect(HVAC_SPLIT_START_MS).toBe(Date.parse("2026-01-04T00:00:00-08:00"));
  });
});

describe("trendPeriods — month", () => {
  it("defaults to every month from data start to now, trimmed", () => {
    const ps = trendPeriods({ grain: "month", nowMs });
    expect(ps).toHaveLength(10);
    expect(ps.map((p) => p.key)).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05",
      "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
    ]);
    expect(ps[0].partialStart).toBe(true);
    expect(ps[0].fromMs).toBe(DATA_START_MS);
    const last = ps[ps.length - 1];
    expect(last.complete).toBe(false);
    expect(last.toMs).toBe(nowMs);
    for (const p of ps.slice(0, -1)) expect(p.complete).toBe(true);
    for (const p of ps.slice(1)) expect(p.partialStart).toBe(false);
  });

  it("ends at an explicit endKey", () => {
    const ps = trendPeriods({ grain: "month", endKey: "2026-09", nowMs });
    expect(ps).toHaveLength(9);
    expect(ps[ps.length - 1].key).toBe("2026-09");
    expect(ps[ps.length - 1].complete).toBe(true);
  });

  it("clamps a future endKey to the current period", () => {
    expect(trendPeriods({ grain: "month", endKey: "2027-03", nowMs })).toEqual(
      trendPeriods({ grain: "month", nowMs }),
    );
  });

  it("falls back to default for an unparseable endKey", () => {
    expect(trendPeriods({ grain: "month", endKey: "garbage", nowMs })).toEqual(
      trendPeriods({ grain: "month", nowMs }),
    );
  });

  it("caps at 13 periods once enough history exists", () => {
    const later = Date.parse("2027-06-15T12:00:00-07:00");
    const ps = trendPeriods({ grain: "month", nowMs: later });
    expect(ps).toHaveLength(13);
    expect(ps[0].key).toBe("2026-06");
    expect(ps[12].key).toBe("2027-06");
  });

  it("handles DST month lengths", () => {
    const mar = parsePeriodKey("2026-03", "month")!;
    expect((mar.toMs - mar.fromMs) / HOUR).toBe(743);
    const nov = parsePeriodKey("2026-11", "month")!;
    expect((nov.toMs - nov.fromMs) / HOUR).toBe(721);
  });
});

describe("trendPeriods — week", () => {
  it("has 13 Monday-start weeks ending at the current week", () => {
    const ps = trendPeriods({ grain: "week", nowMs });
    expect(ps).toHaveLength(13);
    expect(ps[12].key).toBe("2026-10-26");
    const dow = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    });
    for (const p of ps) expect(dow.format(p.fromMs)).toBe("Mon, 00");
  });

  it("gives the DST-end week 169 hours", () => {
    const later = Date.parse("2026-11-10T12:00:00-08:00");
    const ps = trendPeriods({ grain: "week", nowMs: later });
    const wk = ps.find((p) => p.key === "2026-10-26")!;
    expect((wk.toMs - wk.fromMs) / HOUR).toBe(169);
    expect(wk.complete).toBe(true);
    expect(ps.map((p) => p.key)).toHaveLength(new Set(ps.map((p) => p.key)).size);
  });
});

describe("trendPeriods — year", () => {
  it("lists every year since data start", () => {
    const ps = trendPeriods({ grain: "year", nowMs });
    expect(ps.map((p) => p.key)).toEqual(["2026"]);
    expect(ps[0].partialStart).toBe(true);
    expect(ps[0].complete).toBe(false);
    const later = Date.parse("2027-02-01T12:00:00-08:00");
    const ys = trendPeriods({ grain: "year", nowMs: later });
    expect(ys.map((p) => p.key)).toEqual(["2026", "2027"]);
    expect(ys[0].complete).toBe(true);
  });
});

describe("periodKey / parsePeriodKey", () => {
  it("round-trips each grain", () => {
    for (const [key, grain] of [
      ["2026-10", "month"],
      ["2026-10-26", "week"],
      ["2026", "year"],
    ] as const) {
      const b = parsePeriodKey(key, grain)!;
      expect(periodKey(b.fromMs, grain)).toBe(key);
    }
  });

  it("rejects invalid keys", () => {
    expect(parsePeriodKey("2026-13", "month")).toBeNull();
    expect(parsePeriodKey("2026-10-27", "week")).toBeNull(); // a Tuesday
    expect(parsePeriodKey("abc", "year")).toBeNull();
    expect(parsePeriodKey("2026-02-30", "week")).toBeNull();
    expect(parsePeriodKey("2026-10", "week")).toBeNull();
  });
});

describe("shiftEndKey", () => {
  it("moves by whole periods, clamped to the current one", () => {
    expect(shiftEndKey("2026-10", "month", -13, nowMs)).toBe("2025-09");
    expect(shiftEndKey("2026-09", "month", 13, nowMs)).toBe("2026-10");
    expect(shiftEndKey("2026-10-26", "week", -13, nowMs)).toBe("2026-07-27");
  });
});
