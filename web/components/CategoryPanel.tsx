"use client";

import {
  PRESET_IDS,
  UNMONITORED,
  activePreset,
  presetOff,
  toggle,
  toggleCircuit,
  type OffSet,
} from "@/lib/selection";
import type { PanelRow } from "@/lib/selectionSummary";
import { EXPLORER_COPY, categoryLabel } from "@/lib/explorerCopy";
import { Chip } from "./QuickFilters";

/** What to show: presets, one tickable row per category with its kWh (a
 *  category with some circuits off shows an indeterminate box and "on of
 *  total"), and a button that expands a category into one tickable row per
 *  circuit. Rendered twice by the page (a sidebar at lg+, a disclosure below),
 *  so it holds no state of its own. */
export function CategoryPanel({
  rows,
  off,
  expanded,
  loadedCircuits,
  period,
  onSelect,
  onExpand,
}: {
  rows: PanelRow[];
  off: OffSet;
  /** Categories whose circuit rows are showing. */
  expanded: readonly string[];
  /** Categories whose circuit fetch has settled (a failed or empty one too). */
  loadedCircuits: readonly string[];
  period: string | null;
  onSelect: (off: OffSet) => void;
  onExpand: (cat: string) => void;
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
          const open = expanded.includes(row.key);
          const muted = row.state === "off" ? "text-zinc-400 dark:text-zinc-600" : "";
          const members = row.circuits.map((x) => x.name);
          return (
            <div key={row.key} className="flex flex-col">
              <div className="flex items-center gap-1">
                <label
                  className={[
                    "flex min-h-[44px] flex-1 cursor-pointer items-center gap-2.5",
                    muted,
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    checked={row.state === "on"}
                    ref={(el) => {
                      if (el) el.indeterminate = row.state === "partial";
                    }}
                    onChange={() => onSelect(toggle(off, row.key))}
                    className="h-4 w-4 shrink-0"
                  />
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: row.color, opacity: row.state === "off" ? 0.35 : 1 }}
                    aria-hidden
                  />
                  <span className="flex-1">{categoryLabel(row.key)}</span>
                  <span className="tabular-nums">
                    {row.state === "partial" && row.onKwh !== null && row.kwh !== null
                      ? EXPLORER_COPY.partKwh(row.onKwh, row.kwh)
                      : row.kwh?.toFixed(1) ?? EXPLORER_COPY.noKwh}
                  </span>
                </label>
                {row.key !== UNMONITORED && (
                  <button
                    type="button"
                    onClick={() => onExpand(row.key)}
                    aria-expanded={open}
                    title={open ? EXPLORER_COPY.drillHide(row.key) : EXPLORER_COPY.drillShow(row.key)}
                    aria-label={open ? EXPLORER_COPY.drillHide(row.key) : EXPLORER_COPY.drillShow(row.key)}
                    className={[
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none transition-colors",
                      open
                        ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                        : "border-zinc-300 text-zinc-500 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
                    ].join(" ")}
                  >
                    {open ? "✕" : "⌄"}
                  </button>
                )}
              </div>
              {open && row.key !== UNMONITORED && (
                row.circuits.length === 0 ? (
                  <p className="pl-6 text-xs text-zinc-500">
                    {loadedCircuits.includes(row.key)
                      ? EXPLORER_COPY.circuitsNone
                      : EXPLORER_COPY.circuitsLoading}
                  </p>
                ) : (
                  row.circuits.map((c) => (
                    <label
                      key={c.name}
                      className={[
                        "flex min-h-[36px] cursor-pointer items-center gap-2.5 pl-6",
                        c.on ? "" : "text-zinc-400 dark:text-zinc-600",
                      ].join(" ")}
                    >
                      <input
                        type="checkbox"
                        checked={c.on}
                        onChange={() => onSelect(toggleCircuit(off, c.name, members))}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="flex-1 truncate" title={c.name}>
                        {c.name}
                      </span>
                      <span className="tabular-nums">{c.kwh.toFixed(1)}</span>
                    </label>
                  ))
                )
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-zinc-500">{EXPLORER_COPY.unmonitoredNote}</p>
    </div>
  );
}
