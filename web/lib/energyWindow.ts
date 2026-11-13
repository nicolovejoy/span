// Calendar-period snapping for the breakdown table. The table no longer
// describes the chart's arbitrary zoom window — every column (kWh, Δ, Cost,
// Share, base charge) describes the Pacific calendar period (day/week/month/
// year) the viewed window is closest to, compared against the prior period.
// Pure functions so the range math and row-merging are unit-testable without
// touching Influx.

import type { EnergyRow } from "./influx";

const TZ = "America/Los_Angeles";

export type ComparisonGrain = "day" | "week" | "month" | "year";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar grain nearest the viewed window length — what "the period you're
 *  looking at" rounds to in human terms. */
export function comparisonGrain(windowMs: number): ComparisonGrain {
  if (windowMs <= 2 * DAY_MS) return "day";
  if (windowMs <= 14 * DAY_MS) return "week";
  if (windowMs <= 62 * DAY_MS) return "month";
  return "year";
}

const wallParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  weekday: "short",
  hour12: false,
});

/** Pacific wall-clock at `ms`, as calendar fields plus Monday-based weekday. */
export function pacificWall(ms: number) {
  const p: Record<string, string> = {};
  for (const { type, value } of wallParts.formatToParts(ms)) p[type] = value;
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    // "24" appears for midnight under hourCycle h24 quirks; normalize.
    h: Number(p.hour) % 24,
    min: Number(p.minute),
    s: Number(p.second),
    dow: weekdays.indexOf(p.weekday), // 0 = Monday
  };
}

/** UTC ms of Pacific midnight on calendar date (y, m, d). m is 1-based; d may
 *  be out of range (0, -3, 32…) — Date.UTC rolls it over, which is how the
 *  callers step to "yesterday" / "1st of last month" without date libraries. */
export function pacificMidnightUtc(y: number, m: number, d: number): number {
  const target = Date.UTC(y, m - 1, d);
  // Guess UTC midnight, then correct by the zone offset observed at the guess;
  // twice, to converge when the correction crosses a DST transition.
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const w = pacificWall(ts);
    ts += target - Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  }
  return ts;
}

/** [fromMs, toMs) of the calendar period of `grain` containing `anchorMs`,
 *  Pacific calendar. `toMs` is the start of the *next* period (exclusive) —
 *  the full period regardless of where `anchorMs` (or "now") falls inside it. */
export function periodBounds(
  anchorMs: number,
  grain: ComparisonGrain,
): { fromMs: number; toMs: number } {
  const w = pacificWall(anchorMs);
  switch (grain) {
    case "day":
      return {
        fromMs: pacificMidnightUtc(w.y, w.m, w.d),
        toMs: pacificMidnightUtc(w.y, w.m, w.d + 1),
      };
    case "week":
      return {
        fromMs: pacificMidnightUtc(w.y, w.m, w.d - w.dow),
        toMs: pacificMidnightUtc(w.y, w.m, w.d - w.dow + 7),
      };
    case "month":
      return {
        fromMs: pacificMidnightUtc(w.y, w.m, 1),
        toMs: pacificMidnightUtc(w.y, w.m + 1, 1),
      };
    case "year":
      return {
        fromMs: pacificMidnightUtc(w.y, 1, 1),
        toMs: pacificMidnightUtc(w.y + 1, 1, 1),
      };
  }
}

/**
 * Snap a viewed-window endpoint to the calendar period (Pacific) it's closest
 * to, for the breakdown table's every column. `anchorMs` is the raw viewed
 * `toMs` — this function does the "-1, clamped to now" adjustment internally
 * (a future-dated window snaps to the period containing now; an anchor sitting
 * exactly on a period boundary lands in the period that just finished, not an
 * empty new one — see docs/superpowers/specs for the design writeup).
 *
 * A **complete** period (its calendar end has already passed) compares full
 * period to full prior period — full March vs full February, no clamping. A
 * **partial** period (contains "now") compares period-start-to-now against
 * the same elapsed span of the prior period, clamped to that period's own end
 * so a 30-day March-to-date never reads February plus a bit of March.
 */
export function snapPeriod(
  anchorMs: number,
  grain: ComparisonGrain,
  nowMs: number,
): {
  fromMs: number;
  toMs: number;
  complete: boolean;
  previous: { fromMs: number; toMs: number };
} {
  const effectiveAnchor = Math.min(anchorMs, nowMs) - 1;
  const cur = periodBounds(effectiveAnchor, grain);
  const prev = periodBounds(cur.fromMs - 1, grain);
  const complete = cur.toMs <= nowMs;
  if (complete) {
    return { fromMs: cur.fromMs, toMs: cur.toMs, complete: true, previous: prev };
  }
  const elapsed = nowMs - cur.fromMs;
  return {
    fromMs: cur.fromMs,
    toMs: nowMs,
    complete: false,
    previous: { fromMs: prev.fromMs, toMs: Math.min(prev.fromMs + elapsed, prev.toMs) },
  };
}

/** Start of the calendar period immediately before the one starting at
 *  `periodFromMs` — pure calendar arithmetic, no "now" involved. Lets the
 *  table label the comparison column from stamped data alone rather than
 *  re-snapping client-side with its own Date.now(). */
export function previousPeriodStart(periodFromMs: number, grain: ComparisonGrain): number {
  return periodBounds(periodFromMs - 1, grain).fromMs;
}

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
const monthDayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  month: "short",
  day: "numeric",
});
const monthYearFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  month: "short",
  year: "numeric",
});
const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short" });
const yearFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" });

/** "Tue Jun 16" — composed from two formatters (rather than one weekday+month+
 *  day formatter) because en-US's combined form inserts a comma ("Tue, Jun
 *  16") that the table header doesn't want. */
const dayLabel = (ms: number) => `${weekdayFmt.format(ms)} ${monthDayFmt.format(ms)}`;

/** Human label for the snapped period's start, for the kWh column header:
 *  "Tue Jun 16" (day), "Week of Aug 24" (week), "Aug 2026" (month), "2026"
 *  (year). Pacific names via Intl.DateTimeFormat — never toISOString/getMonth
 *  on a bare Date. */
export function periodLabel(fromMs: number, grain: ComparisonGrain): string {
  switch (grain) {
    case "day":
      return dayLabel(fromMs);
    case "week":
      return `Week of ${monthDayFmt.format(fromMs)}`;
    case "month":
      return monthYearFmt.format(fromMs);
    case "year":
      return yearFmt.format(fromMs);
  }
}

/** Human label for the prior period, for the Δ column header: "vs Mon Jun
 *  15" (day), "vs week of Aug 17" (week), "vs Jul" (month), "vs 2025" (year). */
export function prevPeriodLabel(prevFromMs: number, grain: ComparisonGrain): string {
  switch (grain) {
    case "day":
      return `vs ${dayLabel(prevFromMs)}`;
    case "week":
      return `vs week of ${monthDayFmt.format(prevFromMs)}`;
    case "month":
      return `vs ${monthFmt.format(prevFromMs)}`;
    case "year":
      return `vs ${yearFmt.format(prevFromMs)}`;
  }
}

/**
 * Panel total minus circuit total — the energy the panel meters but no named
 * circuit does (the Square D overflow subpanel, plus any metering slop; see
 * #17). Floored at zero: circuit-level counter totals can occasionally exceed
 * a noisy panel integral over a short window, and a negative "unmonitored"
 * number is never meaningful. Mirrors pi/daily_report.py's
 * unmonitored_week_kwh so the email and the dashboard agree on the method.
 */
export function unmonitoredKwh(panelKwh: number, circuitKwh: number): number {
  return Math.max(0, panelKwh - circuitKwh);
}

/**
 * Combine the snapped current period's rows with the prior period's rows
 * (see snapPeriod) plus the snap metadata (needed downstream for headers and
 * to prorate the base charge). `current` rows' `kwh` IS the period energy —
 * the caller queries the snapped range directly. Additive to EnergyRow —
 * categories present in the current period but absent from the prior one get
 * 0 (true "was zero", not "unknown"); categories that vanished are dropped,
 * same as today's behavior.
 */
export function buildEnergyRows(
  current: EnergyRow[],
  prevPeriod: EnergyRow[],
  meta: {
    periodFromMs: number;
    periodToMs: number;
    periodGrain: ComparisonGrain;
    periodComplete: boolean;
  },
): EnergyRow[] {
  const prevByCategory = new Map(prevPeriod.map((r) => [r.category, r.kwh]));
  return current.map((r) => ({
    ...r,
    prevPeriodKwh: prevByCategory.get(r.category) ?? 0,
    periodFromMs: meta.periodFromMs,
    periodToMs: meta.periodToMs,
    periodGrain: meta.periodGrain,
    periodComplete: meta.periodComplete,
  }));
}

/**
 * Splice a drilled category's circuit rows in directly after that category's
 * row, so the table can render them as indented children of the subtotal (#12).
 * Circuits are ordered by name — the same stable order the chart assigns shades
 * in, so a row's color and its legend entry always agree.
 *
 * A no-op when the category isn't in `rows` (e.g. filtered out, or no data),
 * which is what makes it safe to call unconditionally.
 */
export function mergeDrillRows(
  rows: EnergyRow[],
  circuitRows: EnergyRow[],
  drill: string | null,
): EnergyRow[] {
  if (!drill || circuitRows.length === 0) return rows;
  const children = [...circuitRows].sort((a, b) =>
    a.category.localeCompare(b.category),
  );
  return rows.flatMap((r) =>
    r.category === drill && !r.parent ? [r, ...children] : [r],
  );
}

/** Display labels for the hvac_mode energy fields shown as HVAC sub-rows.
 *  idle/ambiguous are deliberately absent: they stay inside the HVAC parent's
 *  remainder rather than rendering as noise rows. */
const HVAC_MODE_LABELS: Record<string, string> = {
  energy_heat_kwh: "Heating",
  energy_cool_kwh: "Cooling",
  energy_hot_water_kwh: "Hot Water",
};

/** Threshold below which a mode row is noise, not information. */
const HVAC_MODE_MIN_KWH = 0.05;

/** Per-field kWh sums from the hvac_mode measurement → nested EnergyRows.
 *  Order is fixed (heat, cool, hot water) so the table is stable across
 *  windows regardless of magnitude. */
export function hvacModeRowsFromFieldSums(
  sums: Record<string, number>,
): EnergyRow[] {
  return Object.entries(HVAC_MODE_LABELS).flatMap(([field, label]) => {
    const kwh = sums[field] ?? 0;
    return kwh > HVAC_MODE_MIN_KWH ? [{ category: label, kwh, parent: "HVAC" }] : [];
  });
}

/** Move rows tagged `parent` to directly after their parent row, preserving
 *  their relative order. Children with no parent row present are dropped —
 *  same safety stance as mergeDrillRows. */
export function spliceChildRows(rows: EnergyRow[], parent: string): EnergyRow[] {
  const children = rows.filter((r) => r.parent === parent);
  const rest = rows.filter((r) => r.parent !== parent);
  if (children.length === 0) return rows;
  if (!rest.some((r) => r.category === parent && !r.parent)) return rest;
  return rest.flatMap((r) =>
    r.category === parent && !r.parent ? [r, ...children] : [r],
  );
}

export type Delta =
  | { kind: "delta"; kwh: number; percent?: number }
  | { kind: "none" };

// Below this many kWh a period is treated as "effectively zero".
const NEGLIGIBLE_KWH = 0.05;
// A percent needs a base at least this big to be honest — off a smaller base
// it screams (+137% on 1.3 kWh) while meaning almost nothing.
const PERCENT_MIN_BASE_KWH = 1;

/** Absolute-first delta between the current and prior calendar periods, with
 *  a percent only when the prior period is big enough to make one honest. */
export function computeDelta(
  periodKwh: number | undefined,
  prevPeriodKwh: number | undefined,
): Delta {
  if (periodKwh === undefined || prevPeriodKwh === undefined) {
    return { kind: "none" };
  }
  if (periodKwh <= NEGLIGIBLE_KWH && prevPeriodKwh <= NEGLIGIBLE_KWH) {
    return { kind: "none" };
  }
  const kwh = periodKwh - prevPeriodKwh;
  if (prevPeriodKwh >= PERCENT_MIN_BASE_KWH) {
    return { kind: "delta", kwh, percent: (kwh / prevPeriodKwh) * 100 };
  }
  return { kind: "delta", kwh };
}
