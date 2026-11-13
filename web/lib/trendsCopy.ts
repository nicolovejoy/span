// Reader-facing strings for /trends (shared convention: copy lives here, not
// inline in components).

import type { LayerKey } from "./trendLayers";
import type { TrendGrain, TrendPeriod } from "./trends";

const TZ = "America/Los_Angeles";
const monthYear = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", year: "numeric" });
const monthDay = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
const dayOnly = new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "numeric" });
const yearOnly = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" });
const monthOnly = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short" });

export const LAYER_LABELS: Record<LayerKey, string> = {
  hvacUnsplit: "HVAC (not split)",
  heat: "Heating",
  cool: "Cooling",
  hotWater: "Hot water",
  hvacOther: "HVAC standby + unclassified",
  car: "Car charging",
  lights: "Lights",
  appliances: "Appliances",
  rest: "Other + unmonitored",
};

/** "Where it went" panel rows — finer than the stack layers. */
export const PANEL_LABELS = {
  hvacUnsplit: "HVAC (not split)",
  heat: "Heating",
  cool: "Cooling",
  hotWater: "Hot water",
  unclassified: "Unclassified HVAC",
  standby: "HVAC standby",
  car: "Car charging",
  lights: "Lights",
  appliances: "Appliances",
  other: "Other circuits",
  unmonitored: "Unmonitored",
  baseCharge: "Base charge",
} as const;

export const COPY = {
  title: "SPAN — trends",
  explorerLink: "Explorer",
  trendsLink: "Trends",
  whereItWent: "Where it went",
  openInExplorer: "Open in explorer →",
  grains: { month: "Months", week: "Weeks", year: "Years" } as Record<TrendGrain, string>,
  units: { kwh: "kWh", usd: "$" },
  prev: "← Earlier",
  next: "Later →",
  total: "Total",
  bathsSubline: (baths: string) => `baths ${baths} · showers not detected yet`,
  partialFootnote: "* partial period",
  loading: "Loading…",
  error: "Couldn't load trends. Try again shortly.",
  clearSelection: "Click a bar to rank one period; click it again to see the whole range.",
};

/** Bar / header label for one period. */
export function periodLabel(p: TrendPeriod, grain: TrendGrain): string {
  const soFar = p.complete ? "" : " so far";
  switch (grain) {
    case "month":
      if (p.partialStart) {
        const span = `${monthDay.format(p.fromMs)}–${dayOnly.format(p.toMs - 1)}`;
        return p.complete ? span : `${monthDay.format(p.fromMs)} on, so far`;
      }
      return `${monthYear.format(p.fromMs)}${soFar}`;
    case "week":
      return `Week of ${monthDay.format(p.fromMs)}${soFar}`;
    case "year": {
      const y = yearOnly.format(p.fromMs);
      if (p.partialStart) return `${y} · from ${monthDay.format(p.fromMs)}${p.complete ? "" : ", so far"}`;
      return `${y}${soFar}`;
    }
  }
}

/** Short x-axis tick for a bar. */
export function tickLabel(p: TrendPeriod, grain: TrendGrain): string {
  switch (grain) {
    case "month":
      return monthOnly.format(p.fromMs);
    case "week":
      return monthDay.format(p.fromMs);
    case "year":
      return yearOnly.format(p.fromMs);
  }
}

/** Header label for the whole shown range. */
export function rangeLabel(ps: TrendPeriod[], grain: TrendGrain): string {
  if (ps.length === 0) return "";
  if (ps.length === 1) return periodLabel(ps[0], grain);
  const a = ps[0];
  const b = ps[ps.length - 1];
  switch (grain) {
    case "month":
      return `${monthYear.format(a.fromMs)}–${monthYear.format(b.fromMs)}`;
    case "week":
      return `Week of ${monthDay.format(a.fromMs)}–week of ${monthDay.format(b.fromMs)}`;
    case "year":
      return `${yearOnly.format(a.fromMs)}–${yearOnly.format(b.fromMs)}`;
  }
}

export const fmtKwh = (kwh: number) =>
  kwh >= 100 ? `${Math.round(kwh).toLocaleString("en-US")} kWh` : `${kwh.toFixed(1)} kWh`;
export const fmtUsd = (usd: number) =>
  usd >= 100 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`;
export const fmtPct = (share: number) => `${Math.round(share * 100)}%`;
