// Pure helpers for /api/power's request and response headers.

/** `grid=0` opts a request out of the panel (whole-house grid power) query, and
 *  with it the Unmonitored series. Anything else keeps the default (on). */
export function wantsGrid(param: string | null): boolean {
  return param !== "0";
}

/** Trailing-bucket queries (to ≈ now) change as time passes, so cap them at one
 *  bucket; historical ones are immutable. A partial response (a panel query
 *  failed, so the Unmonitored series is missing) is a transient failure and
 *  must never be stored by the browser or a CDN. */
export function powerCacheControl(opts: {
  partial: boolean;
  toMs: number;
  intervalMs: number;
  nowMs: number;
}): string {
  if (opts.partial) return "no-store";
  const isTrailing = opts.nowMs - opts.toMs < 2 * opts.intervalMs;
  const maxAge = isTrailing ? Math.max(60, Math.floor(opts.intervalMs / 1000)) : 86400;
  return `public, max-age=${maxAge}, stale-while-revalidate=3600`;
}
