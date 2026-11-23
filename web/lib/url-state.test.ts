import { describe, it, expect } from "vitest";
import { buildIntentSearch, parseDrill, parseState } from "./url-state";
import { EVERYTHING, onlyThese } from "./selection";

describe("buildIntentSearch (intent-only URL)", () => {
  it("is empty when there is no preset and everything is on", () => {
    expect(buildIntentSearch(null, EVERYTHING)).toBe("");
  });

  it("carries just the preset", () => {
    expect(buildIntentSearch("7d", EVERYTHING)).toBe("range=7d");
  });

  it("carries what is off, commas intact (not %2C)", () => {
    expect(buildIntentSearch("7d", { categories: ["Car", "Unmonitored"] })).toBe(
      "range=7d&off=Car,Unmonitored",
    );
  });

  it("never emits the legacy show param", () => {
    expect(buildIntentSearch("24h", onlyThese(["HVAC"]))).not.toContain("show=");
  });

  it("omits the drill when nothing is drilled", () => {
    expect(buildIntentSearch("7d", EVERYTHING)).toBe("range=7d");
    expect(buildIntentSearch("7d", EVERYTHING, null)).toBe("range=7d");
  });

  it("carries the drilled category", () => {
    expect(buildIntentSearch("7d", onlyThese(["HVAC"]), "HVAC")).toBe(
      "range=7d&off=Car,Lights,Appliances,Else,Unmonitored&drill=HVAC",
    );
    expect(buildIntentSearch(null, EVERYTHING, "Car")).toBe("drill=Car");
  });
});

describe("parseDrill", () => {
  it("accepts a real category", () => {
    expect(parseDrill("HVAC", EVERYTHING)).toBe("HVAC");
    expect(parseDrill("Else", EVERYTHING)).toBe("Else");
  });

  it("rejects anything that isn't a category", () => {
    expect(parseDrill("Furnace", EVERYTHING)).toBeNull();
    expect(parseDrill("", EVERYTHING)).toBeNull();
    expect(parseDrill(undefined, EVERYTHING)).toBeNull();
  });

  it("drops a drill the selection has turned off", () => {
    expect(parseDrill("HVAC", { categories: ["HVAC"] })).toBeNull();
    expect(parseDrill("HVAC", { categories: ["Car"] })).toBe("HVAC");
  });
});

describe("parseState selection", () => {
  it("off= wins and is canonical", () => {
    expect(parseState({ off: "Unmonitored,Car" }).off.categories).toEqual(["Car", "Unmonitored"]);
  });
  it("legacy show= (email deep links) becomes only-these", () => {
    expect(parseState({ range: "7d", show: "HVAC" }).off).toEqual(onlyThese(["HVAC"]));
    expect(parseState({ show: "HVAC,Lights" }).off).toEqual(onlyThese(["HVAC", "Lights"]));
  });
  it("a legacy show= naming only unknown categories means everything", () => {
    expect(parseState({ show: "Furnace" }).off).toEqual(EVERYTHING);
  });
  it("off beats show when both are present", () => {
    expect(parseState({ show: "HVAC", off: "Car" }).off.categories).toEqual(["Car"]);
  });
  it("no off and no show: everything on", () => {
    expect(parseState({ range: "24h" }).off).toEqual(EVERYTHING);
    expect(parseState({ off: "" }).off).toEqual(EVERYTHING);
  });
  it("a drill focuses the selection on its category", () => {
    expect(parseState({ range: "7d", drill: "Lights" }).off).toEqual(onlyThese(["Lights"]));
    expect(parseState({ show: "HVAC", drill: "HVAC" })).toMatchObject({ drill: "HVAC", off: onlyThese(["HVAC"]) });
  });
  it("drops a drill whose category is off", () => {
    expect(parseState({ off: "HVAC", drill: "HVAC" }).drill).toBeNull();
  });
  it("round-trips through parseState (a reload restores the drill)", () => {
    expect(parseState({ range: "7d", show: "HVAC", drill: "HVAC" }).drill).toBe("HVAC");
    expect(parseState({ range: "7d" }).drill).toBeNull();
  });
});

describe("events intent flag", () => {
  it("is on by default and absent from the URL", () => {
    expect(parseState({}).events).toBe(true);
    expect(buildIntentSearch("24h", EVERYTHING, null, true)).toBe("range=24h");
  });
  it("round-trips events=0", () => {
    expect(parseState({ events: "0" }).events).toBe(false);
    expect(buildIntentSearch("24h", EVERYTHING, null, false)).toBe("range=24h&events=0");
  });
  it("treats any other value as on", () => {
    expect(parseState({ events: "1" }).events).toBe(true);
    expect(parseState({ events: "no" }).events).toBe(true);
  });
});
