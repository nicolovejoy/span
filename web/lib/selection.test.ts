import { describe, it, expect } from "vitest";
import {
  EVERYTHING, SELECTABLE, activePreset, categoriesNeedingCircuits, categoryState, chartCategories,
  isCircuitOn, isOn, offCircuitsIn, offFromShow, offKey, onlyThese, parseOff, partialCategories,
  presetOff, pruneCircuits, pruneFirstSeen, sameOff, serializeOff, showTotal, toggle, toggleCircuit, withCircuits,
  type OffSet,
} from "./selection";

describe("selectable keys", () => {
  it("are the five chart categories in stack order, then Unmonitored", () => {
    expect(SELECTABLE).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else", "Unmonitored"]);
  });
});

describe("isOn / toggle", () => {
  it("everything is on by default", () => {
    expect(SELECTABLE.every((k) => isOn(EVERYTHING, k))).toBe(true);
  });
  it("a key not in the off list is on, including one this build has never heard of", () => {
    expect(isOn({ categories: ["Car"], circuits: [] }, "Lights")).toBe(true);
    expect(isOn({ categories: ["Car"], circuits: [] }, "Solar")).toBe(true);
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
  it("lists every on band in stack order, Unmonitored last", () => {
    expect(chartCategories(EVERYTHING)).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else", "Unmonitored"]);
    expect(chartCategories({ categories: ["Car"], circuits: [] })).toEqual(["HVAC", "Lights", "Appliances", "Else", "Unmonitored"]);
    expect(chartCategories({ categories: ["Unmonitored"], circuits: [] })).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else"]);
  });
  it("only Unmonitored ticked draws only Unmonitored", () => {
    expect(chartCategories(onlyThese(["Unmonitored"]))).toEqual(["Unmonitored"]);
  });
  it("presets: House keeps Unmonitored, HVAC only and Car only drop it", () => {
    expect(chartCategories(presetOff("house"))).toEqual(["HVAC", "Lights", "Appliances", "Else", "Unmonitored"]);
    expect(chartCategories(presetOff("hvac"))).toEqual(["HVAC"]);
    expect(chartCategories(presetOff("car"))).toEqual(["Car"]);
  });
  it("legacy links: off=Unmonitored and show=… still parse to the same bands", () => {
    expect(chartCategories(parseOff("Unmonitored"))).toEqual(["HVAC", "Car", "Lights", "Appliances", "Else"]);
    expect(chartCategories(offFromShow(["HVAC"]))).toEqual(["HVAC"]);
    expect(chartCategories(offFromShow(["HVAC", "Unmonitored"]))).toEqual(["HVAC", "Unmonitored"]);
  });
  it("Unmonitored never becomes a circuit category", () => {
    const off = toggle(EVERYTHING, "Unmonitored");
    expect(categoryState(off, "Unmonitored")).toBe("off");
    expect(partialCategories(off)).toEqual([]);
    expect(categoriesNeedingCircuits(EVERYTHING, ["Unmonitored"])).toEqual([]);
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
    expect(activePreset({ categories: ["Car"], circuits: [] })).toBe("house");
    expect(activePreset({ categories: ["Unmonitored", "Else", "Appliances", "Lights", "Car"], circuits: [] })).toBe("hvac");
    expect(activePreset({ categories: ["Car", "Lights"], circuits: [] })).toBeNull();
  });
  it("onlyThese turns everything else off", () => {
    expect(onlyThese(["Lights"]).categories).toEqual(["HVAC", "Car", "Appliances", "Else", "Unmonitored"]);
  });
});

describe("URL form", () => {
  it("serialises in canonical order, empty when nothing is off", () => {
    expect(serializeOff(EVERYTHING)).toBe("");
    expect(serializeOff({ categories: ["Unmonitored", "Car"], circuits: [] })).toBe("Car,Unmonitored");
  });
  it("parses, dropping unknown, duplicate and empty items", () => {
    expect(parseOff("Furnace,Car,Car,,").categories).toEqual(["Car"]);
    expect(parseOff("").categories).toEqual([]);
    expect(parseOff(undefined).categories).toEqual([]);
  });
  it("round-trips", () => {
    const o = { categories: ["HVAC", "Unmonitored"], circuits: [] };
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
  it("a show with only unknown names means everything, not nothing", () => {
    expect(offFromShow(["Furnace"])).toEqual(EVERYTHING);
    expect(offFromShow(["Furnace", "Boiler"])).toEqual(EVERYTHING);
  });
});

describe("showTotal", () => {
  it("is shown with everything on", () => {
    expect(showTotal(EVERYTHING)).toBe(true);
  });
  it("is hidden when only Unmonitored is off (it is drawn now)", () => {
    expect(showTotal({ categories: ["Unmonitored"], circuits: [] })).toBe(false);
  });
  it("is hidden when a chart category is off", () => {
    expect(showTotal({ categories: ["Car"], circuits: [] })).toBe(false);
    expect(showTotal({ categories: ["Car", "Unmonitored"], circuits: [] })).toBe(false);
  });
  it("is hidden when everything is off", () => {
    const none = SELECTABLE.reduce((o, k) => toggle(o, k), EVERYTHING);
    expect(showTotal(none)).toBe(false);
  });
});

const HP = "Heat pump (HP)";
const CTRL = "Heat pump (HP) / Control";
const AUX = "Auxiliary / Heat pump (HP)";
const HVAC_MEMBERS = [HP, CTRL, AUX];
const LIV = "Lights / Living room, Upstairs";
const os = (categories: string[], circuits: string[] = []): OffSet => ({ categories, circuits });

describe("circuit state", () => {
  it("a circuit is on unless it or its category is off", () => {
    const off = os(["Car"], [CTRL]);
    expect(isCircuitOn(off, HP)).toBe(true);
    expect(isCircuitOn(off, CTRL)).toBe(false);
    expect(isCircuitOn(off, "Tesla Car Charger")).toBe(false);
  });
  it("categoryState is on, partial or off", () => {
    const off = os(["Car"], [CTRL]);
    expect(categoryState(off, "HVAC")).toBe("partial");
    expect(categoryState(off, "Car")).toBe("off");
    expect(categoryState(off, "Lights")).toBe("on");
  });
  it("offCircuitsIn and partialCategories group circuits by category", () => {
    const off = os([], [CTRL, LIV]);
    expect(offCircuitsIn(off, "HVAC")).toEqual([CTRL]);
    expect(partialCategories(off)).toEqual(["HVAC", "Lights"]);
  });
});

describe("toggleCircuit", () => {
  it("turns one circuit off and back on", () => {
    const a = toggleCircuit(EVERYTHING, CTRL, HVAC_MEMBERS);
    expect(a).toEqual(os([], [CTRL]));
    expect(toggleCircuit(a, CTRL, HVAC_MEMBERS)).toEqual(EVERYTHING);
  });
  it("unticking the last on circuit turns the whole category off", () => {
    let off = toggleCircuit(EVERYTHING, HP, HVAC_MEMBERS);
    off = toggleCircuit(off, CTRL, HVAC_MEMBERS);
    off = toggleCircuit(off, AUX, HVAC_MEMBERS);
    expect(off).toEqual(os(["HVAC"]));
  });
  it("ticking one circuit of an off category turns on only that circuit", () => {
    expect(toggleCircuit(os(["HVAC", "Car"]), HP, HVAC_MEMBERS)).toEqual(os(["Car"], [AUX, CTRL]));
  });
  it("drops this category's names that are not among its members, keeps others", () => {
    const off = toggleCircuit(os([], ["Heat pump (old name)", LIV]), CTRL, HVAC_MEMBERS);
    expect(off.circuits).toEqual([CTRL, LIV]);
  });
});

describe("category toggle with circuits", () => {
  it("a partly-off category ticks back to all on", () => {
    expect(toggle(os([], [CTRL, LIV]), "HVAC")).toEqual(os([], [LIV]));
  });
  it("an all-on category turns off; an off one turns on with every circuit", () => {
    expect(toggle(EVERYTHING, "HVAC")).toEqual(os(["HVAC"]));
    expect(toggle(os(["HVAC"]), "HVAC")).toEqual(EVERYTHING);
  });
});

describe("withCircuits / pruneCircuits", () => {
  it("normalises: sorted, deduped, no empties, none in an off category", () => {
    expect(withCircuits(os(["HVAC"]), [LIV, "", CTRL, LIV])).toEqual(os(["HVAC"], [LIV]));
  });
  it("prunes a category's stale names and returns the same object when nothing changes", () => {
    const off = os([], ["Heat pump (old name)", LIV]);
    expect(pruneCircuits(off, "HVAC", HVAC_MEMBERS)).toEqual(os([], [LIV]));
    const clean = os([], [CTRL]);
    expect(pruneCircuits(clean, "HVAC", HVAC_MEMBERS)).toBe(clean);
  });
  it("never prunes on an empty member list (a failed fetch)", () => {
    const off = os([], [CTRL]);
    expect(pruneCircuits(off, "HVAC", [])).toBe(off);
  });
});

describe("pruneFirstSeen", () => {
  const stale = os([], ["Heat pump (old name)", LIV]);
  it("the first response for a category prunes names it does not list", () => {
    const r = pruneFirstSeen(stale, new Map([["HVAC", HVAC_MEMBERS]]), new Set());
    expect(r.off).toEqual(os([], [LIV]));
    expect(r.done.has("HVAC")).toBe(true);
  });
  it("a later response for the same category prunes nothing, even if a name is missing", () => {
    const off = os([], [CTRL]);
    const r = pruneFirstSeen(off, new Map([["HVAC", [LIV]]]), new Set(["HVAC"]));
    expect(r.off).toBe(off);
  });
  it("an empty response never prunes and does not count as pruned once", () => {
    const r = pruneFirstSeen(stale, new Map([["HVAC", []]]), new Set());
    expect(r.off).toBe(stale);
    expect(r.done.has("HVAC")).toBe(false);
    const later = pruneFirstSeen(stale, new Map([["HVAC", HVAC_MEMBERS]]), r.done);
    expect(later.off).toEqual(os([], [LIV]));
  });
  it("does not mutate the done set it was given, and handles categories independently", () => {
    const done = new Set<string>();
    const r = pruneFirstSeen(stale, new Map([["HVAC", HVAC_MEMBERS], ["Car", []]]), done);
    expect(done.size).toBe(0);
    expect([...r.done]).toEqual(["HVAC"]);
  });
});

describe("whole-selection key, presets and Total with circuits", () => {
  it("offKey and sameOff tell circuit selections apart", () => {
    expect(offKey(EVERYTHING)).not.toBe(offKey(os([], [CTRL])));
    expect(sameOff(os([], [CTRL, LIV]), os([], [LIV, CTRL]))).toBe(true);
  });
  it("no preset is active while a circuit is off, and every preset clears circuits", () => {
    expect(activePreset(os([], [CTRL]))).toBeNull();
    expect(activePreset(os(["Car"], [CTRL]))).toBeNull();
    for (const id of ["everything", "house", "hvac", "car"] as const) {
      expect(presetOff(id).circuits).toEqual([]);
    }
  });
  it("Total hides when any circuit is off", () => {
    expect(showTotal(os([], [CTRL]))).toBe(false);
    expect(showTotal(os(["Unmonitored"]))).toBe(false);
  });
  it("categoriesNeedingCircuits is expanded ∪ partly off, in stack order, never Unmonitored", () => {
    expect(categoriesNeedingCircuits(os([], [LIV]), ["Car", "HVAC", "Unmonitored"])).toEqual(["HVAC", "Car", "Lights"]);
  });
});
