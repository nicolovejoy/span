// Browser-side data layer for the explorer. Module-scope TtlLru singletons sit
// in front of /api/power and /api/energy so going back-and-forth between
// already-visited windows is a 0-network cache hit. (The server LRU + HTTP
// cache remain the cold-miss backstop.) The cache survives client re-renders;
// it's lost on a full page reload — persisting it is issue #10's IndexedDB step.

import { TtlLru, cacheTtlMs } from "./clientCache";
import { intervalSeconds, type IntervalKey } from "./interval";
import type { SeriesPoint } from "./influx";
import type { EnergyRow } from "./queryCache";
import type { EventsPayload } from "./eventRuns";

const MAX_ENTRIES = 60;

const powerCache = new TtlLru<SeriesPoint[]>(MAX_ENTRIES);
const powerInflight = new Map<string, Promise<SeriesPoint[]>>();

const energyCache = new TtlLru<EnergyRow[]>(MAX_ENTRIES);
const energyInflight = new Map<string, Promise<EnergyRow[]>>();

// Drilled and un-drilled responses are different row shapes for the same
// window, so the drill is part of the key — a category entry must never be
// served to a drilled request or vice versa. Exported for unit tests.
const drillKey = (drill?: string): string => drill ?? "";

export const seriesCacheKey = (
  fromMs: number,
  toMs: number,
  interval: IntervalKey,
  drill?: string,
): string => `${interval}|${drillKey(drill)}|${fromMs}|${toMs}`;

export const energyCacheKey = (
  fromMs: number,
  toMs: number,
  drill?: string,
): string => `${drillKey(drill)}|${fromMs}|${toMs}`;

/** Bumped when /api/power's payload changes shape, so a browser HTTP-cached
 *  response from before (max-age is a day for past windows) is never served.
 *  u1: the category view carries an "Unmonitored" series. */
const POWER_SHAPE = "u1";

export async function fetchSeriesCached(
  fromMs: number,
  toMs: number,
  interval: IntervalKey,
  drill?: string,
): Promise<SeriesPoint[]> {
  const key = seriesCacheKey(fromMs, toMs, interval, drill);
  const hit = powerCache.get(key, Date.now());
  if (hit) return hit;

  const inflight = powerInflight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const url = new URL("/api/power", location.origin);
    url.searchParams.set("from", String(fromMs));
    url.searchParams.set("to", String(toMs));
    url.searchParams.set("interval", interval);
    url.searchParams.set("shape", POWER_SHAPE);
    if (drill) url.searchParams.set("drill", drill);
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = (await r.json()) as { data?: SeriesPoint[] };
    const data = json.data ?? [];
    const ttl = cacheTtlMs(toMs, intervalSeconds(interval) * 1000, Date.now());
    powerCache.set(key, data, Date.now() + ttl);
    return data;
  })();

  powerInflight.set(key, p);
  try {
    return await p;
  } finally {
    powerInflight.delete(key);
  }
}

export async function fetchEnergyCached(
  fromMs: number,
  toMs: number,
  drill?: string,
): Promise<EnergyRow[]> {
  const key = energyCacheKey(fromMs, toMs, drill);
  const hit = energyCache.get(key, Date.now());
  if (hit) return hit;

  const inflight = energyInflight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const url = new URL("/api/energy", location.origin);
    url.searchParams.set("from", String(fromMs));
    url.searchParams.set("to", String(toMs));
    if (drill) url.searchParams.set("drill", drill);
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = (await r.json()) as { data?: EnergyRow[] };
    const data = json.data ?? [];
    // Energy is window-only; reuse the trailing/historical TTL split with a
    // nominal 1-minute bucket (the live window changes as 30s data lands).
    const ttl = cacheTtlMs(toMs, 60_000, Date.now());
    energyCache.set(key, data, Date.now() + ttl);
    return data;
  })();

  energyInflight.set(key, p);
  try {
    return await p;
  } finally {
    energyInflight.delete(key);
  }
}

/** Seed the energy cache with server-rendered initial rows so the first paint's
 *  table needs no client round-trip. */
export function seedEnergy(fromMs: number, toMs: number, rows: EnergyRow[]): void {
  const key = energyCacheKey(fromMs, toMs);
  const ttl = cacheTtlMs(toMs, 60_000, Date.now());
  energyCache.set(key, rows, Date.now() + ttl);
}

const eventsCache = new TtlLru<EventsPayload>(MAX_ENTRIES);
const eventsInflight = new Map<string, Promise<EventsPayload>>();

export const eventsCacheKey = (fromMs: number, toMs: number): string =>
  `events|${fromMs}|${toMs}`;

export async function fetchEventsCached(
  fromMs: number,
  toMs: number,
): Promise<EventsPayload> {
  const key = eventsCacheKey(fromMs, toMs);
  const hit = eventsCache.get(key, Date.now());
  if (hit) return hit;
  const inflight = eventsInflight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const url = new URL("/api/events", location.origin);
    url.searchParams.set("from", String(fromMs));
    url.searchParams.set("to", String(toMs));
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as EventsPayload;
    const ttl = cacheTtlMs(toMs, 60_000, Date.now());
    eventsCache.set(key, data, Date.now() + ttl);
    return data;
  })();

  eventsInflight.set(key, p);
  try {
    return await p;
  } finally {
    eventsInflight.delete(key);
  }
}
