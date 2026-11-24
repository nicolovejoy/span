// Reader-facing strings for the Power Explorer page. Components import these
// rather than inlining text, so a later translation touches one file.

import { periodLabel } from "./energyWindow";
import type { EnergyRow } from "./queryCache";
import type { PresetId } from "./selection";
import type { SelectionSummary } from "./selectionSummary";
import { UNMONITORED } from "./drill";

/** What a reader sees for a category. The key stays "Unmonitored" in data and
 *  URLs (`off=Unmonitored`); only the label differs. */
const CATEGORY_LABELS: Record<string, string> = {
  [UNMONITORED]: "Washer/dryer/sub-panel",
};

export function categoryLabel(key: string): string {
  return CATEGORY_LABELS[key] ?? key;
}

export const EXPLORER_COPY = {
  title: "Power Explorer",
  panelHeading: "What to show",
  presets: {
    everything: "Everything",
    house: "House (no car)",
    hvac: "HVAC only",
    car: "Car only",
  } as Record<PresetId, string>,
  noKwh: "—",
  unmonitoredNote:
    "Washer/dryer/sub-panel is one feed: the panel total minus every named circuit. At 1-minute buckets it looks noisy.",
  nothingSelected: "Nothing selected",
  nothingSelectedHint: "Tick a category or pick a preset.",
  events: "Events",
  eventsTitle: "Heat-pump mode strip + bath/EV events under the chart",
  drillShow: (cat: string) => `Show ${cat} circuits`,
  drillHide: (cat: string) => `Hide ${cat} circuits`,
  partKwh: (on: number, total: number) => `${on.toFixed(1)} of ${total.toFixed(1)}`,
  legendPartial: (cat: string) => `${cat} (part)`,
  circuitsLoading: "Loading circuits…",
  circuitsNone: "No circuit data for this period",
};

/** "Nov 2026 so far" from the snap metadata carried on every breakdown row. */
export function periodText(rows: EnergyRow[]): string | null {
  const r = rows[0];
  if (!r || r.periodFromMs === undefined || r.periodGrain === undefined) return null;
  const label = periodLabel(r.periodFromMs, r.periodGrain);
  return r.periodComplete === false ? `${label} so far` : label;
}

export function headline(
  s: SelectionSummary,
  period: string | null,
): { main: string; detail: string } {
  if (s.onCount === 0) {
    return { main: EXPLORER_COPY.nothingSelected, detail: EXPLORER_COPY.nothingSelectedHint };
  }
  const parts: string[] = [];
  if (s.share !== null) {
    parts.push(`${Math.round(s.share * 100)}% of ${s.totalKwh.toFixed(1)} kWh`);
  }
  parts.push(`$${s.cost.toFixed(2)}`);
  if (period !== null) parts.push(period);
  return { main: `${s.kwh.toFixed(1)} kWh`, detail: parts.join(" · ") };
}

export function panelSummary(preset: PresetId | null, s: SelectionSummary): string {
  const what = preset ? EXPLORER_COPY.presets[preset] : `${s.onCount} of ${s.count} on`;
  return `${EXPLORER_COPY.panelHeading} · ${what}`;
}
