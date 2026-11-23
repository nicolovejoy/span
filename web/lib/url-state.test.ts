import { describe, it, expect } from "vitest";
import { buildIntentSearch, parseDrill, parseState } from "./url-state";
import { EVERYTHING, onlyThese, withCircuits } from "./selection";

describe("buildIntentSearch (intent-only URL)", () => {
  it("is empty when there is no preset and everything is on", () => {
    expect(buildIntentSearch(null, EVERYTHING)).toBe("");
  });

  it("carries just the preset", () => {
    expect(buildIntentSearch("7d", EVERYTHING)).toBe("range=7d");
  });

  it("carries what is off, commas intact (not %2C)", () => {
    expect(buildIntentSearch("7d", { categories: ["Car", "Unmonitored"], circuits: [] })).toBe(
      "range=7d&off=Car,Unmonitored",
    );
  });

  it("never emits the legacy show param", () => {
    expect(buildIntentSearch("24h", onlyThese(["HVAC"]))).not.toContain("show=");
  });

  const CTRL = "Heat pump (HP) / Control";
  const LIV = "Lights / Living room, Upstairs";

  it("writes each off circuit as its own encoded offc, after off and before events", () => {
    expect(buildIntentSearch("7d", { categories: ["Car"], circuits: [CTRL, LIV] }, false)).toBe(
      "range=7d&off=Car&offc=Heat%20pump%20(HP)%20%2F%20Control&offc=Lights%20%2F%20Living%20room%2C%20Upstairs&events=0",
    );
  });
  it("never writes drill", () => {
    expect(buildIntentSearch("7d", onlyThese(["HVAC"]))).not.toContain("drill=");
  });
  it("round-trips circuit names with & # + , / through URLSearchParams", () => {
    const off = withCircuits(EVERYTHING, ["A & B #1 + C", CTRL, LIV]);
    const p = new URLSearchParams(buildIntentSearch(null, off));
    expect(parseState({ offc: p.getAll("offc") }).off).toEqual(off);
  });
  it("reads a single offc as a string and drops circuits of off categories", () => {
    expect(parseState({ offc: CTRL }).off.circuits).toEqual([CTRL]);
    expect(parseState({ off: "HVAC", offc: [CTRL, LIV] }).off).toEqual({
      categories: ["HVAC"],
      circuits: [LIV],
    });
  });
  it("legacy drill expands its category and narrows to it; expanded is empty otherwise", () => {
    const s = parseState({ show: "HVAC", drill: "HVAC" });
    expect(s.expanded).toEqual(["HVAC"]);
    expect(s.off).toEqual(onlyThese(["HVAC"]));
    expect(parseState({ range: "7d" }).expanded).toEqual([]);
    expect(parseState({ off: "HVAC", drill: "HVAC" }).expanded).toEqual([]);
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
    expect(parseDrill("HVAC", { categories: ["HVAC"], circuits: [] })).toBeNull();
    expect(parseDrill("HVAC", { categories: ["Car"], circuits: [] })).toBe("HVAC");
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
  it("a legacy drill link narrows the selection to its category", () => {
    expect(parseState({ range: "7d", drill: "Lights" }).off).toEqual(onlyThese(["Lights"]));
  });
});

describe("events intent flag", () => {
  it("is on by default and absent from the URL", () => {
    expect(parseState({}).events).toBe(true);
    expect(buildIntentSearch("24h", EVERYTHING, true)).toBe("range=24h");
  });
  it("round-trips events=0", () => {
    expect(parseState({ events: "0" }).events).toBe(false);
    expect(buildIntentSearch("24h", EVERYTHING, false)).toBe("range=24h&events=0");
  });
  it("treats any other value as on", () => {
    expect(parseState({ events: "1" }).events).toBe(true);
    expect(parseState({ events: "no" }).events).toBe(true);
  });
});
