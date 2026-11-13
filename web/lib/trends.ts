// Period list for /trends: one bar per named Pacific calendar period (week,
// month, year), never a sliding window. Pure — builds on energyWindow's
// periodBounds so DST is handled in one place. Spec:
// docs/superpowers/specs/2026-10-26-trends-view-design.md

import { pacificMidnightUtc, pacificWall, periodBounds } from "./energyWindow";

export type TrendGrain = "week" | "month" | "year";

export const TREND_GRAINS: readonly TrendGrain[] = ["month", "week", "year"];

/** First Pacific day with collector data: raw `circuit` and `panel` both
 *  begin 2026-01-04T05:29Z (Jan 3, 9:29pm Pacific). */
export const DATA_START_MS = pacificMidnightUtc(2026, 1, 3);
/** First Pacific day of the hvac_mode timeline (heat/cool/hot-water split). */
export const HVAC_SPLIT_START_MS = pacificMidnightUtc(2026, 1, 4);

/** Bars shown for week/month grains. Years show every year since data start. */
export const TREND_WINDOW = 13;

export type TrendPeriod = {
  key: string;
  fromMs: number;
  toMs: number;
  /** The period's calendar end has passed. */
  complete: boolean;
  /** fromMs was clamped up to DATA_START_MS. */
  partialStart: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Pacific calendar key of the period starting at `fromMs`: month `YYYY-MM`,
 *  week = the Monday `YYYY-MM-DD`, year `YYYY`. */
export function periodKey(fromMs: number, grain: TrendGrain): string {
  const w = pacificWall(fromMs);
  switch (grain) {
    case "year":
      return String(w.y);
    case "month":
      return `${w.y}-${pad(w.m)}`;
    case "week":
      return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
  }
}

const KEY_RE: Record<TrendGrain, RegExp> = {
  year: /^(\d{4})$/,
  month: /^(\d{4})-(\d{2})$/,
  week: /^(\d{4})-(\d{2})-(\d{2})$/,
};

/** Full calendar bounds for a key, or null when the key is malformed, names a
 *  date that doesn't exist, or (week) isn't a Monday. */
export function parsePeriodKey(
  key: string,
  grain: TrendGrain,
): { fromMs: number; toMs: number } | null {
  const m = KEY_RE[grain].exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : 1;
  const d = m[3] ? Number(m[3]) : 1;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const start = pacificMidnightUtc(y, mo, d);
  const w = pacificWall(start);
  if (w.y !== y || w.m !== mo || w.d !== d) return null; // e.g. Feb 30
  const b = periodBounds(start, grain);
  return b.fromMs === start ? b : null; // week keys must be the Monday
}

const prevBounds = (b: { fromMs: number }, grain: TrendGrain) =>
  periodBounds(b.fromMs - 1, grain);

/** The calendar period containing the first day of data. */
export const firstDataBounds = (grain: TrendGrain) => periodBounds(DATA_START_MS, grain);

/** The anchor period: `endKey` if it parses, clamped between the first data
 *  period and the current one; otherwise the period containing now. */
function anchorBounds(endKey: string | null | undefined, grain: TrendGrain, nowMs: number) {
  const current = periodBounds(nowMs, grain);
  const parsed = endKey ? parsePeriodKey(endKey, grain) : null;
  if (!parsed || parsed.fromMs >= current.fromMs) return current;
  return parsed.toMs <= DATA_START_MS ? firstDataBounds(grain) : parsed;
}

/** Hours after a period ends before its numbers are trusted as final: the
 *  hvac_mode classifier can lag ~75 min and self-heals nightly at 02:00. */
const SETTLE_MS = 3 * 3600_000;

/** Safe to cache long: the period ended at least SETTLE_MS ago. */
export function isSettled(p: TrendPeriod, nowMs: number): boolean {
  return p.complete && nowMs - p.toMs >= SETTLE_MS;
}

/** Bars oldest first. Week/month: up to 13 ending at the anchor. Year: every
 *  year since data start (endKey ignored). Periods wholly before data start
 *  are dropped; the first is clamped to DATA_START_MS, the last to now. */
export function trendPeriods(opts: {
  grain: TrendGrain;
  endKey?: string | null;
  nowMs: number;
}): TrendPeriod[] {
  const { grain, nowMs } = opts;
  const limit = grain === "year" ? Infinity : TREND_WINDOW;
  const out: TrendPeriod[] = [];
  let b = grain === "year" ? periodBounds(nowMs, grain) : anchorBounds(opts.endKey, grain, nowMs);
  while (out.length < limit && b.toMs > DATA_START_MS) {
    out.push({
      key: periodKey(b.fromMs, grain),
      fromMs: Math.max(b.fromMs, DATA_START_MS),
      toMs: Math.min(b.toMs, nowMs),
      complete: b.toMs <= nowMs,
      partialStart: b.fromMs < DATA_START_MS,
    });
    b = prevBounds(b, grain);
  }
  return out.reverse();
}

/** Move an anchor key by `periods` (negative = back), never past the current
 *  period nor before the first data period. For the prev/next arrows. */
export function shiftEndKey(
  endKey: string,
  grain: TrendGrain,
  periods: number,
  nowMs: number,
): string {
  const current = periodBounds(nowMs, grain);
  const first = firstDataBounds(grain);
  let b = anchorBounds(endKey, grain, nowMs);
  for (let i = 0; i < Math.abs(periods); i++) {
    b = periods < 0 ? prevBounds(b, grain) : periodBounds(b.toMs, grain);
    if (b.fromMs >= current.fromMs) return periodKey(current.fromMs, grain);
    if (b.fromMs <= first.fromMs) return periodKey(first.fromMs, grain);
  }
  return periodKey(b.fromMs, grain);
}
