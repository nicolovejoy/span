// Server-side energy for one /trends period. A period straddling the
// hvac_mode start is queried in two halves so the pre-split HVAC lands in
// "HVAC (not split)" and the rest in the split layers.

import { queryBathKwh, queryHvacModeFieldSums } from "./influx";
import { cachedQueryEnergyByCategory, MAX_ENTRIES } from "./queryCache";
import { HVAC_SPLIT_START_MS, isSettled, type TrendPeriod } from "./trends";
import { combinePeriodEnergy, type PeriodEnergy } from "./trendLayers";

export async function queryPeriodEnergy(p: { fromMs: number; toMs: number }): Promise<PeriodEnergy> {
  const cut = Math.min(Math.max(HVAC_SPLIT_START_MS, p.fromMs), p.toMs);
  const hasPre = cut > p.fromMs;
  const hasPost = p.toMs > cut;
  const [pre, post, modeSums, bathKwh] = await Promise.all([
    hasPre ? cachedQueryEnergyByCategory({ fromMs: p.fromMs, toMs: cut }) : null,
    hasPost ? cachedQueryEnergyByCategory({ fromMs: cut, toMs: p.toMs }) : null,
    hasPost ? queryHvacModeFieldSums(cut, p.toMs) : {},
    hasPost ? queryBathKwh(cut, p.toMs) : 0,
  ]);
  return combinePeriodEnergy({ pre, post, modeSums, bathKwh });
}

// Trend-period cache (/trends). A settled period (ended 3h+ ago) never
// changes → 24h; in progress or just ended → 60s. Keyed by the clamped bounds.
const trendCache = new Map<string, { data: PeriodEnergy; expiresAt: number }>();
const trendInflight = new Map<string, Promise<PeriodEnergy>>();

export async function cachedQueryTrendPeriod(p: TrendPeriod): Promise<PeriodEnergy> {
  const key = `trend|${p.fromMs}|${p.toMs}`;
  const now = Date.now();
  const hit = trendCache.get(key);
  if (hit && hit.expiresAt > now) {
    trendCache.delete(key);
    trendCache.set(key, hit);
    return hit.data;
  }
  const pending = trendInflight.get(key);
  if (pending) return pending;

  const ttlMs = isSettled(p, now) ? 24 * 60 * 60 * 1000 : 60_000;
  const promise = queryPeriodEnergy(p)
    .then((data) => {
      trendCache.set(key, { data, expiresAt: Date.now() + ttlMs });
      while (trendCache.size > MAX_ENTRIES) {
        const oldest = trendCache.keys().next().value;
        if (oldest === undefined) break;
        trendCache.delete(oldest);
      }
      trendInflight.delete(key);
      return data;
    })
    .catch((e) => {
      trendInflight.delete(key);
      throw e;
    });
  trendInflight.set(key, promise);
  return promise;
}
