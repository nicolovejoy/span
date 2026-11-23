import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: 0, partial: false }));

vi.mock("./influx", () => ({
  queryPower: vi.fn(async () => {
    state.calls++;
    return { data: [{ time: "2026-11-01T00:00:00Z", series: "HVAC", watts: 1 }], partial: state.partial };
  }),
}));

import { cachedQueryPower, PARTIAL_TTL_MS } from "./queryCache";

const NOW = Date.parse("2026-11-23T18:00:00Z");
const H = 3_600_000;
let n = 0;
// A fresh window per test: the cache is module-scope.
const win = () => {
  n++;
  return { fromMs: NOW - (100 + n) * 24 * H, toMs: NOW - (50 + n) * 24 * H, interval: "1h" as const };
};

beforeEach(() => {
  state.calls = 0;
  state.partial = false;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("cachedQueryPower and partial results", () => {
  it("keeps a healthy historical result for a day", async () => {
    const w = win();
    await cachedQueryPower(w);
    vi.advanceTimersByTime(23 * H);
    const r = await cachedQueryPower(w);
    expect(state.calls).toBe(1);
    expect(r.partial).toBe(false);
  });
  it("keeps a partial historical result for at most 60 s", async () => {
    state.partial = true;
    const w = win();
    await cachedQueryPower(w);
    vi.advanceTimersByTime(PARTIAL_TTL_MS - 1_000);
    const r = await cachedQueryPower(w);
    expect(state.calls).toBe(1);
    expect(r.partial).toBe(true);
    vi.advanceTimersByTime(2_000);
    state.partial = false;
    const again = await cachedQueryPower(w);
    expect(state.calls).toBe(2);
    expect(again.partial).toBe(false);
  });
  it("PARTIAL_TTL_MS is at most a minute", () => {
    expect(PARTIAL_TTL_MS).toBeLessThanOrEqual(60_000);
  });
  it("a grid-less request does not share an entry with the default", async () => {
    const w = win();
    await cachedQueryPower(w);
    await cachedQueryPower({ ...w, grid: false });
    expect(state.calls).toBe(2);
    await cachedQueryPower({ ...w, grid: false });
    expect(state.calls).toBe(2);
  });
});
