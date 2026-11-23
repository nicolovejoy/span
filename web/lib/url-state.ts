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
  withCircuits,
  type OffSet,
} from "./selection";

export type DashState = {
  fromMs: number;
  toMs: number;
  interval: IntervalKey;
  intervalAuto: boolean;
  rangePreset: RangePreset | null;
  /** What is turned off, categories and circuits (see lib/selection). */
  off: OffSet;
  /** Categories whose circuit rows show in the side panel, in stack order.
   * Never in the URL: it is view state, not intent. */
  expanded: string[];
  /** Events layer (mode strip + list) visible. Default true; URL carries
   *  events=0 only when off. */
  events: boolean;
};

/**
 * Build the intent-only search string for the URL: the preset range, what is
 * turned off (`off` for categories, one `offc` per circuit) — never the
 * transient pan/zoom window. Commas in `off` are kept literal (URLSearchParams
 * would emit %2C) for a readable URL; circuit names are percent-encoded since
 * they contain `/`, `,` and spaces. Never emits the legacy `show` or `drill`
 * params (parseState still reads them).
 */
export function buildIntentSearch(
  range: RangePreset | null,
  off: OffSet,
  events: boolean = true,
): string {
  const parts: string[] = [];
  if (range) parts.push(`range=${range}`);
  const offStr = serializeOff(off);
  if (offStr) parts.push(`off=${offStr}`);
  for (const c of off.circuits) parts.push(`offc=${encodeURIComponent(c)}`);
  if (!events) parts.push("events=0");
  return parts.join("&");
}

const isRangePreset = (v: string): v is RangePreset => v in RANGE_PRESETS;
const isInterval = (v: string): v is IntervalKey =>
  (INTERVAL_ORDER as string[]).includes(v);

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

const all = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

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

/** A legacy `drill=` link only counts if it names a real category that is on
 *  under the current selection. */
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
  const base =
    params.off !== undefined
      ? parseOff(first(params.off))
      : offFromShow(parseList(first(params.show)));
  let off = withCircuits(base, all(params.offc));
  // Legacy `drill=X` links (pre-circuit-boxes): expand X's rows and narrow the
  // selection to it, as the old drill did, keeping any circuits that are off.
  const drill = parseDrill(first(params.drill), off);
  if (drill) off = withCircuits(onlyThese([drill]), off.circuits);
  return {
    fromMs: win.fromMs,
    toMs: win.toMs,
    rangePreset: win.rangePreset,
    interval: iv.interval,
    intervalAuto: iv.intervalAuto,
    off,
    expanded: drill ? [drill] : [],
    events: first(params.events) !== "0",
  };
}
