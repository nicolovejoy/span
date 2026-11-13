import {
  queryPower,
  queryEnergyByCategory,
  queryEvents,
  queryHvacModeIntervals,
  type Grouping,
  type SeriesPoint,
} from "./influx";
import { intervalSeconds, type IntervalKey } from "./interval";
import { energySourceForSpan, sourceForInterval, sourceKey } from "./rollup";
import { groupModeRuns, MODES_MAX_WINDOW_MS, type EventsPayload } from "./eventRuns";

export type { EnergyRow } from "./influx";
import type { EnergyRow } from "./influx";

// In-memory LRU keyed by (interval, quantized from, quantized to). Lives in
// the Node server module scope — survives across requests on the Pi (where
// the process is long-lived, not serverless). Past buckets are immutable so
// historical entries get a 24h TTL; trailing-bucket entries TTL out after
// one bucket so newly-arrived data shows up promptly.

type Entry = { data: SeriesPoint[]; expiresAt: number };

export const MAX_ENTRIES = 100;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<SeriesPoint[]>>();

/** "" for the category view, the category name for a drill — a drilled result
 *  is a completely different row shape and must never share an entry. */
const drillKey = (drill?: string): string => drill ?? "";

const groupingFor = (drill?: string): Grouping =>
  drill ? { kind: "circuit", category: drill } : { kind: "category" };

// The measurement is in the key so an entry can never be served from a
// different source than it was written with (the source is a pure function of
// the interval today, so this is belt-and-braces against a threshold change).
export function makeKey(
  interval: IntervalKey,
  fromMs: number,
  toMs: number,
  drill?: string,
): string {
  return `${interval}|${sourceKey(sourceForInterval(interval))}|${drillKey(drill)}|${fromMs}|${toMs}`;
}

export async function cachedQueryPower(opts: {
  fromMs: number;
  toMs: number;
  interval: IntervalKey;
  /** Category to break into its individual circuits (#12). */
  drill?: string;
}): Promise<SeriesPoint[]> {
  const key = makeKey(opts.interval, opts.fromMs, opts.toMs, opts.drill);
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    // LRU bump — re-insert so this entry moves to newest in Map iteration order.
    cache.delete(key);
    cache.set(key, hit);
    return hit.data;
  }

  // Coalesce concurrent identical requests.
  const pending = inflight.get(key);
  if (pending) return pending;

  const intervalMs = intervalSeconds(opts.interval) * 1000;
  const isTrailing = now - opts.toMs < 2 * intervalMs;
  const ttlMs = isTrailing ? Math.max(60_000, intervalMs) : 24 * 60 * 60 * 1000;

  const promise = queryPower({ ...opts, grouping: groupingFor(opts.drill) })
    .then((data) => {
      cache.set(key, { data, expiresAt: Date.now() + ttlMs });
      while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      inflight.delete(key);
      return data;
    })
    .catch((e) => {
      inflight.delete(key);
      throw e;
    });

  inflight.set(key, promise);
  return promise;
}

// Energy-by-category cache. Keyed by (from, to) only — energy is the integral
// over the whole window, independent of the display bucket, so switching the
// chart's interval must not invalidate the table.
// Source is derived from the span, which the key already pins — included
// explicitly so a stale entry can't outlive a threshold change.
export function makeEnergyKey(
  fromMs: number,
  toMs: number,
  drill?: string,
): string {
  return `${sourceKey(energySourceForSpan(toMs - fromMs))}|${drillKey(drill)}|${fromMs}|${toMs}`;
}

const energyCache = new Map<string, { data: EnergyRow[]; expiresAt: number }>();
const energyInflight = new Map<string, Promise<EnergyRow[]>>();

export async function cachedQueryEnergyByCategory(opts: {
  fromMs: number;
  toMs: number;
  /** Category to break into its individual circuits (#12). */
  drill?: string;
}): Promise<EnergyRow[]> {
  const key = makeEnergyKey(opts.fromMs, opts.toMs, opts.drill);
  const now = Date.now();

  const hit = energyCache.get(key);
  if (hit && hit.expiresAt > now) {
    energyCache.delete(key);
    energyCache.set(key, hit);
    return hit.data;
  }

  const pending = energyInflight.get(key);
  if (pending) return pending;

  // Trailing window (ends ~now) keeps changing as 30s data lands → short TTL;
  // historical is immutable → 24h.
  const isTrailing = now - opts.toMs < 2 * 60_000;
  const ttlMs = isTrailing ? 60_000 : 24 * 60 * 60 * 1000;

  const promise = queryEnergyByCategory({ ...opts, grouping: groupingFor(opts.drill) })
    .then((data) => {
      energyCache.set(key, { data, expiresAt: Date.now() + ttlMs });
      while (energyCache.size > MAX_ENTRIES) {
        const oldest = energyCache.keys().next().value;
        if (oldest === undefined) break;
        energyCache.delete(oldest);
      }
      energyInflight.delete(key);
      return data;
    })
    .catch((e) => {
      energyInflight.delete(key);
      throw e;
    });

  energyInflight.set(key, promise);
  return promise;
}

// Events cache — window-keyed like energy; independent of the display bucket.
export function makeEventsKey(fromMs: number, toMs: number): string {
  return `events|${fromMs}|${toMs}`;
}

const eventsCache = new Map<string, { data: EventsPayload; expiresAt: number }>();
const eventsInflight = new Map<string, Promise<EventsPayload>>();

export async function cachedQueryEvents(opts: {
  fromMs: number;
  toMs: number;
}): Promise<EventsPayload> {
  const key = makeEventsKey(opts.fromMs, opts.toMs);
  const now = Date.now();

  const hit = eventsCache.get(key);
  if (hit && hit.expiresAt > now) {
    eventsCache.delete(key);
    eventsCache.set(key, hit);
    return hit.data;
  }
  const pending = eventsInflight.get(key);
  if (pending) return pending;

  const isTrailing = now - opts.toMs < 2 * 60_000;
  const ttlMs = isTrailing ? 60_000 : 24 * 60 * 60 * 1000;
  const modesTruncated = opts.toMs - opts.fromMs > MODES_MAX_WINDOW_MS;

  const promise = Promise.all([
    modesTruncated ? Promise.resolve([]) : queryHvacModeIntervals(opts.fromMs, opts.toMs),
    queryEvents(opts.fromMs, opts.toMs),
  ])
    .then(([intervals, events]) => {
      const data: EventsPayload = { modes: groupModeRuns(intervals), events, modesTruncated };
      eventsCache.set(key, { data, expiresAt: Date.now() + ttlMs });
      while (eventsCache.size > MAX_ENTRIES) {
        const oldest = eventsCache.keys().next().value;
        if (oldest === undefined) break;
        eventsCache.delete(oldest);
      }
      eventsInflight.delete(key);
      return data;
    })
    .catch((e) => {
      eventsInflight.delete(key);
      throw e;
    });

  eventsInflight.set(key, promise);
  return promise;
}

