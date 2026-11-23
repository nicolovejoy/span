import { describe, expect, it } from "vitest";
import { powerCacheControl, wantsGrid } from "./powerCacheControl";

const H = 3_600_000;
const NOW = Date.parse("2026-11-23T18:00:00Z");

describe("powerCacheControl", () => {
  it("lets a historical window cache for a day", () => {
    expect(powerCacheControl({ partial: false, toMs: NOW - 48 * H, intervalMs: H, nowMs: NOW }))
      .toBe("public, max-age=86400, stale-while-revalidate=3600");
  });
  it("caps a trailing window at one bucket (floored at 60 s)", () => {
    expect(powerCacheControl({ partial: false, toMs: NOW, intervalMs: 5 * 60_000, nowMs: NOW }))
      .toBe("public, max-age=300, stale-while-revalidate=3600");
  });
  it("never caches a partial response, even a historical one", () => {
    expect(powerCacheControl({ partial: true, toMs: NOW - 48 * H, intervalMs: H, nowMs: NOW }))
      .toBe("no-store");
  });
});

describe("wantsGrid", () => {
  it("is on unless grid=0", () => {
    expect(wantsGrid(null)).toBe(true);
    expect(wantsGrid("1")).toBe(true);
    expect(wantsGrid("0")).toBe(false);
  });
});
