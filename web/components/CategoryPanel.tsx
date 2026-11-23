"use client";

import {
  PRESET_IDS,
  UNMONITORED,
  activePreset,
  presetOff,
  toggle,
  type OffSet,
} from "@/lib/selection";
import type { PanelRow } from "@/lib/selectionSummary";
import { EXPLORER_COPY } from "@/lib/explorerCopy";
import { Chip } from "./QuickFilters";

/** What to show: presets, one tickable row per category with its kWh, and a
 *  drill button on the rows that have circuits. Rendered twice by the page (a
 *  sidebar at lg+, a disclosure below), so it holds no state of its own. */
export function CategoryPanel({
  rows,
  off,
  drill,
  period,
  onSelect,
  onDrill,
}: {
  rows: PanelRow[];
  off: OffSet;
  /** Category currently expanded into its circuits, or null (#12). */
  drill: string | null;
  period: string | null;
  onSelect: (off: OffSet) => void;
  onDrill: (cat: string | null) => void;
}) {
  const preset = activePreset(off);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          {EXPLORER_COPY.panelHeading}
        </span>
        {period && <span className="text-xs text-zinc-500">{period}</span>}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESET_IDS.map((id) => (
          <Chip key={id} active={preset === id} onClick={() => onSelect(presetOff(id))}>
            {EXPLORER_COPY.presets[id]}
          </Chip>
        ))}
      </div>

      <div className="flex flex-col">
        {rows.map((row) => {
          const drilled = drill === row.key;
          return (
            <div key={row.key} className="flex items-center gap-1">
              <label
                className={[
                  "flex min-h-[44px] flex-1 cursor-pointer items-center gap-2.5",
                  row.on ? "" : "text-zinc-400 dark:text-zinc-600",
                ].join(" ")}
              >
                <input
                  type="checkbox"
                  checked={row.on}
                  onChange={() => onSelect(toggle(off, row.key))}
                  className="h-4 w-4 shrink-0"
                />
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: row.color, opacity: row.on ? 1 : 0.35 }}
                  aria-hidden
                />
                <span className="flex-1">{row.key}</span>
                <span className="tabular-nums">
                  {row.kwh?.toFixed(1) ?? EXPLORER_COPY.noKwh}
                </span>
              </label>
              {row.key !== UNMONITORED && row.on && (
                <button
                  type="button"
                  onClick={() => onDrill(drilled ? null : row.key)}
                  aria-pressed={drilled}
                  title={drilled ? EXPLORER_COPY.drillHide(row.key) : EXPLORER_COPY.drillShow(row.key)}
                  aria-label={drilled ? EXPLORER_COPY.drillHide(row.key) : EXPLORER_COPY.drillShow(row.key)}
                  className={[
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none transition-colors",
                    drilled
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                      : "border-zinc-300 text-zinc-500 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
                  ].join(" ")}
                >
                  {drilled ? "✕" : "⌄"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-zinc-500">{EXPLORER_COPY.unmonitoredNote}</p>
    </div>
  );
}
