import { describe, it, expect } from "vitest";
import { initView, reducer, type ViewState } from "./viewState";
import { parseState } from "./url-state";
import { EVERYTHING, onlyThese } from "./selection";

const base = (over: Partial<ViewState> = {}): ViewState => ({
  ...initView(parseState({ range: "24h" })),
  ...over,
});

describe("drill focuses the selection", () => {
  it("narrows the selection to the drilled category and remembers the old one", () => {
    const s = reducer(base({ off: onlyThese(["HVAC", "Car"]) }), {
      type: "drill",
      category: "Lights",
    });
    expect(s.drill).toBe("Lights");
    expect(s.off).toEqual(onlyThese(["Lights"]));
    expect(s.offBeforeDrill).toEqual(onlyThese(["HVAC", "Car"]));
  });

  it("restores the remembered filter when the drill is backed out", () => {
    let s = reducer(base({ off: onlyThese(["HVAC", "Car"]) }), {
      type: "drill",
      category: "Lights",
    });
    s = reducer(s, { type: "drill", category: null });
    expect(s.drill).toBeNull();
    expect(s.off).toEqual(onlyThese(["HVAC", "Car"]));
    expect(s.offBeforeDrill).toBeNull();
  });

  it("remembers 'All' as All, not as the narrowed filter", () => {
    let s = reducer(base({ off: EVERYTHING }), { type: "drill", category: "Lights" });
    expect(s.off).toEqual(onlyThese(["Lights"]));
    s = reducer(s, { type: "drill", category: null });
    expect(s.off).toEqual(EVERYTHING);
  });

  it("follows the focus to another category, keeping the original memory", () => {
    let s = reducer(base({ off: onlyThese(["HVAC"]) }), {
      type: "drill",
      category: "HVAC",
    });
    s = reducer(s, { type: "drill", category: "Lights" });
    expect(s.off).toEqual(onlyThese(["Lights"]));
    expect(s.offBeforeDrill).toEqual(onlyThese(["HVAC"]));
    s = reducer(s, { type: "drill", category: null });
    expect(s.off).toEqual(onlyThese(["HVAC"]));
  });

  it("still clears the drill when the selection turns the drilled category out", () => {
    let s = reducer(base({ off: EVERYTHING }), { type: "drill", category: "Lights" });
    s = reducer(s, { type: "select", off: onlyThese(["HVAC"]) });
    expect(s.drill).toBeNull();
    expect(s.off).toEqual(onlyThese(["HVAC"]));
    // The user picked that filter by hand — there's nothing left to restore.
    expect(s.offBeforeDrill).toBeNull();
  });

  it("keeps the drill (and the memory) when the selection still includes it", () => {
    let s = reducer(base({ off: EVERYTHING }), { type: "drill", category: "Lights" });
    s = reducer(s, { type: "select", off: onlyThese(["Lights", "HVAC"]) });
    expect(s.drill).toBe("Lights");
    expect(s.offBeforeDrill).toEqual(EVERYTHING);
  });

  it("survives a range change untouched", () => {
    let s = reducer(base({ off: onlyThese(["HVAC"]) }), {
      type: "drill",
      category: "Lights",
    });
    s = reducer(s, { type: "preset", preset: "7d", now: Date.now() });
    expect(s.drill).toBe("Lights");
    expect(s.off).toEqual(onlyThese(["Lights"]));
    expect(s.offBeforeDrill).toEqual(onlyThese(["HVAC"]));
  });
});

describe("select action", () => {
  it("a selection that keeps the drilled category on leaves the drill; one that turns it off clears it", () => {
    let s = reducer(base({ off: EVERYTHING }), { type: "drill", category: "Lights" });
    s = reducer(s, { type: "select", off: { categories: ["Lights"] } });
    expect(s.drill).toBeNull();
    expect(s.offBeforeDrill).toBeNull();
    expect(s.off).toEqual({ categories: ["Lights"] });
  });
});

describe("events action", () => {
  it("toggles the events flag and nothing else", () => {
    const base = initView(parseState({}));
    const off = reducer(base, { type: "events", on: false });
    expect(off.events).toBe(false);
    expect({ ...off, events: true }).toEqual(base);
    expect(reducer(off, { type: "events", on: true }).events).toBe(true);
  });
});

describe("initView", () => {
  it("starts with nothing to restore — a URL drill is already narrowed", () => {
    const s = initView(parseState({ range: "7d", drill: "Lights" }));
    expect(s.off).toEqual(onlyThese(["Lights"]));
    expect(s.offBeforeDrill).toBeNull();
    // Backing out of a drill you arrived at by URL leaves the selection narrowed.
    expect(reducer(s, { type: "drill", category: null }).off).toEqual(
      onlyThese(["Lights"]),
    );
  });
});
