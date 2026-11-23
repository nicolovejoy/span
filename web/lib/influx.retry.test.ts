import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: 0,
  // Per-call script: each entry is consumed by one iterateRows() call.
  script: [] as Array<{ rows?: Record<string, unknown>[]; throwErr?: unknown }>,
  /** Every Flux string the code ran, in call order. */
  fluxes: [] as string[],
  /** When set, any query reading panel grid power throws this (no script step consumed). */
  panelErr: null as unknown,
}));

vi.mock("@influxdata/influxdb-client", () => ({
  InfluxDB: class {
    getQueryApi() {
      return {
        async *iterateRows(flux: string) {
          state.calls++;
          state.fluxes.push(flux);
          if (state.panelErr && flux.includes("grid_power_w")) throw state.panelErr;
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
  it("the category view also reads panel grid power", async () => {
    await influx.queryPower(opts);
    expect(state.fluxes.some((f) => f.includes(`r._measurement == "panel"`) && f.includes("grid_power_w"))).toBe(true);
  });
  it("a drill never reads panel grid power", async () => {
    await influx.queryPower({ ...opts, grouping: { kind: "circuit", category: "HVAC" } });
    expect(state.fluxes.some((f) => f.includes("grid_power_w"))).toBe(false);
  });
  it("a failed panel query leaves the category series working", async () => {
    state.panelErr = Object.assign(new Error("503"), { name: "HttpError", statusCode: 503 });
    await expect(influx.queryPower(opts)).resolves.toEqual([]);
  });
});
