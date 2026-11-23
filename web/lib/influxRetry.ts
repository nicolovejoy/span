// One retry on a dropped connection. Vercel->Influx connections were reset for
// about a minute on 2026-11-23 and the explorer SSR 500'd; a single short retry
// absorbs a blip without masking real failures.

export const RETRY_DELAY_MS = 250;

const MAX_CAUSE_DEPTH = 5;
const NEVER_RETRY_NAMES = new Set(["HttpError", "RequestTimedOutError", "AbortError"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * True only for a dropped connection: ECONNRESET anywhere in the `cause` chain,
 * or Node's "socket hang up" message. Anything carrying an HTTP status, a
 * timeout or an abort is never retried (checked on the top-level error only).
 */
export function isConnectionResetError(err: unknown): boolean {
  if (!isObject(err)) return false;
  if (typeof err.statusCode === "number") return false;
  if (typeof err.name === "string" && NEVER_RETRY_NAMES.has(err.name)) return false;

  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isObject(cur); depth++) {
    if (cur.code === "ECONNRESET") return true;
    if (typeof cur.message === "string" && /socket hang up/i.test(cur.message)) return true;
    cur = cur.cause;
  }
  return false;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetryOnce<T>(
  fn: () => Promise<T>,
  opts?: { delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isConnectionResetError(e)) throw e;
    console.warn("influx: connection reset, retrying once");
    await (opts?.sleep ?? defaultSleep)(opts?.delayMs ?? RETRY_DELAY_MS);
    return fn();
  }
}
