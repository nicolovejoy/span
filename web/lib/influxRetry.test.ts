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
