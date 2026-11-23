import { describe, it, expect } from "vitest";
import { initView, reducer, type ViewState } from "./viewState";
import { parseState } from "./url-state";
import { EVERYTHING, onlyThese } from "./selection";

const base = (over: Partial<ViewState> = {}): ViewState => ({
  ...initView(parseState({ range: "24h" })),
  ...over,
});

describe("expand action", () => {
  it("toggles a category's circuit rows, keeping stack order", () => {
    let s = reducer(base(), { type: "expand", category: "Lights" });
    s = reducer(s, { type: "expand", category: "HVAC" });
    expect(s.expanded).toEqual(["HVAC", "Lights"]);
    expect(reducer(s, { type: "expand", category: "HVAC" }).expanded).toEqual(["Lights"]);
  });
  it("leaves the selection alone; select leaves the expansion alone", () => {
    const s = reducer(base(), { type: "expand", category: "HVAC" });
    expect(s.off).toEqual(EVERYTHING);
    const t = reducer(s, { type: "select", off: onlyThese(["Car"]) });
    expect(t.expanded).toEqual(["HVAC"]);
    expect(t.off).toEqual(onlyThese(["Car"]));
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
