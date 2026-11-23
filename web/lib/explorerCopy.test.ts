import { describe, it, expect } from "vitest";
import { EXPLORER_COPY, headline, panelSummary, periodText } from "./explorerCopy";

const s = { kwh: 215.94, totalKwh: 270.5, share: 215.94 / 270.5, cost: 26.8, onCount: 5, count: 6 };

describe("explorer copy", () => {
  it("title is Power Explorer", () => {
    expect(EXPLORER_COPY.title).toBe("Power Explorer");
  });
  it("headline: kWh, share of the period total, dollars, period", () => {
    expect(headline(s, "Nov 2026 so far")).toEqual({
      main: "215.9 kWh",
      detail: "80% of 270.5 kWh · $26.80 · Nov 2026 so far",
    });
  });
  it("headline with no share and no period drops those parts", () => {
    expect(headline({ ...s, share: null }, null).detail).toBe("$26.80");
  });
  it("headline when nothing is selected", () => {
    expect(headline({ ...s, kwh: 0, cost: 0, onCount: 0 }, null).main).toBe(EXPLORER_COPY.nothingSelected);
  });
  it("mobile summary names the preset, else counts", () => {
    expect(panelSummary("house", s)).toBe("What to show · House (no car)");
    expect(panelSummary(null, { ...s, onCount: 3 })).toBe("What to show · 3 of 6 on");
  });
  it("partly-off kWh and legend label", () => {
    expect(EXPLORER_COPY.partKwh(100.84, 119)).toBe("100.8 of 119.0");
    expect(EXPLORER_COPY.legendPartial("HVAC")).toBe("HVAC (part)");
  });
  it("periodText reads the snap metadata off the first row", () => {
    const fromMs = Date.parse("2026-11-01T00:00:00-07:00");
    expect(periodText([{ category: "HVAC", kwh: 1, periodFromMs: fromMs, periodGrain: "month", periodComplete: false }]))
      .toBe("Nov 2026 so far");
    expect(periodText([])).toBeNull();
  });
  it("Unmonitored note: the subpanel as one feed, noisy at 1-minute buckets", () => {
    expect(EXPLORER_COPY.unmonitoredNote).toMatch(/subpanel/);
    expect(EXPLORER_COPY.unmonitoredNote).toMatch(/one feed/);
    expect(EXPLORER_COPY.unmonitoredNote).toMatch(/1-minute/);
    expect(EXPLORER_COPY.unmonitoredNote).not.toMatch(/no line/);
  });
});
