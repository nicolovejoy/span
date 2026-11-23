// The explorer chart draws on a Pacific wall-clock: each real-UTC instant is
// shifted by that instant's Pacific offset and handed to lightweight-charts as
// if it were UTC, so the library's axis labels read as Seattle local time.
// All navigation / fetch / URL math stays in true UTC; only values crossing
// the chart boundary go through these helpers.
import type { UTCTimestamp } from "lightweight-charts";

const DISPLAY_TZ = "America/Los_Angeles";

const dtf = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// Seconds to add to a real-UTC instant so it reads as Pacific wall-clock.
// Computed per-instant so DST flips across a wide range stay correct
// (e.g. -8h in winter, -7h in summer). Negative west of UTC.
export function tzOffsetSec(utcMs: number): number {
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return Math.round((asUtc - utcMs) / 1000);
}

// real UTC second -> chart "display" second (Pacific wall-clock as fake-UTC).
export function toDisplay(realSec: number): UTCTimestamp {
  return (realSec + tzOffsetSec(realSec * 1000)) as UTCTimestamp;
}

// chart "display" second -> real UTC second. One refine pass nails the DST edge.
export function fromDisplay(dispSec: number): number {
  let real = dispSec - tzOffsetSec(dispSec * 1000);
  real = dispSec - tzOffsetSec(real * 1000);
  return real;
}

/** Shift series entries (ascending in real time) onto the display clock,
 *  keeping the result strictly ascending, which lightweight-charts requires.
 *
 *  On the fall-back night the display clock runs an hour backwards: real
 *  08:00Z-09:00Z reads 01:00-02:00 PDT and 09:00Z-10:00Z reads 01:00-02:00 PST
 *  again. A non-ascending time makes the library's render loop throw "Value is
 *  null" (its production build does not validate in setData), which blanks the
 *  chart for any loaded window that contains that hour. The repeated hour's
 *  second pass cannot share the axis, so its points are dropped; the first
 *  pass stays. Whitespace entries ({ time } only) carry through without a value. */
export function toChartTimes<T extends { time: number }>(entries: readonly T[]): T[] {
  const out: T[] = [];
  let last = -Infinity;
  for (const e of entries) {
    const time = toDisplay(Number(e.time));
    if (!(time > last)) continue;
    last = time;
    out.push({ ...e, time });
  }
  return out;
}

/** True when every entry has a finite, strictly ascending time and every
 *  value that is present is finite. lightweight-charts' production build does
 *  not check this in setData, and bad input only blows up later in its render
 *  loop, so the chart checks before handing data over. */
export function isChartSeriesSafe(entries: readonly { time: number; value?: number }[]): boolean {
  let last = -Infinity;
  for (const e of entries) {
    if (!Number.isFinite(e.time) || !(e.time > last)) return false;
    if ("value" in e && !Number.isFinite(e.value)) return false;
    last = e.time;
  }
  return true;
}
