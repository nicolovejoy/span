# Influx ECONNRESET Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry an InfluxDB query exactly once, after a fixed 250 ms pause, when the connection was reset (ECONNRESET), so a ~1 minute Vercel→Influx reset storm no longer 500s the explorer's SSR.

**Architecture:** A new pure module `web/lib/influxRetry.ts` holds the retry decision (`isConnectionResetError`) and a tiny wrapper (`withRetryOnce`). In `web/lib/influx.ts`, all eight query sites that today each open a client and iterate rows are collapsed into one helper, `queryRows(flux)`, which runs the whole fetch-and-collect inside `withRetryOnce`; so no query path can bypass the retry, and a failed attempt's partial rows are discarded rather than duplicated.

**Tech Stack:** TypeScript, Next.js 16 (Vercel), `@influxdata/influxdb-client` 1.35.0 (node transport, `dist/index.mjs`), vitest 4.1.9. No new dependencies.

**Spec:** `CLAUDE.md` § Next Steps, "Decided 2026-11-23" item (d): "Add a one-retry-on-ECONNRESET in `web/lib/influx.ts`: on 2026-11-23 17:04Z, Vercel→Influx connections were reset for ~1 min, and the explorer SSR 500'd (health stayed up; Pi logs clean)." Read `CLAUDE.md` § web/ and `web/AGENTS.md` first.

## Global Constraints

- Exactly one retry (two attempts total); fixed delay `RETRY_DELAY_MS = 250`; no backoff, no jitter.
- Retry only on a connection reset: an error, or anything in its `cause` chain, with `code === "ECONNRESET"`, or a message matching `/socket hang up/i` (Node's own text for the same event). Nothing else is retried.
- Never retry: HTTP status errors (any error with a numeric `statusCode`, i.e. the client's `HttpError`, including 401/403/5xx), `RequestTimedOutError` (`name`), `AbortError` (`name`), query errors, ETIMEDOUT/ECONNREFUSED/EPIPE and every other code.
- If the second attempt fails, its error is thrown (not the first).
- The retry decision is a pure function with vitest unit tests. No new dependencies.
- All query paths in `web/lib/influx.ts` go through the retry: `queryLastPointTime`, `queryPanelKwh` (via `queryEnergyByCategory`), `queryHvacModeFieldSums`, `queryBathKwh`, `queryHvacModeIntervals`, `queryEvents`, `runPowerFlux` (via `queryPower`), `runEnergyFlux` (via `queryEnergyByCategory`).
- Tests: `cd web && npm test` (vitest, no config file; picks up `lib/*.test.ts`). A fresh worktree has no `web/node_modules`: run `cd web && npm ci` once before the first test run.
- Pi code and the 120 s client timeout are untouched.

## Review Focus

- A reset that happens after some rows have already streamed back (mid-iteration): the retry must restart collection, so the result holds only the second attempt's rows, never both. Pinned in Task 2.
- `fetch failed` style errors where ECONNRESET sits on `err.cause` (or `err.cause.cause`): must retry. Pinned in Task 1.
- A client `HttpError` with status 503 or 429: the library's own `canRetry()` says yes, ours must say no. Pinned in Task 1 and Task 2.
- Timeout (`RequestTimedOutError`, 120 s) must not retry (would double a two-minute wait). Pinned in Task 1.
- Garbage thrown values (`null`, a string, an error whose `cause` points back at itself) must not crash or loop the predicate. Pinned in Task 1.

---

### Task 1: Pure retry decision and wrapper

**Files:**
- Create: `web/lib/influxRetry.ts`
- Test: `web/lib/influxRetry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const RETRY_DELAY_MS = 250`
  - `export function isConnectionResetError(err: unknown): boolean`
  - `export async function withRetryOnce<T>(fn: () => Promise<T>, opts?: { delayMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<T>`

- [ ] **Step 1: Write the failing tests** in `web/lib/influxRetry.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { isConnectionResetError, withRetryOnce, RETRY_DELAY_MS } from "./influxRetry";

const withCode = (code: string, message = "boom") =>
  Object.assign(new Error(message), { code });

describe("isConnectionResetError", () => {
  it("retries a bare ECONNRESET", () => {
    expect(isConnectionResetError(withCode("ECONNRESET", "read ECONNRESET"))).toBe(true);
  });
  it("retries Node's 'socket hang up' even without a code", () => {
    expect(isConnectionResetError(new Error("socket hang up"))).toBe(true);
  });
  it("retries fetch failed with ECONNRESET on cause", () => {
    const e = new TypeError("fetch failed", { cause: withCode("ECONNRESET") });
    expect(isConnectionResetError(e)).toBe(true);
  });
  it("retries ECONNRESET two causes deep", () => {
    const e = new Error("a", { cause: new Error("b", { cause: withCode("ECONNRESET") }) });
    expect(isConnectionResetError(e)).toBe(true);
  });
  it("does not retry an HttpError, even 503 with a reset-looking message", () => {
    const e = Object.assign(new Error("503 socket hang up"), { name: "HttpError", statusCode: 503 });
    expect(isConnectionResetError(e)).toBe(false);
  });
  it("does not retry 401", () => {
    const e = Object.assign(new Error("unauthorized"), { name: "HttpError", statusCode: 401 });
    expect(isConnectionResetError(e)).toBe(false);
  });
  it("does not retry RequestTimedOutError or AbortError", () => {
    expect(isConnectionResetError(Object.assign(new Error("Request timed out"), { name: "RequestTimedOutError" }))).toBe(false);
    expect(isConnectionResetError(Object.assign(new Error("Response aborted"), { name: "AbortError" }))).toBe(false);
  });
  it("does not retry other network codes or query errors", () => {
    for (const code of ["ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND"]) {
      expect(isConnectionResetError(withCode(code))).toBe(false);
    }
    expect(isConnectionResetError(new Error("compilation failed: syntax error"))).toBe(false);
  });
  it("survives non-errors and cyclic causes", () => {
    expect(isConnectionResetError(null)).toBe(false);
    expect(isConnectionResetError(undefined)).toBe(false);
    expect(isConnectionResetError("ECONNRESET")).toBe(false);
    const cyc: Error & { cause?: unknown } = new Error("loop");
    cyc.cause = cyc;
    expect(isConnectionResetError(cyc)).toBe(false);
  });
});

describe("withRetryOnce", () => {
  it("returns the first result without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => 7);
    expect(await withRetryOnce(fn, { sleep })).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("retries once after RETRY_DELAY_MS on a reset", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValueOnce(withCode("ECONNRESET")).mockResolvedValueOnce("ok");
    expect(await withRetryOnce(fn, { sleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(RETRY_DELAY_MS);
    expect(RETRY_DELAY_MS).toBe(250);
  });
  it("throws the second error when the retry also fails", async () => {
    const second = withCode("ECONNRESET", "second");
    const fn = vi.fn().mockRejectedValueOnce(withCode("ECONNRESET", "first")).mockRejectedValueOnce(second);
    await expect(withRetryOnce(fn, { sleep: async () => {} })).rejects.toBe(second);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("does not retry a non-reset error", async () => {
    const err = Object.assign(new Error("nope"), { name: "HttpError", statusCode: 503 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetryOnce(fn, { sleep: async () => {} })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run lib/influxRetry.test.ts`
Expected: FAIL, cannot resolve `./influxRetry`.

- [ ] **Step 3: Implement `web/lib/influxRetry.ts`** with the three exports above.

`isConnectionResetError`: first reject by status/name (below), then walk the chain `err`, `err.cause`, … to a depth of 5 (cap handles cycles). Return `false` immediately for any value in the chain that is an object with a numeric `statusCode` or with `name` of `"HttpError"`, `"RequestTimedOutError"` or `"AbortError"` (checked on the top-level error only, so a wrapper that carries a status never gets retried). Otherwise return `true` if any level has `code === "ECONNRESET"` or a string `message` matching `/socket hang up/i`. Non-objects (null, strings) are `false`. `withRetryOnce`: `try { return await fn() } catch (e) { if (!isConnectionResetError(e)) throw e; console.warn("influx: connection reset, retrying once"); await (opts?.sleep ?? defaultSleep)(opts?.delayMs ?? RETRY_DELAY_MS); return fn(); }` where `defaultSleep` is a `setTimeout` promise.

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run lib/influxRetry.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add web/lib/influxRetry.ts web/lib/influxRetry.test.ts
git commit -m "feat(web): pure ECONNRESET retry decision for influx queries"
```

(End the commit message with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.)

---

### Task 2: Route every query in `influx.ts` through one retrying helper

**Files:**
- Modify: `web/lib/influx.ts` (import; new `queryRows`; the eight call sites listed below)
- Test: `web/lib/influx.retry.test.ts`

**Interfaces:**
- Consumes: `withRetryOnce` from `./influxRetry` (Task 1).
- Produces: internal (not exported) `async function queryRows(flux: string): Promise<Record<string, unknown>[]>`. Public exports of `influx.ts` keep their current signatures and behavior.

- [ ] **Step 1: Write the failing wiring test** in `web/lib/influx.retry.test.ts`

The test mocks the client module so no network is touched. Pattern:

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: 0,
  // Per-call script: each entry is consumed by one iterateRows() call.
  script: [] as Array<{ rows?: Record<string, unknown>[]; throwErr?: unknown }>,
}));

vi.mock("@influxdata/influxdb-client", () => ({
  InfluxDB: class {
    getQueryApi() {
      return {
        async *iterateRows() {
          state.calls++;
          const step = state.script.shift() ?? {};
          for (const o of step.rows ?? []) yield { values: [], tableMeta: { toObject: () => o } };
          if (step.throwErr) throw step.throwErr;
        },
      };
    },
  };
}));

let influx: typeof import("./influx");
beforeAll(async () => {
  vi.stubEnv("INFLUX_URL", "http://influx.test");
  vi.stubEnv("INFLUX_TOKEN", "t");
  influx = await import("./influx");
});
beforeEach(() => { state.calls = 0; state.script = []; });

const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
const F = Date.parse("2026-11-23T00:00:00Z");
const T = Date.parse("2026-11-23T06:00:00Z");
```

Tests to include (names exact):

1. `it.each` named `"%s retries once after a connection reset"` over these zero-arg callers, each run with `state.script = [{ throwErr: reset() }]` (all later calls yield no rows) and asserting the promise resolves and `state.calls >= 2`:
   - `queryLastPointTime`: `() => influx.queryLastPointTime("collector_poll", "panel_age_ms", "1h")`
   - `queryBathKwh`: `() => influx.queryBathKwh(F, T)`
   - `queryHvacModeFieldSums`: `() => influx.queryHvacModeFieldSums(F, T)`
   - `queryHvacModeIntervals`: `() => influx.queryHvacModeIntervals(F, T)`
   - `queryEvents`: `() => influx.queryEvents(F, T)`
   - `queryPower`: `() => influx.queryPower({ fromMs: F, toMs: T, interval: <a valid IntervalKey from ./interval, e.g. the first one that sourceForInterval accepts>, nowMs: T + 3_600_000 })`
   - `queryEnergyByCategory`: `() => influx.queryEnergyByCategory({ fromMs: F, toMs: T, nowMs: T + 3_600_000 })` (this one fans out to several parallel queries; the single scripted failure lands on whichever runs first and must still resolve)
2. `"discards rows from a failed attempt"`: `queryEvents(F, T)` with `state.script = [{ rows: [bathRow], throwErr: reset() }, { rows: [bathRow] }]` where `bathRow = { _time: "2026-11-23T01:00:00Z", _measurement: "bath_event", duration_min: 30, energy_kwh: 1 }`. Assert the result has length 1 (not 2) and `state.calls === 2`.
3. `"does not retry an HTTP status error"`: `queryBathKwh(F, T)` with `state.script = [{ throwErr: Object.assign(new Error("503"), { name: "HttpError", statusCode: 503 }) }]`; assert it rejects and `state.calls === 1`.
4. `"does not retry a timeout"`: same shape with `{ name: "RequestTimedOutError" }`; rejects, `state.calls === 1`.
5. `"gives up after one retry"`: `state.script = [{ throwErr: reset() }, { throwErr: reset() }]` on `queryBathKwh`; rejects, `state.calls === 2`.

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run lib/influx.retry.test.ts`
Expected: FAIL (the retry cases reject with the reset error; the "discards rows" and "gives up" cases fail on call counts).

- [ ] **Step 3: Implement in `web/lib/influx.ts`**

Add `import { withRetryOnce } from "./influxRetry";` and, just below `makeClient`, add

```ts
/** Run one Flux query and collect every row as a plain object. The whole
 *  fetch-and-collect is the retry unit: a reset mid-stream restarts from an
 *  empty array, and each attempt builds a fresh client (fresh connection). */
async function queryRows(flux: string): Promise<Record<string, unknown>[]> {
  return withRetryOnce(async () => {
    const out: Record<string, unknown>[] = [];
    const queryApi = makeClient().getQueryApi(ORG);
    for await (const row of queryApi.iterateRows(flux)) {
      out.push(row.tableMeta.toObject(row.values) as Record<string, unknown>);
    }
    return out;
  });
}
```

Then change each site so it no longer calls `makeClient()` / `getQueryApi` / `iterateRows` / `collectRows` itself, and instead does `const rows = await queryRows(flux)` followed by the same mapping it already does, over `rows` (each `o` is the already-converted object):

1. `runPowerFlux` — loop `for (const o of await queryRows(flux))`, same `out.push`.
2. `queryLastPointTime` — `const rows = await queryRows(flux); return (rows[0]?._time as string | undefined) ?? null;`
3. `queryPanelKwh` — `(Number(rows[0]?._value) || 0) / 1000.0` (keeps the existing "0 if no panel data" behavior).
4. `queryHvacModeFieldSums` — loop over `await queryRows(flux)`, same `sums[String(o._field)]` line.
5. `queryBathKwh` — `Number(rows[0]?._value) || 0` (unchanged expression).
6. `runEnergyFlux` — loop over `await queryRows(flux)`, same `out.push`.
7. `queryHvacModeIntervals` — loop over `await queryRows(flux)`, same `out.push`.
8. `queryEvents` — loop over `await queryRows(flux)`, same body.

After the edit, `grep -n "iterateRows\|collectRows\|getQueryApi" web/lib/influx.ts` must show only the three lines inside `queryRows`.

- [ ] **Step 4: Run the new test and the whole suite**

Run: `cd web && npx vitest run lib/influx.retry.test.ts`
Expected: PASS.

Run: `cd web && npm test && npx tsc --noEmit`
Expected: all vitest files pass (including the untouched `rollup.test.ts`, which imports `mergeEnergyRows` from `./influx`); `tsc` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add web/lib/influx.ts web/lib/influx.retry.test.ts
git commit -m "feat(web): retry influx queries once on connection reset"
```

(End the commit message with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.)

---

## Self-review notes

- Spec coverage: one retry (T1 wrapper + "gives up after one retry"), 250 ms (`RETRY_DELAY_MS` asserted), no retry on HTTP/auth/timeout/query errors (T1 predicate tests, T2 tests 3-4), pure tested decision (T1), all paths via the helper (T2 `it.each` over all seven public entry points plus the grep check; the eighth site, `queryPanelKwh`, is exercised through `queryEnergyByCategory`), no new deps.
- Types: `isConnectionResetError`, `withRetryOnce`, `RETRY_DELAY_MS`, `queryRows` are named identically everywhere.
- Auth failures surface as `HttpError` 401/403 (statusCode), covered by the `statusCode` guard. Cloudflare Access challenges also arrive as HTTP statuses, so they are not retried.
