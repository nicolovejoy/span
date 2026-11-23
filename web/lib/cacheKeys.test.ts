// The drill has to reach every cache key: a drilled response is a different row
// shape for the same window, so sharing an entry would serve circuit rows to
// the category view (or the reverse).

import { describe, it, expect } from "vitest";
import { seriesCacheKey, energyCacheKey } from "./clientFetch";
import { makeKey, makeEnergyKey } from "./queryCache";

const FROM = 1_700_000_000_000;
const TO = FROM + 24 * 60 * 60 * 1000;

describe("client cache keys", () => {
  it("separates a drilled window from the same un-drilled window", () => {
    expect(seriesCacheKey(FROM, TO, "1h")).not.toBe(
      seriesCacheKey(FROM, TO, "1h", "HVAC"),
    );
    expect(energyCacheKey(FROM, TO)).not.toBe(energyCacheKey(FROM, TO, "HVAC"));
  });

  it("separates two different drills", () => {
    expect(seriesCacheKey(FROM, TO, "1h", "HVAC")).not.toBe(
      seriesCacheKey(FROM, TO, "1h", "Car"),
    );
    expect(energyCacheKey(FROM, TO, "HVAC")).not.toBe(
      energyCacheKey(FROM, TO, "Car"),
    );
  });

  it("separates a grid-less (no Unmonitored) request from the default, client and server", () => {
    expect(seriesCacheKey(FROM, TO, "1h", undefined, false)).not.toBe(seriesCacheKey(FROM, TO, "1h"));
    expect(makeKey("1h", FROM, TO, undefined, false)).not.toBe(makeKey("1h", FROM, TO));
  });

  it("is stable for the same request", () => {
    expect(seriesCacheKey(FROM, TO, "1h", "Else")).toBe(
      seriesCacheKey(FROM, TO, "1h", "Else"),
    );
    expect(energyCacheKey(FROM, TO)).toBe(energyCacheKey(FROM, TO, undefined));
  });

  it("still separates windows and buckets within one drill", () => {
    expect(seriesCacheKey(FROM, TO, "1h", "HVAC")).not.toBe(
      seriesCacheKey(FROM, TO, "5m", "HVAC"),
    );
    expect(energyCacheKey(FROM, TO, "HVAC")).not.toBe(
      energyCacheKey(FROM, TO + 1, "HVAC"),
    );
  });
});

describe("server cache keys", () => {
  it("separates a drilled window from the same un-drilled window", () => {
    expect(makeKey("1h", FROM, TO)).not.toBe(makeKey("1h", FROM, TO, "HVAC"));
    expect(makeEnergyKey(FROM, TO)).not.toBe(makeEnergyKey(FROM, TO, "HVAC"));
  });

  it("separates two different drills", () => {
    expect(makeKey("1h", FROM, TO, "HVAC")).not.toBe(
      makeKey("1h", FROM, TO, "Car"),
    );
    expect(makeEnergyKey(FROM, TO, "HVAC")).not.toBe(
      makeEnergyKey(FROM, TO, "Car"),
    );
  });

  it("keeps the measurement in the key alongside the drill", () => {
    expect(makeKey("1m", FROM, TO, "HVAC")).toContain("circuit");
    expect(makeEnergyKey(FROM, TO, "HVAC")).toContain("circuit");
  });
});
