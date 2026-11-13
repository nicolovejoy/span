import { describe, expect, it } from "vitest";
import { buildTrendsSearch, parseTrendsState } from "./trendsUrl";

const nowMs = Date.parse("2026-10-26T19:00:00-07:00");
const later = Date.parse("2027-06-15T12:00:00-07:00");

describe("parseTrendsState", () => {
  it("defaults", () => {
    expect(parseTrendsState({}, nowMs)).toEqual({ grain: "month", endKey: null, selKey: null });
  });

  it("rejects a bogus grain and a non-Monday week end", () => {
    expect(parseTrendsState({ grain: "bogus" }, nowMs).grain).toBe("month");
    expect(parseTrendsState({ grain: "week", end: "2026-10-27" }, nowMs)).toEqual({
      grain: "week",
      endKey: null,
      selKey: null,
    });
  });

  it("keeps a sel inside the default window without setting end", () => {
    expect(parseTrendsState({ sel: "2026-09" }, nowMs)).toEqual({
      grain: "month",
      endKey: null,
      selKey: "2026-09",
    });
  });

  it("moves end to an old sel so the link keeps working", () => {
    expect(parseTrendsState({ sel: "2026-02" }, later)).toEqual({
      grain: "month",
      endKey: "2026-02",
      selKey: "2026-02",
    });
  });

  it("drops a sel for the wrong grain", () => {
    expect(parseTrendsState({ sel: "2026-10-26" }, nowMs).selKey).toBeNull();
  });

  it("drops a sel outside the window ending at end", () => {
    expect(parseTrendsState({ end: "2026-09", sel: "2026-11" }, nowMs)).toEqual({
      grain: "month",
      endKey: "2026-09",
      selKey: null,
    });
  });

  it("normalizes a current or future end to null", () => {
    expect(parseTrendsState({ end: "2026-10" }, nowMs).endKey).toBeNull();
    expect(parseTrendsState({ end: "2027-03" }, nowMs).endKey).toBeNull();
  });

  it("drops a sel before data start", () => {
    expect(parseTrendsState({ sel: "2025-06" }, nowMs)).toEqual({
      grain: "month",
      endKey: null,
      selKey: null,
    });
  });

  it("takes the first value of a repeated param", () => {
    expect(parseTrendsState({ grain: ["week", "year"] }, nowMs).grain).toBe("week");
  });
});

describe("buildTrendsSearch", () => {
  it("round-trips", () => {
    const qs = "grain=week&end=2026-10-19&sel=2026-10-12";
    const params = Object.fromEntries(new URLSearchParams(qs));
    expect(buildTrendsSearch(parseTrendsState(params, nowMs))).toBe(qs);
  });

  it("builds empty for the default state", () => {
    expect(buildTrendsSearch({ grain: "month", endKey: null, selKey: null })).toBe("");
  });
});

describe("end before data start (review fix)", () => {
  it("normalizes to the first data period", () => {
    expect(parseTrendsState({ end: "2025-06" }, later).endKey).toBe("2026-01");
    expect(parseTrendsState({ grain: "week", end: "2025-06-02" }, nowMs).endKey).toBe("2025-12-29");
  });
});
