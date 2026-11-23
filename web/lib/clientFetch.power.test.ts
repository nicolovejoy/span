import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ urls: [] as string[], partial: false }));

import { fetchSeriesCached } from "./clientFetch";

const pt = { time: "2026-11-01T00:00:00Z", series: "HVAC", watts: 1 };
const H = 3_600_000;
let n = 0;
const win = () => {
  n++;
  const to = Date.parse("2026-10-01T00:00:00Z") - n * 24 * H;
  return { from: to - 24 * H, to };
};

beforeEach(() => {
  state.urls = [];
  state.partial = false;
  vi.stubGlobal("location", { origin: "http://x.test" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      state.urls.push(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [pt], ...(state.partial ? { partial: true } : {}) }),
      };
    }),
  );
});

describe("fetchSeriesCached", () => {
  it("caches a healthy response", async () => {
    const w = win();
    await fetchSeriesCached(w.from, w.to, "1h");
    await fetchSeriesCached(w.from, w.to, "1h");
    expect(state.urls).toHaveLength(1);
  });
  it("returns a partial response's data but does not store it", async () => {
    state.partial = true;
    const w = win();
    expect(await fetchSeriesCached(w.from, w.to, "1h")).toEqual([pt]);
    await fetchSeriesCached(w.from, w.to, "1h");
    expect(state.urls).toHaveLength(2);
  });
  it("sends grid=0 only when opted out, and keeps the two apart in the cache", async () => {
    const w = win();
    await fetchSeriesCached(w.from, w.to, "1h");
    await fetchSeriesCached(w.from, w.to, "1h", undefined, false);
    expect(state.urls).toHaveLength(2);
    expect(new URL(state.urls[0]!).searchParams.has("grid")).toBe(false);
    expect(new URL(state.urls[1]!).searchParams.get("grid")).toBe("0");
    await fetchSeriesCached(w.from, w.to, "1h", undefined, false);
    expect(state.urls).toHaveLength(2);
  });
});
