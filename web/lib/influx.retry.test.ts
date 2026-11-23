import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: 0,
  // Per-call script: each entry is consumed by one iterateRows() call.
  script: [] as Array<{ rows?: Record<string, unknown>[]; throwErr?: unknown }>,
  /** Every Flux string the code ran, in call order. */
  fluxes: [] as string[],
  /** When set, any query reading panel grid power throws this (no script step consumed). */
  panelErr: null as unknown,
  /** When set and it returns an array for a Flux string, those rows answer that query (no script step consumed). */
  route: null as null | ((flux: string) => Record<string, unknown>[] | undefined),
}));

vi.mock("@influxdata/influxdb-client", () => ({
  InfluxDB: class {
    getQueryApi() {
      return {
        async *iterateRows(flux: string) {
          state.calls++;
          state.fluxes.push(flux);
          if (state.panelErr && flux.includes("grid_power_w")) throw state.panelErr;
          const routed = state.route?.(flux);
          if (routed) {
            for (const o of routed) yield { values: [], tableMeta: { toObject: () => o } };
            return;
          }
          const step = state.script.shift() ?? {};
          for (const o of step.rows ?? []) yield { values: [], tableMeta: { toObject: () => o } };
          if (step.throwErr) throw step.throwErr;
        },
      };
    }
  },
}));

let influx: typeof import("./influx");
beforeAll(async () => {
  vi.stubEnv("INFLUX_URL", "http://influx.test");
  vi.stubEnv("INFLUX_TOKEN", "t");
  influx = await import("./influx");
});
beforeEach(() => {
  state.calls = 0;
  state.script = [];
  state.fluxes = [];
  state.panelErr = null;
  state.route = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
const F = Date.parse("2026-11-23T00:00:00Z");
const T = Date.parse("2026-11-23T06:00:00Z");

const callers: Array<[string, () => Promise<unknown>]> = [
  ["queryLastPointTime", () => influx.queryLastPointTime("collector_poll", "panel_age_ms", "1h")],
  ["queryBathKwh", () => influx.queryBathKwh(F, T)],
  ["queryHvacModeFieldSums", () => influx.queryHvacModeFieldSums(F, T)],
  ["queryHvacModeIntervals", () => influx.queryHvacModeIntervals(F, T)],
  ["queryEvents", () => influx.queryEvents(F, T)],
  [
    "queryPower",
    () => influx.queryPower({ fromMs: F, toMs: T, interval: "5m", nowMs: T + 3_600_000 }),
  ],
  [
    "queryEnergyByCategory",
    () => influx.queryEnergyByCategory({ fromMs: F, toMs: T, nowMs: T + 3_600_000 }),
  ],
];

describe("influx query retry", () => {
  it.each(callers)("%s retries once after a connection reset", async (_name, call) => {
    state.script = [{ throwErr: reset() }];
    await expect(call()).resolves.toBeDefined();
    expect(state.calls).toBeGreaterThanOrEqual(2);
  });

  it("discards rows from a failed attempt", async () => {
    const bathRow = {
      _time: "2026-11-23T01:00:00Z",
      _measurement: "bath_event",
      duration_min: 30,
      energy_kwh: 1,
    };
    state.script = [{ rows: [bathRow], throwErr: reset() }, { rows: [bathRow] }];
    const events = await influx.queryEvents(F, T);
    expect(events).toHaveLength(1);
    expect(state.calls).toBe(2);
  });

  it("does not retry an HTTP status error", async () => {
    state.script = [{ throwErr: Object.assign(new Error("503"), { name: "HttpError", statusCode: 503 }) }];
    await expect(influx.queryBathKwh(F, T)).rejects.toThrow("503");
    expect(state.calls).toBe(1);
  });

  it("does not retry a timeout", async () => {
    state.script = [
      { throwErr: Object.assign(new Error("timed out"), { name: "RequestTimedOutError" }) },
    ];
    await expect(influx.queryBathKwh(F, T)).rejects.toThrow("timed out");
    expect(state.calls).toBe(1);
  });

  it("gives up after one retry", async () => {
    state.script = [{ throwErr: reset() }, { throwErr: reset() }];
    await expect(influx.queryBathKwh(F, T)).rejects.toThrow("ECONNRESET");
    expect(state.calls).toBe(2);
  });
});

describe("queryPower and the Unmonitored band", () => {
  const opts = { fromMs: F, toMs: T, interval: "5m" as const, nowMs: T + 3_600_000 };
  const isPanel = (f: string) => f.includes("grid_power_w");
  const catRow = (time: string, category: string, v: number) => ({ _time: time, category, _value: v });
  it("the category view also reads panel grid power", async () => {
    await influx.queryPower(opts);
    expect(state.fluxes.some((f) => f.includes(`r._measurement == "panel"`) && isPanel(f))).toBe(true);
  });
  it("a drill never reads panel grid power", async () => {
    await influx.queryPower({ ...opts, grouping: { kind: "circuit", category: "HVAC" } });
    expect(state.fluxes.some(isPanel)).toBe(false);
  });
  it("grid: false (the Overview strip) runs no panel query and is not partial", async () => {
    state.route = (f) => (isPanel(f) ? [] : [catRow("2026-11-23T01:05:00Z", "HVAC", 400)]);
    const r = await influx.queryPower({ ...opts, grid: false });
    expect(state.fluxes.some(isPanel)).toBe(false);
    expect(r.partial).toBe(false);
    expect(r.data.map((p) => p.series)).toEqual(["HVAC"]);
  });
  it("a failed panel query keeps the category series and marks the result partial", async () => {
    state.panelErr = Object.assign(new Error("503"), { name: "HttpError", statusCode: 503 });
    state.script = [{ rows: [catRow("2026-11-23T01:05:00Z", "HVAC", 400), catRow("2026-11-23T01:05:00Z", "Else", 100)] }];
    const r = await influx.queryPower(opts);
    expect(r.partial).toBe(true);
    expect(r.data).toEqual([
      { time: "2026-11-23T01:05:00Z", series: "HVAC", watts: 400 },
      { time: "2026-11-23T01:05:00Z", series: "Else", watts: 100 },
    ]);
  });
  it("a healthy panel query is not partial", async () => {
    state.route = (f) => (isPanel(f) ? [] : [catRow("2026-11-23T01:05:00Z", "HVAC", 400)]);
    expect((await influx.queryPower(opts)).partial).toBe(false);
  });
  it("joins mocked grid rows to mocked category rows into an Unmonitored series", async () => {
    const t = "2026-11-23T01:05:00Z";
    state.route = (f) =>
      isPanel(f) ? [{ _time: t, _value: 1000 }] : [catRow(t, "HVAC", 400), catRow(t, "Else", 100)];
    const r = await influx.queryPower(opts);
    expect(r.partial).toBe(false);
    expect(r.data.filter((p) => p.series === "Unmonitored")).toEqual([
      { time: t, series: "Unmonitored", watts: 500 },
    ]);
    expect(r.data.filter((p) => p.series !== "Unmonitored")).toHaveLength(2);
  });
  it("the panel Flux is tagless raw grid power with no no-op group()", async () => {
    await influx.queryPower(opts);
    const panel = state.fluxes.find(isPanel)!;
    expect(panel).not.toContain("group()");
    expect(panel).toContain("aggregateWindow");
  });

  describe("seam alignment", () => {
    // 6h buckets, 1h rollup: now 14:20Z puts the seam at 13:00Z, which is not
    // on a 6h display boundary. The window runs to now (14:20Z), so the live
    // edge is not on one either.
    const ms = (iso: string) => Date.parse(iso);
    const seamOpts = {
      fromMs: ms("2026-11-23T06:00:00Z"),
      toMs: ms("2026-11-23T14:20:00Z"),
      interval: "6h" as const,
      nowMs: ms("2026-11-23T14:20:00Z"),
    };
    const route = (stamps: { bulkCat: string; bulkGrid: string; tailCat: string; tailGrid: string }) =>
      (f: string) => {
        const tail = f.includes("range(start: 2026-11-23T13:00:00.000Z");
        if (isPanel(f)) {
          return tail
            ? [{ _time: stamps.tailGrid, _value: 900 }]
            : [{ _time: stamps.bulkGrid, _value: 1000 }];
        }
        return tail
          ? [catRow(stamps.tailCat, "HVAC", 300)]
          : [catRow(stamps.bulkCat, "HVAC", 400)];
      };
    const unmon = (r: { data: { series: string; time: string; watts: number }[] }) =>
      r.data.filter((p) => p.series === "Unmonitored").map((p) => [p.time, p.watts]);
    const cats = (r: { data: { series: string; time: string }[] }) =>
      r.data.filter((p) => p.series === "HVAC").map((p) => p.time);

    it("pairs the stamps when Flux clips windows to the segment (the assumed behaviour)", async () => {
      state.route = route({
        bulkCat: "2026-11-23T13:00:00Z", bulkGrid: "2026-11-23T13:00:00Z",
        tailCat: "2026-11-23T14:20:00Z", tailGrid: "2026-11-23T14:20:00Z",
      });
      const r = await influx.queryPower(seamOpts);
      expect(unmon(r).map(([t, w]) => [Date.parse(t as string), w])).toEqual([
        [ms("2026-11-23T13:00:00Z"), 600],
        [ms("2026-11-23T14:20:00Z"), 600],
      ]);
    });
    it("still pairs them when the rollup window is stamped past the seam (range-bound clipping)", async () => {
      state.route = route({
        bulkCat: "2026-11-23T14:00:00Z", bulkGrid: "2026-11-23T13:00:00Z",
        tailCat: "2026-11-23T18:00:00Z", tailGrid: "2026-11-23T14:20:00Z",
      });
      const r = await influx.queryPower(seamOpts);
      expect(cats(r)).toEqual(["2026-11-23T13:00:00.000Z", "2026-11-23T14:20:00.000Z"]);
      expect(unmon(r).map(([t]) => Date.parse(t as string))).toEqual([
        ms("2026-11-23T13:00:00Z"), ms("2026-11-23T14:20:00Z"),
      ]);
      expect(unmon(r).map(([, w]) => w)).toEqual([600, 600]);
    });
    it("clamps a panel row stamped past its segment too", async () => {
      state.route = route({
        bulkCat: "2026-11-23T13:00:00Z", bulkGrid: "2026-11-23T18:00:00Z",
        tailCat: "2026-11-23T14:20:00Z", tailGrid: "2026-11-23T18:00:00Z",
      });
      expect(unmon(await influx.queryPower(seamOpts)).map(([, w]) => w)).toEqual([600, 600]);
    });
    it("leaves every bucket inside its segment untouched and never duplicates a timestamp", async () => {
      const inner = "2026-11-23T12:00:00Z";
      state.route = (f) => {
        const base = route({
          bulkCat: "2026-11-23T14:00:00Z", bulkGrid: "2026-11-23T13:00:00Z",
          tailCat: "2026-11-23T18:00:00Z", tailGrid: "2026-11-23T14:20:00Z",
        })(f);
        const tail = f.includes("range(start: 2026-11-23T13:00:00.000Z");
        if (tail) return base;
        return isPanel(f) ? [{ _time: inner, _value: 2000 }, ...base] : [catRow(inner, "HVAC", 500), ...base];
      };
      const r = await influx.queryPower(seamOpts);
      const times = cats(r).map((t) => Date.parse(t));
      expect(times).toEqual([ms(inner), ms("2026-11-23T13:00:00Z"), ms("2026-11-23T14:20:00Z")]);
      expect(new Set(times).size).toBe(times.length);
      expect(unmon(r).map(([, w]) => w)).toEqual([1500, 600, 600]);
    });
  });
});
