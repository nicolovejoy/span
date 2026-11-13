"use client";

// Hand-rolled SVG stacked bars for /trends: one bar per Pacific calendar
// period, layers bottom → top in LAYER_ORDER. Manual-verify (no chart tests).

import { useEffect, useRef, useState } from "react";
import { LAYER_ORDER, type LayerKey } from "@/lib/trendLayers";
import type { TrendBar } from "@/lib/trendsPayload";
import type { TrendGrain } from "@/lib/trends";
import { costForKwh, proratedBaseCharge } from "@/lib/rates";
import type { TrendUnit } from "@/lib/whereItWent";
import {
  COPY,
  LAYER_LABELS,
  PANEL_LABELS,
  fmtKwh,
  fmtUsd,
  periodLabel,
  tickLabel,
} from "@/lib/trendsCopy";


const HEIGHT = 280;
const PAD = { top: 8, right: 8, bottom: 28, left: 48 };
const GAP = 2; // surface-colored gap between stacked segments
const RADIUS = 4;

export const layerFill = (k: LayerKey) =>
  k === "hvacOther" ? "url(#trend-hatch)" : `var(--trend-${k})`;

/** Round the axis max up to 1/2/2.5/5 × 10^n so 4 gridlines land on round numbers. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const step = v / 4;
  const mag = 10 ** Math.floor(Math.log10(step));
  const nice = [1, 2, 2.5, 5, 10].find((m) => m * mag >= step)! * mag;
  return nice * 4;
}

/** Rounded top corners, square bottom — the data end is the top. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

export function TrendsChart({
  periods,
  grain,
  unit,
  selKey,
  onSelect,
}: {
  periods: TrendBar[];
  grain: TrendGrain;
  unit: TrendUnit;
  selKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const v = (kwh: number) => (unit === "usd" ? costForKwh(kwh) : kwh);
  const fmt = unit === "usd" ? fmtUsd : fmtKwh;
  const fmtTick = (n: number) =>
    unit === "usd" ? `$${Math.round(n)}` : n >= 1000 ? `${n / 1000}k` : String(Math.round(n));

  const present = LAYER_ORDER.filter((k) => periods.some((p) => p.layers[k] > 0));
  const yMax = niceMax(Math.max(0, ...periods.map((p) => v(p.layers.totalKwh))));
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = periods.length ? plotW / periods.length : plotW;
  const barW = Math.min(56, band * 0.68);
  const y = (val: number) => PAD.top + plotH - (val / yMax) * plotH;
  const anyPartial = periods.some((p) => !p.complete || p.partialStart);

  const hovered = hover !== null ? periods[hover] : null;

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {present.map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <svg width="10" height="10" aria-hidden>
              <rect width="10" height="10" rx="2" fill={layerFill(k)} />
            </svg>
            {LAYER_LABELS[k]}
          </li>
        ))}
      </ul>

      <div ref={wrapRef} className="relative w-full">
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={COPY.title}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <pattern id="trend-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--trend-hvacOther)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--trend-hvacOther-hatch)" strokeWidth="2.5" />
            </pattern>
          </defs>

          {[0, 1, 2, 3, 4].map((i) => {
            const val = (yMax / 4) * i;
            return (
              <g key={i}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(val)}
                  y2={y(val)}
                  stroke="var(--trend-grid)"
                  strokeWidth={1}
                />
                <text x={PAD.left - 6} y={y(val) + 4} textAnchor="end" className="fill-zinc-500 text-[11px]">
                  {fmtTick(val)}
                </text>
              </g>
            );
          })}

          {periods.map((p, i) => {
            const x = PAD.left + band * i + (band - barW) / 2;
            const total = v(p.layers.totalKwh);
            const top = y(total);
            const dim = selKey !== null && selKey !== p.key;
            let acc = 0;
            const clipId = `trend-clip-${i}`;
            return (
              <g
                key={p.key}
                opacity={dim ? 0.35 : 1}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHover(i)}
                onClick={() => onSelect(selKey === p.key ? null : p.key)}
              >
                <clipPath id={clipId}>
                  <path d={topRoundedRect(x, top, barW, Math.max(0, y(0) - top), RADIUS)} />
                </clipPath>
                <g clipPath={`url(#${clipId})`}>
                  {LAYER_ORDER.map((k) => {
                    const val = v(p.layers[k]);
                    if (val <= 0) return null;
                    const y0 = y(acc);
                    acc += val;
                    const y1 = y(acc);
                    // Shave a surface gap off the top of every segment but the last.
                    const gap = acc < total - 1e-9 ? GAP : 0;
                    const h = y0 - y1 - gap;
                    if (h <= 0) return null;
                    return <rect key={k} x={x} y={y1 + gap} width={barW} height={h} fill={layerFill(k)} />;
                  })}
                </g>
                {/* Hit target: the whole band, taller than the bar. */}
                <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent" />
                <text
                  x={x + barW / 2}
                  y={HEIGHT - PAD.bottom + 16}
                  textAnchor="middle"
                  className={`text-[11px] ${selKey === p.key ? "fill-zinc-900 dark:fill-zinc-100 font-semibold" : "fill-zinc-500"}`}
                >
                  {tickLabel(p, grain)}
                  {!p.complete || p.partialStart ? "*" : ""}
                </text>
              </g>
            );
          })}
        </svg>

        {hovered && hover !== null && (
          <div
            className="pointer-events-none absolute z-10 w-64 rounded-md border border-zinc-200 bg-white p-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900"
            style={{
              left: Math.min(Math.max(0, PAD.left + band * hover + band / 2 - 128), width - 256),
              top: 4,
            }}
          >
            <div className="mb-1 font-semibold">{periodLabel(hovered, grain)}</div>
            <table className="w-full">
              <tbody>
                {[...LAYER_ORDER].reverse().map((k) =>
                  hovered.layers[k] > 0 ? (
                    <tr key={k}>
                      <td className="pr-2">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: k === "hvacOther" ? "var(--trend-hvacOther-hatch)" : `var(--trend-${k})` }} />
                        {LAYER_LABELS[k]}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums">{fmt(v(hovered.layers[k]))}</td>
                    </tr>
                  ) : null,
                )}
                {unit === "usd" && (
                  <tr>
                    <td className="pr-2 text-zinc-500">{PANEL_LABELS.baseCharge}</td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {fmt(proratedBaseCharge(hovered.toMs - hovered.fromMs))}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-zinc-200 font-semibold dark:border-zinc-700">
                  <td className="pt-1">{COPY.total}</td>
                  <td className="whitespace-nowrap pt-1 text-right tabular-nums">
                    {fmt(
                      v(hovered.layers.totalKwh) +
                        (unit === "usd" ? proratedBaseCharge(hovered.toMs - hovered.fromMs) : 0),
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
      {anyPartial && <div className="text-[11px] text-zinc-500">{COPY.partialFootnote}</div>}
    </div>
  );
}
