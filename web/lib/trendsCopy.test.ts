import { describe, expect, it } from "vitest";
import { periodLabel, rangeLabel } from "./trendsCopy";
import { parsePeriodKey, trendPeriods, type TrendPeriod } from "./trends";

const nowMs = Date.parse("2026-10-26T19:00:00-07:00");

function full(key: string, grain: "week" | "month" | "year"): TrendPeriod {
  const b = parsePeriodKey(key, grain)!;
  return { key, ...b, calendarToMs: b.toMs, complete: true, partialStart: false };
}

describe("periodLabel", () => {
  it("labels a complete month", () => {
    expect(periodLabel(full("2026-09", "month"), "month")).toBe("Sep 2026");
  });

  it("labels the month in progress", () => {
    const ps = trendPeriods({ grain: "month", nowMs });
    expect(periodLabel(ps[ps.length - 1], "month")).toBe("Oct 2026 so far");
  });

  it("labels the partial first month by its real span", () => {
    const ps = trendPeriods({ grain: "month", nowMs });
    expect(periodLabel(ps[0], "month")).toBe("Jan 3–31");
  });

  it("labels a week", () => {
    expect(periodLabel(full("2026-10-19", "week"), "week")).toBe("Week of Oct 19");
    const ps = trendPeriods({ grain: "week", nowMs });
    expect(periodLabel(ps[ps.length - 1], "week")).toBe("Week of Oct 26 so far");
  });

  it("labels years", () => {
    expect(periodLabel(full("2027", "year"), "year")).toBe("2027");
    const [y] = trendPeriods({ grain: "year", nowMs });
    expect(periodLabel(y, "year")).toBe("2026 · from Jan 3, so far");
  });
});

describe("rangeLabel", () => {
  it("names a multi-period range by its ends", () => {
    const ps = trendPeriods({ grain: "month", nowMs });
    expect(rangeLabel(ps, "month")).toBe("Jan 2026–Oct 2026");
    expect(rangeLabel(trendPeriods({ grain: "week", nowMs }), "week")).toBe(
      "Week of Aug 3–week of Oct 26",
    );
  });

  it("falls back to the single period's label", () => {
    expect(rangeLabel([full("2026-09", "month")], "month")).toBe("Sep 2026");
  });
});
