// Intent URL for /trends: `?grain=week&end=2026-10-19&sel=2026-10-12`.
// grain defaults to month (omitted); end = anchor period (omitted = current);
// sel = selected bar. These are the URLs email deep links will target, so a
// hand-typed or years-old link must always parse to something sensible.

import { periodBounds } from "./energyWindow";
import {
  DATA_START_MS,
  TREND_GRAINS,
  firstDataBounds,
  parsePeriodKey,
  periodKey,
  trendPeriods,
  type TrendGrain,
} from "./trends";

export type TrendsState = { grain: TrendGrain; endKey: string | null; selKey: string | null };

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export function parseTrendsState(params: Params, nowMs: number): TrendsState {
  const g = first(params.grain);
  const grain: TrendGrain = TREND_GRAINS.includes(g as TrendGrain) ? (g as TrendGrain) : "month";
  const current = periodBounds(nowMs, grain);

  // end: only a real, strictly-past period is kept; years ignore it.
  const rawEnd = first(params.end);
  const end = rawEnd && grain !== "year" ? parsePeriodKey(rawEnd, grain) : null;
  let endKey = end && end.fromMs < current.fromMs ? rawEnd : null;
  if (end && endKey && end.toMs <= DATA_START_MS) {
    // Before any data: anchor at the first data period instead.
    const first = firstDataBounds(grain);
    endKey = first.fromMs < current.fromMs ? periodKey(first.fromMs, grain) : null;
  }

  const rawSel = first(params.sel);
  const sel = rawSel ? parsePeriodKey(rawSel, grain) : null;
  let selKey: string | null = null;
  if (rawSel && sel && sel.toMs > DATA_START_MS && sel.fromMs <= current.fromMs) {
    const inWindow = trendPeriods({ grain, endKey, nowMs }).some((p) => p.key === rawSel);
    if (inWindow) selKey = rawSel;
    else if (endKey === null && grain !== "year") {
      // Older than the default window: anchor the window at it.
      endKey = rawSel;
      selKey = rawSel;
    }
  }
  return { grain, endKey, selKey };
}

export function buildTrendsSearch(s: TrendsState): string {
  const q = new URLSearchParams();
  if (s.grain !== "month") q.set("grain", s.grain);
  if (s.endKey) q.set("end", s.endKey);
  if (s.selKey) q.set("sel", s.selKey);
  return q.toString();
}
