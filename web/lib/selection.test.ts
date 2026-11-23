import { describe, it, expect } from "vitest";
import {
  EVERYTHING, SELECTABLE, activePreset, chartCategories, isFiltered, isOn,
  offFromShow, onlyThese, parseOff, presetOff, sameOff, serializeOff, toggle,
} from "./selection";

describe("selectable keys", () => {
  it("are the five chart categories in stack order, then Unmonitored", () => {
    expect(SELECTABLE).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else", "Unmonitored"]);
  });
});

describe("isOn / toggle / isFiltered", () => {
  it("everything is on by default", () => {
    expect(SELECTABLE.every((k) => isOn(EVERYTHING, k))).toBe(true);
    expect(isFiltered(EVERYTHING)).toBe(false);
  });
  it("a key not in the off list is on, including one this build has never heard of", () => {
    expect(isOn({ categories: ["Car"] }, "Lights")).toBe(true);
    expect(isOn({ categories: ["Car"] }, "Solar")).toBe(true);
  });
  it("toggle turns off then back on, keeping canonical order", () => {
    const a = toggle(toggle(EVERYTHING, "Unmonitored"), "Car");
    expect(a.categories).toEqual(["Car", "Unmonitored"]);
    expect(toggle(a, "Car").categories).toEqual(["Unmonitored"]);
  });
  it("can turn everything off", () => {
    const none = SELECTABLE.reduce((o, k) => toggle(o, k), EVERYTHING);
    expect(SELECTABLE.some((k) => isOn(none, k))).toBe(false);
    expect(chartCategories(none)).toEqual([]);
  });
});

describe("chartCategories", () => {
  it("lists on categories that have a power line, never Unmonitored", () => {
    expect(chartCategories(EVERYTHING)).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else"]);
    expect(chartCategories({ categories: ["Car"] })).toEqual(["HVAC", "Lights", "Appliances", "Else"]);
  });
});

describe("presets", () => {
  it("map to off sets", () => {
    expect(presetOff("everything").categories).toEqual([]);
    expect(presetOff("house").categories).toEqual(["Car"]);
    expect(presetOff("hvac").categories).toEqual(["Car", "Lights", "Appliances", "Else", "Unmonitored"]);
    expect(presetOff("car").categories).toEqual(["HVAC", "Lights", "Appliances", "Else", "Unmonitored"]);
  });
  it("activePreset recognises each preset regardless of order, else null", () => {
    expect(activePreset(EVERYTHING)).toBe("everything");
    expect(activePreset({ categories: ["Car"] })).toBe("house");
    expect(activePreset({ categories: ["Unmonitored", "Else", "Appliances", "Lights", "Car"] })).toBe("hvac");
    expect(activePreset({ categories: ["Car", "Lights"] })).toBeNull();
  });
  it("onlyThese turns everything else off", () => {
    expect(onlyThese(["Lights"]).categories).toEqual(["HVAC", "Car", "Appliances", "Else", "Unmonitored"]);
  });
});

describe("URL form", () => {
  it("serialises in canonical order, empty when nothing is off", () => {
    expect(serializeOff(EVERYTHING)).toBe("");
    expect(serializeOff({ categories: ["Unmonitored", "Car"] })).toBe("Car,Unmonitored");
  });
  it("parses, dropping unknown, duplicate and empty items", () => {
    expect(parseOff("Furnace,Car,Car,,").categories).toEqual(["Car"]);
    expect(parseOff("").categories).toEqual([]);
    expect(parseOff(undefined).categories).toEqual([]);
  });
  it("round-trips", () => {
    const o = { categories: ["HVAC", "Unmonitored"] };
    expect(sameOff(parseOff(serializeOff(o)), o)).toBe(true);
  });
});

describe("offFromShow (legacy show= URLs)", () => {
  it("an empty show means everything on", () => {
    expect(offFromShow([]).categories).toEqual([]);
  });
  it("show=HVAC means only HVAC, Unmonitored off too", () => {
    expect(offFromShow(["HVAC"]).categories).toEqual(["Car", "Lights", "Appliances", "Else", "Unmonitored"]);
  });
  it("ignores unknown names", () => {
    expect(offFromShow(["HVAC", "Furnace"])).toEqual(offFromShow(["HVAC"]));
  });
});
