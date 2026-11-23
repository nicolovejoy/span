import { describe, it, expect } from "vitest";
import { BAND_ORDER, CATEGORY_COLORS, CATEGORY_ORDER, categoryColor } from "./drill";

describe("explorer palette", () => {
  it("Appliances is violet, matching /trends", () => {
    expect(categoryColor("Appliances")).toBe("#8b5cf6");
  });

  it("no category color is reused by a mode lane or event marker", async () => {
    const { MODE_COLOR, EVENT_COLOR } = await import("./eventLanes");
    const lanes = new Set(
      [...Object.values(MODE_COLOR), ...Object.values(EVENT_COLOR)].map((c) =>
        c.toLowerCase(),
      ),
    );
    // Car blue is shared with charge events on purpose (same thing, the car).
    for (const [cat, hex] of Object.entries(CATEGORY_COLORS)) {
      if (cat === "Car") continue;
      expect(lanes.has(hex.toLowerCase()), cat).toBe(false);
    }
  });
});

describe("chart bands", () => {
  it("stack the five categories, then Unmonitored on top", () => {
    expect(BAND_ORDER).toEqual([...CATEGORY_ORDER, "Unmonitored"]);
  });
  it("Unmonitored keeps its slate swatch, distinct from Else grey", () => {
    expect(categoryColor("Unmonitored")).toBe("#94a3b8");
    expect(categoryColor("Unmonitored")).not.toBe(categoryColor("Else"));
  });
});
