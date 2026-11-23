"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { intervalSeconds } from "@/lib/interval";
import {
  centerWindow,
  clampToExtent,
  moveWindow,
  msPerPx,
  overviewInterval,
  pxToTime,
  resizeWindow,
  sameWindow,
  timeToPx,
} from "@/lib/brush";
import { fetchSeriesCached } from "@/lib/clientFetch";
import type { Window } from "@/lib/panWindow";

/** How far back to ask for history. The InfluxDB `span` bucket keeps raw data
 *  forever, so this is just "generously before the first sample" — the drawn
 *  extent is defined by the first point that actually comes back, not by this
 *  constant, so it can sit ahead of the real retention start without hurting.
 *  (Collection began 2026-03; Jan 1 leaves room for a backfill.) */
const RETENTION_START_MS = Date.UTC(2026, 0, 1);

const STRIP_COLOR = "#6b7280";

/** Half-width of an edge-resize hit target, px (`-left-2 w-4` / `-right-2 w-4`). */
const EDGE_HANDLE_PX = 8;

type Props = {
  /** The window the main chart currently shows — the brush follows it. */
  fromMs: number;
  toMs: number;
  /** Committed on pointer-up (each commit costs a fetch, so not per-move). */
  onChange: (fromMs: number, toMs: number) => void;
};

type Drag = { mode: "move" | "left" | "right"; startX: number; start: Window };

export function OverviewStrip({ fromMs, toMs, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const dragRef = useRef<Drag | null>(null);

  /** Drawn extent = first→last point of the all-history series. Null until the
   *  fetch lands; the brush stays hidden until then. */
  const [extent, setExtent] = useState<Window | null>(null);
  const [width, setWidth] = useState(0);
  /** Live rectangle while dragging; null means "follow the props". */
  const [draft, setDraft] = useState<Window | null>(null);

  // Create the chart once. Everything interactive is disabled: the strip is a
  // static backdrop for the brush overlay, and a stable, unscrolled time axis
  // is what makes the linear px↔time mapping in lib/brush valid.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#888" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      leftPriceScale: { visible: false },
      rightPriceScale: { visible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: false,
        // Month ticks are labelled UTC, not Pacific — a boundary can sit up to
        // 7h off. Invisible at this zoom, and not worth PowerChart's
        // per-point offset shift for an orientation-only axis.
        fixLeftEdge: true,
        fixRightEdge: true,
        rightOffset: 0,
        lockVisibleTimeRangeOnResize: true,
      },
      handleScale: false,
      handleScroll: false,
      crosshair: { mode: 2 /* Hidden */ },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addSeries(AreaSeries, {
      lineColor: STRIP_COLOR,
      lineWidth: 1,
      topColor: "rgba(107,114,128,0.35)",
      bottomColor: "rgba(107,114,128,0.02)",
      priceLineVisible: false,
      lastValueVisible: false,
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Track the rendered width so px↔time stays right across resize/rotate. Both
  // price scales are hidden, so the plot area is the full container width.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? el.clientWidth);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // One all-history fetch on mount: the sum of the five categories (not the
  // Unmonitored series) at the finest bucket that fits one query. It opts out of
  // the grid query (grid=false): the strip loads on every page, and the panel
  // scan over all history is the slow part. Quantized so the cache key is stable
  // across remounts within a bucket.
  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const interval = overviewInterval(RETENTION_START_MS, now);
    const stepMs = intervalSeconds(interval) * 1000;
    const q = (ms: number) => Math.floor(ms / stepMs) * stepMs;

    fetchSeriesCached(q(RETENTION_START_MS), q(now), interval, undefined, false)
      .then((data) => {
        if (cancelled || !seriesRef.current) return;
        const totals = new Map<number, number>();
        for (const p of data) {
          const t = Math.floor(new Date(p.time).getTime() / 1000);
          totals.set(t, (totals.get(t) ?? 0) + p.watts / 1000);
        }
        const points = Array.from(totals.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([t, kw]) => ({ time: t as UTCTimestamp, value: kw }));
        if (points.length === 0) return;
        try {
          seriesRef.current.setData(points);
          chartRef.current?.timeScale().fitContent();
        } catch (e) {
          console.warn("OverviewStrip setData failed", e);
          return;
        }
        setExtent({
          fromMs: points[0]!.time * 1000,
          toMs: points[points.length - 1]!.time * 1000,
        });
      })
      .catch((e) => console.warn("OverviewStrip fetch failed", e));

    return () => {
      cancelled = true;
    };
  }, []);

  const win = draft ?? clampToExtent({ fromMs, toMs }, extent ?? { fromMs, toMs });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!extent || width <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const edge = (e.target as HTMLElement).dataset.brushEdge as
        | "left"
        | "right"
        | undefined;
      const onBody = (e.target as HTMLElement).dataset.brushBody === "1";

      // A tap on bare strip jumps the window there first, then drags from it.
      const start =
        edge || onBody
          ? win
          : centerWindow(
              win,
              pxToTime(e.clientX - rect.left, extent, width),
              extent,
            );

      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { mode: edge ?? "move", startX: e.clientX, start };
      setDraft(start);
    },
    [extent, width, win],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || !extent) return;
      const deltaMs = (e.clientX - drag.startX) * msPerPx(extent, width);
      setDraft(
        drag.mode === "move"
          ? moveWindow(drag.start, deltaMs, extent)
          : resizeWindow(drag.start, drag.mode, deltaMs, extent),
      );
    },
    [extent, width],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const next = draft;
      setDraft(null);
      // Only commit a real change — a stray tap shouldn't cost a fetch.
      if (drag && next && !sameWindow(next, { fromMs, toMs })) {
        onChange(next.fromMs, next.toMs);
      }
    },
    [draft, fromMs, toMs, onChange],
  );

  const rawLeft = extent ? Math.max(0, timeToPx(win.fromMs, extent, width)) : 0;
  const right = extent
    ? Math.min(width, timeToPx(win.toMs, extent, width))
    : 0;
  // Keep a grabbable rectangle even when the window is a sliver of 7 months —
  // and keep that minimum *inside* the strip, or the default 24h window (a
  // sliver hard against `now`) hangs half off the right edge.
  const boxWidth = Math.min(width, Math.max(8, right - rawLeft));
  const left = Math.max(0, Math.min(rawLeft, width - boxWidth));
  // The two 16px edge handles overlap for a narrow box, leaving no middle to
  // grab — every drag would resize. Below that width the box is body-only and
  // resizing waits until you've moved/zoomed to something wider.
  const showEdges = boxWidth >= EDGE_HANDLE_PX * 2 + 8;

  return (
    <div className="relative select-none">
      <div ref={containerRef} className="h-[60px] w-full" />
      {!extent && (
        <div className="pointer-events-none absolute inset-0 z-10 animate-pulse rounded-sm bg-zinc-100 dark:bg-zinc-900" />
      )}
      {extent && width > 0 && (
        /* z-10: lightweight-charts gives its canvases z-index 1–2 and its
           wrapper opens no stacking context, so a z-auto sibling — even one
           painted later — loses the hit test and never sees a pointerdown. */
        <div
          className="absolute inset-0 z-10 touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* Outside the window, dimmed — the brush reads as a lens. */}
          <div
            className="absolute inset-y-0 left-0 bg-zinc-100/70 dark:bg-zinc-950/70"
            style={{ width: left }}
          />
          <div
            className="absolute inset-y-0 right-0 bg-zinc-100/70 dark:bg-zinc-950/70"
            style={{ width: Math.max(0, width - left - boxWidth) }}
          />
          <div
            data-brush-body="1"
            className="absolute inset-y-0 cursor-grab border-x-2 border-zinc-500 bg-zinc-400/10 active:cursor-grabbing dark:border-zinc-400"
            style={{ left, width: boxWidth }}
          >
            {/* Fat invisible hit targets on the edges (touch). */}
            {showEdges && (
              <>
                <div
                  data-brush-edge="left"
                  className="absolute inset-y-0 -left-2 w-4 cursor-ew-resize"
                />
                <div
                  data-brush-edge="right"
                  className="absolute inset-y-0 -right-2 w-4 cursor-ew-resize"
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
