import {
  RANGE_PRESETS,
  type RangePreset,
  type IntervalKey,
  INTERVAL_ORDER,
  autoInterval,
  intervalSeconds,
  isIntervalAllowed,
} from "./interval";
import { isCategory } from "./categories";
import {
  isOn,
  offFromShow,
  onlyThese,
  parseOff,
  serializeOff,
  type OffSet,
} from "./selection";

export type DashState = {
  fromMs: number;
  toMs: number;
  interval: IntervalKey;
  intervalAuto: boolean;
  rangePreset: RangePreset | null;
  /** What is turned off (see lib/selection). Client-side only; never affects
   * Influx queries. */
  off: OffSet;
  /** Category expanded into its member circuits, or null. At most one at a
   * time (#12). Unlike `off` this *does* drive a query. */
  drill: string | null;
  /** Events layer (mode strip + list) visible. Default true; URL carries
   *  events=0 only when off. */
  events: boolean;
};

/**
 * Build the intent-only search string for the URL: the preset range, what is
 * turned off, and the drilled category — never the transient pan/zoom window.
 * Commas in `off` are kept literal (URLSearchParams would emit %2C) for a
 * readable URL. Never emits the legacy `show` param (parseState still reads it).
 */
export function buildIntentSearch(
  range: RangePreset | null,
  off: OffSet,
  drill: string | null = null,
  events: boolean = true,
): string {
  const parts: string[] = [];
  if (range) parts.push(`range=${range}`);
  const offStr = serializeOff(off);
  if (offStr) parts.push(`off=${offStr}`);
  if (drill) parts.push(`drill=${drill}`);
  if (!events) parts.push("events=0");
  return parts.join("&");
}

const isRangePreset = (v: string): v is RangePreset => v in RANGE_PRESETS;
const isInterval = (v: string): v is IntervalKey =>
  (INTERVAL_ORDER as string[]).includes(v);

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

function parseWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  range: string | undefined,
  now: number,
): { fromMs: number; toMs: number; rangePreset: RangePreset | null } {
  if (fromRaw && toRaw) {
    return { fromMs: Number(fromRaw), toMs: Number(toRaw), rangePreset: null };
  }
  const preset: RangePreset = range && isRangePreset(range) ? range : "24h";
  return { fromMs: now - RANGE_PRESETS[preset], toMs: now, rangePreset: preset };
}

function parseInterval(
  raw: string | undefined,
  fromMs: number,
  toMs: number,
): { interval: IntervalKey; intervalAuto: boolean } {
  const spanSec = Math.max(1, (toMs - fromMs) / 1000);
  if (
    raw &&
    isInterval(raw) &&
    intervalSeconds(raw) < spanSec &&
    isIntervalAllowed(raw, fromMs, toMs)
  ) {
    return { interval: raw, intervalAuto: false };
  }
  return { interval: autoInterval(fromMs, toMs), intervalAuto: true };
}

const parseList = (raw: string | undefined): string[] =>
  raw ? raw.split(",").filter(Boolean) : [];

/** A drill only survives a reload if it names a real category and that category
 *  is actually on under the current selection — otherwise the chart would
 *  drill into a hidden line. */
export function parseDrill(
  raw: string | undefined,
  off: OffSet,
): string | null {
  if (!raw || !isCategory(raw)) return null;
  if (!isOn(off, raw)) return null;
  return raw;
}

export function parseState(
  params: Record<string, string | string[] | undefined>,
): DashState {
  const now = Date.now();
  const win = parseWindow(
    first(params.from),
    first(params.to),
    first(params.range),
    now,
  );
  const iv = parseInterval(first(params.interval), win.fromMs, win.toMs);
  // `off=` is the current form; `show=` (what is ON) is what email deep links
  // from pi/email_kit.py still send. `off` wins if both are present.
  const off =
    params.off !== undefined
      ? parseOff(first(params.off))
      : offFromShow(parseList(first(params.show)));
  const drill = parseDrill(first(params.drill), off);
  return {
    fromMs: win.fromMs,
    toMs: win.toMs,
    rangePreset: win.rangePreset,
    interval: iv.interval,
    intervalAuto: iv.intervalAuto,
    // A drill focuses the selection on the drilled category (ExplorerClient's
    // reducer does the same on click) so a small family of circuits gets the
    // price scale to itself. The URL therefore always carries the *narrowed*
    // `off` — it describes what's on screen, not what it was before the drill.
    // The pre-drill selection is reducer-only state and doesn't survive a
    // reload, so backing out of a drill you arrived at by URL leaves `off`
    // narrowed.
    off: drill ? onlyThese([drill]) : off,
    drill,
    events: first(params.events) !== "0",
  };
}
