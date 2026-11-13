"use client";

import type { TrendBar } from "@/lib/trendsPayload";
import type { TrendGrain } from "@/lib/trends";
import { panelRows, type PanelKey, type TrendUnit } from "@/lib/whereItWent";
import {
  COPY,
  PANEL_LABELS,
  fmtKwh,
  fmtPct,
  fmtUsd,
  periodLabel,
  rangeLabel,
} from "@/lib/trendsCopy";

const ROW_FILL: Record<PanelKey, string> = {
  hvacUnsplit: "var(--trend-hvacUnsplit)",
  heat: "var(--trend-heat)",
  cool: "var(--trend-cool)",
  hotWater: "var(--trend-hotWater)",
  unclassified: "var(--trend-hvacOther-hatch)",
  standby: "var(--trend-hvacOther-hatch)",
  controls: "var(--trend-hvacOther-hatch)",
  car: "var(--trend-car)",
  lights: "var(--trend-lights)",
  appliances: "var(--trend-appliances)",
  other: "var(--trend-rest)",
  unmonitored: "var(--trend-rest)",
  baseCharge: "var(--trend-grid)",
};

export function WhereItWent({
  periods,
  selKey,
  unit,
  grain,
}: {
  periods: TrendBar[];
  selKey: string | null;
  unit: TrendUnit;
  grain: TrendGrain;
}) {
  const sel = selKey ? periods.find((p) => p.key === selKey) : undefined;
  const ranked = sel ? [sel] : periods;
  const { rows, totalValue, bathKwh } = panelRows(ranked, unit);
  const fmt = unit === "usd" ? fmtUsd : fmtKwh;
  const max = Math.max(0, ...rows.map((r) => r.value));
  const label = sel ? periodLabel(sel, grain) : rangeLabel(periods, grain);
  const from = ranked[0]?.fromMs;
  const to = ranked[ranked.length - 1]?.toMs;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">
        {COPY.whereItWent} · {label}
      </h2>
      <div className="text-2xl font-semibold tabular-nums">{fmt(totalValue)}</div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-col">
            <div className="flex items-baseline justify-between gap-2">
              <span>{PANEL_LABELS[r.key]}</span>
              <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
                {fmt(r.value)} · {fmtPct(r.share)}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-sm bg-zinc-100 dark:bg-zinc-800">
              <div
                className="h-1.5 rounded-sm"
                style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%`, background: ROW_FILL[r.key] }}
              />
            </div>
            {r.key === "hotWater" && (
              <span className="text-xs text-zinc-500">
                {COPY.bathsSubline(fmt(unit === "usd" ? (bathKwh * r.value) / r.kwh : bathKwh))}
              </span>
            )}
          </li>
        ))}
      </ul>
      {from !== undefined && to !== undefined && (
        <a href={`/?from=${from}&to=${to}`} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
          {COPY.openInExplorer}
        </a>
      )}
    </section>
  );
}
