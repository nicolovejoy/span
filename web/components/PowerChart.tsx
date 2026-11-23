"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  type AutoscaleInfo,
  createChart,
  LineSeries,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type TimeRangeChangeEventHandler,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import { intervalSeconds, MAX_BUCKETS, type IntervalKey } from "@/lib/interval";
import {
  CATEGORY_ORDER,
  LEGEND_MAX_CIRCUITS,
  categoryColor,
  circuitShades,
  drillInterval,
} from "@/lib/drill";
import { padWindow, needsExtension, extendWindow } from "@/lib/panWindow";
import { fetchSeriesCached } from "@/lib/clientFetch";
import type { SeriesPoint } from "@/lib/influx";
import type { DashState } from "@/lib/url-state";
import { stackLayers } from "@/lib/stack";
import { chartCategories, serializeOff, showTotal, type OffSet } from "@/lib/selection";
import { affineXOf, resolveAnchors, type XOf } from "@/lib/eventLanes";
import type { EventsPayload } from "@/lib/eventRuns";
import { EventLanes } from "./EventLanes";

/** Called when a pan/zoom settles, with the visible sub-window (real-UTC ms).
 *  Drives the table + header only — it never moves the chart's view, so there
 *  is no gesture→fetch→setVisibleRange feedback loop. (A gesture that reaches
 *  a loaded edge does widen the *loaded* window, but that re-setData restores
 *  the user's current view rather than resetting it.) */
export type VisibleChange = (fromMs: number, toMs: number) => void;

/** What's currently fetched + drawn. Wider than the visible window (see
 *  lib/panWindow) so there's drag room inside the fixLeftEdge/fixRightEdge
 *  bounds. `viewFrom/viewTo` is the preset window this padding was built
 *  around — the reset target, and the step size for edge extension. */
type LoadWindow = {
  fromMs: number;
  toMs: number;
  interval: IntervalKey;
  viewFromMs: number;
  viewToMs: number;
  /** Category drawn as one line per circuit instead of one line (#12). */
  drill: string | null;
  /** true = preset/bucket change (snap the view back to viewFrom/viewTo);
   *  false = edge extension or drill change (keep whatever the user is
   *  looking at). */
  resetView: boolean;
};

type LegendEntry = {
  label: string;
  color: string;
  dotted?: boolean;
  /** Drilled circuit — nested under its category label. */
  indent?: boolean;
  /** Label only, no swatch — a drilled category has no line of its own. */
  header?: boolean;
  /** Filled square swatch — a stacked band rather than a line. */
  filled?: boolean;
};

const TOTAL_COLOR = "#9ca3af";  // dotted reference, intentionally low-contrast

type Point = { time: UTCTimestamp; value: number };
type SeriesEntry = Point | WhitespaceData<UTCTimestamp>;

function toUtc(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
}

// lightweight-charts has no timezone support — it renders every timestamp as
// UTC. To put Pacific wall-clock on the axis we shift each real-UTC second by
// that instant's Pacific offset before handing it to the chart, so the
// library's "UTC" clock reads as Seattle local. All navigation / fetch / URL
// math stays in true UTC; only values crossing the chart boundary are
// transformed (toChartData / setVisibleRange out, fromDisplay back in).
const DISPLAY_TZ = "America/Los_Angeles";

// Seconds to add to a real-UTC instant so it reads as Pacific wall-clock.
// Computed per-instant via Intl so DST flips across a wide range stay correct
// (e.g. -8h in winter, -7h in summer). Negative west of UTC.
function tzOffsetSec(utcMs: number): number {
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
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - utcMs) / 1000);
}

// real UTC second → chart "display" second (Pacific wall-clock as fake-UTC).
function toDisplay(realSec: number): UTCTimestamp {
  return (realSec + tzOffsetSec(realSec * 1000)) as UTCTimestamp;
}

// chart "display" second → real UTC second. One refine pass nails the DST edge.
function fromDisplay(dispSec: number): number {
  let real = dispSec - tzOffsetSec(dispSec * 1000);
  real = dispSec - tzOffsetSec(real * 1000);
  return real;
}

// Shift a built series array onto the chart's Pacific-as-UTC clock right before
// setData. Whitespace sentinels ({time} only) carry through without a value.
function toChartData(entries: SeriesEntry[]): SeriesEntry[] {
  return entries.map((e) =>
    "value" in e
      ? { time: toDisplay(Number(e.time)), value: e.value }
      : { time: toDisplay(Number(e.time)) },
  );
}

// Axis formatting. Chart times are already Pacific-as-fake-UTC (see toDisplay),
// so read them with getUTC* — the wall-clock is baked into the number.
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hhmm = (d: Date) => `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

// Day boundaries (and month/year starts) render as a dated label so a window
// spanning midnight gets a clear demarcation under the hours; intra-day ticks
// stay HH:mm.
function tickFmt(time: Time, type: TickMarkType): string {
  const d = new Date(Number(time) * 1000);
  switch (type) {
    case TickMarkType.Year:
      return String(d.getUTCFullYear());
    case TickMarkType.Month:
      return `${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    case TickMarkType.DayOfMonth:
      return `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()}`;
    default:
      return hhmm(d);
  }
}

// Crosshair tooltip — full date + time, Pacific.
function crosshairFmt(time: Time): string {
  const d = new Date(Number(time) * 1000);
  return `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()}, ${hhmm(d)}`;
}

// Flux `aggregateWindow` aligns buckets to epoch, so at wide ranges with
// coarse buckets the first/last data points land *inside* the requested
// window. Without sentinels, the chart's time axis collapses to the data
// extent and setVisibleRange can't span the full ask. WhitespaceData is
// `{time}` with no value — it extends the time axis without drawing zeros
// (which is what crashed lightweight-charts when we tried createEmpty:true).
function padBounds(
  points: Point[],
  outerFromSec: UTCTimestamp,
  outerToSec: UTCTimestamp,
): SeriesEntry[] {
  if (points.length === 0) {
    return [{ time: outerFromSec }, { time: outerToSec }];
  }
  const out: SeriesEntry[] = [];
  const first = points[0]!.time;
  const last = points[points.length - 1]!.time;
  if (outerFromSec < first) out.push({ time: outerFromSec });
  for (const p of points) out.push(p);
  if (outerToSec > last) out.push({ time: outerToSec });
  return out;
}

function shapeData(data: SeriesPoint[]) {
  const byCat = new Map<string, Map<UTCTimestamp, number>>();
  const totalByTime = new Map<UTCTimestamp, number>();
  for (const p of data) {
    const t = toUtc(p.time);
    const kw = p.watts / 1000;
    let cat = byCat.get(p.series);
    if (!cat) {
      cat = new Map();
      byCat.set(p.series, cat);
    }
    cat.set(t, kw);
    totalByTime.set(t, (totalByTime.get(t) ?? 0) + kw);
  }
  const sortedTimes = Array.from(totalByTime.keys()).sort((a, b) => a - b);
  return { byCat, totalByTime, sortedTimes };
}

function pointsFor(
  times: UTCTimestamp[],
  source: Map<UTCTimestamp, number> | undefined,
): Point[] {
  if (!source) return [];
  return times.map((time) => ({ time, value: source.get(time) ?? 0 }));
}

/**
 * Add/remove/recolor the drilled category's per-circuit series so the chart
 * holds exactly `names` (sorted, so a circuit keeps its shade). The five
 * category series are created once at mount; these are the only dynamic ones.
 * Called with an empty `names` when backing out of a drill.
 */
function reconcileCircuitSeries(
  chart: IChartApi,
  map: Map<string, ISeriesApi<"Line">>,
  names: string[],
  baseColor: string,
): void {
  const wanted = new Set(names);
  for (const [name, series] of map) {
    if (wanted.has(name)) continue;
    try { chart.removeSeries(series); }
    catch (e) { console.warn(`removeSeries failed for ${name}`, e); }
    map.delete(name);
  }
  const shades = circuitShades(baseColor, names.length);
  names.forEach((name, i) => {
    const color = shades[i] ?? baseColor;
    const existing = map.get(name);
    if (existing) {
      existing.applyOptions({ color });
      return;
    }
    map.set(
      name,
      chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      }),
    );
  });
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-zinc-500 dark:text-zinc-400"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PowerChart({
  state,
  onVisibleChange,
  events,
  eventsOn,
}: {
  state: DashState;
  onVisibleChange: VisibleChange;
  events: EventsPayload | null;
  eventsOn: boolean;
}) {
  // Latest onVisibleChange, read from the create-once chart effect without
  // re-subscribing.
  const onVisibleRef = useRef(onVisibleChange);
  onVisibleRef.current = onVisibleChange;
  // Latest selection, read from the fetch callback below: a box ticked while a
  // range load is in flight must not be overwritten by the selection captured
  // when the load started. (The drill is deliberately not mirrored: the circuit
  // lines drawn belong to load.drill, and a drill change starts a new load.)
  const offRef = useRef(state.off);
  offRef.current = state.off;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Every series handle below belongs to whatever chart `chartRef` holds, and
  // lightweight-charts throws ("Value is null") on any call into a series whose
  // chart has been removed. A remount (StrictMode's double-mount, Fast Refresh)
  // tears the chart down between an effect being scheduled and running, so a
  // `!series` null check isn't enough — the ref still holds a dead object.
  // This flag is the one thing cleared *before* teardown starts; every path
  // that touches a series checks it.
  const chartAliveRef = useRef(false);
  // Stacked bands, one per category, each holding the running total up to and
  // including itself (see lib/stack).
  const catSeriesRef = useRef<Map<string, ISeriesApi<"Area">>>(new Map());
  // Drill-down lines, created/removed on the fly (see reconcileCircuitSeries).
  const circuitSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const totalSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const gestureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last loaded payload — kept so a selection toggle can recompute the stack
  // and per-series visibility without a refetch or a zoom reset.
  const dataRef = useRef<{
    byCat: Map<string, Map<UTCTimestamp, number>>;
    sortedTimes: UTCTimestamp[];
    outerFromSec: UTCTimestamp;
    outerToSec: UTCTimestamp;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Circuit names in the current drill, sorted — legend only; the series
  // themselves live in circuitSeriesRef.
  const [circuitNames, setCircuitNames] = useState<string[]>([]);
  // Bumped on every visible-logical-range change so the lanes re-read the
  // chart's scale and stay pinned under the data during a pan/zoom.
  const [laneTick, setLaneTick] = useState(0);
  // The loaded (padded) window. `loadRef` mirrors it for the create-once chart
  // callback; `extendingRef` keeps overlapping extensions from stacking up.
  const [load, setLoad] = useState<LoadWindow | null>(null);
  const loadRef = useRef<LoadWindow | null>(null);
  const extendingRef = useRef(false);
  // Last window/bucket the padding was computed for — lets the load effect tell
  // a real range change from a drill-only change (which must not re-pad).
  const lastViewRef = useRef<{
    fromMs: number;
    toMs: number;
    interval: IntervalKey;
  } | null>(null);

  // Redraw the stacked bands from the last loaded data for the current
  // selection. A band exists only for an on category (other than the drilled
  // one, which is shown as circuit lines); Total is the whole-house reference
  // and only makes sense when nothing is filtered. No refetch, no
  // setVisibleRange — preserves zoom.
  const applyStack = (off: OffSet, drill: string | null) => {
    const d = dataRef.current;
    if (!d || !chartAliveRef.current) return;
    const layers = stackLayers(
      CATEGORY_ORDER,
      chartCategories(off).filter((c) => c !== drill),
      d.byCat,
      d.sortedTimes,
    );
    for (const cat of CATEGORY_ORDER) {
      const series = catSeriesRef.current.get(cat);
      if (!series) continue;
      const layer = layers.get(cat);
      // A band with no layer still gets the padded empty data for the loaded
      // window, every pass: lightweight-charts builds its time axis from hidden
      // series too, so stale points from an earlier window or bucket size would
      // warp the axis and the event lanes' time-to-x map.
      try {
        series.setData(
          toChartData(padBounds(layer ?? [], d.outerFromSec, d.outerToSec)),
        );
      } catch (e) {
        console.warn(`setData failed for ${cat}`, e);
      }
      series.applyOptions({ visible: layer !== undefined });
    }
    totalSeriesRef.current?.applyOptions({ visible: showTotal(off) && !drill });
  };

  // Create chart + series once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#888",
      },
      grid: {
        vertLines: { color: "rgba(120,120,120,0.1)" },
        horzLines: { color: "rgba(120,120,120,0.1)" },
      },
      localization: { timeFormatter: crosshairFmt },
      // Bands fill down to the pane bottom, so the axis must bottom out at 0 or
      // the lowest band's height misstates its share. The maximum still follows
      // the current selection (see the band series' autoscaleInfoProvider).
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: tickFmt,
        // Bound pan/zoom to the loaded data: you can explore within the window
        // but can never scroll/zoom off into empty canvas (past `now`, or
        // before the first point). This is what stops the blank-out — and
        // since the loaded window is padded well past the visible one, it
        // bounds the *padding*, leaving real room to drag.
        fixLeftEdge: true,
        fixRightEdge: true,
        rightOffset: 0,
        lockVisibleTimeRangeOnResize: true,
      },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      crosshair: { mode: 1 /* Magnet */ },
    });
    chartRef.current = chart;
    chartAliveRef.current = true;

    // Series draw in the order they are added, later on top. The stack's top
    // layer (Else) is the largest cumulative value, so it goes in first, at the
    // back, and each smaller layer paints over it. The fill is opaque enough
    // that a band in front hides the one behind. Drill-down circuit series are
    // added and removed around these as the drill changes.
    for (const cat of CATEGORY_ORDER.slice().reverse()) {
      const color = categoryColor(cat);
      const s = chart.addSeries(AreaSeries, {
        lineColor: color,
        topColor: `${color}cc`,
        bottomColor: `${color}cc`,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        // Pin the floor to 0; keep the data-driven maximum.
        autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
          const res = original();
          if (res === null || res.priceRange === null) return res;
          return {
            ...res,
            priceRange: { minValue: 0, maxValue: Math.max(res.priceRange.maxValue, 0) },
          };
        },
      });
      catSeriesRef.current.set(cat, s);
    }

    // Total goes in last so its dotted line draws over the bands.
    const total = chart.addSeries(LineSeries, {
      color: TOTAL_COLOR,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    totalSeriesRef.current = total;

    // Report the visible sub-window outward (table + header follow pan/zoom),
    // then top up the loaded window if the gesture landed near one of its
    // edges. The view itself is never moved from here, so there's no feedback
    // loop; an extension re-setData's around the user's current view.
    const onRangeChange: TimeRangeChangeEventHandler<Time> = (range) => {
      if (!range) return;
      const fromSec = Number(range.from);
      const toSec = Number(range.to);
      if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) return;
      if (gestureTimer.current) clearTimeout(gestureTimer.current);
      gestureTimer.current = setTimeout(() => {
        let from = fromDisplay(fromSec) * 1000;
        let to = fromDisplay(toSec) * 1000;
        if (!(from < to)) return;
        const now = Date.now();
        if (to > now) to = now;
        if (from < 0) from = 0;
        from = Math.round(from);
        to = Math.round(to);
        onVisibleRef.current(from, to);

        const loaded = loadRef.current;
        if (!loaded || extendingRef.current) return;
        const side = needsExtension(loaded, { fromMs: from, toMs: to }, now);
        if (!side) return;
        const next = extendWindow(loaded, side, {
          stepMs: loaded.viewToMs - loaded.viewFromMs,
          nowMs: now,
          intervalMs: intervalSeconds(loaded.interval) * 1000,
          maxBuckets: MAX_BUCKETS,
        });
        if (!next) return; // at the cap (or at `now` / the epoch) — nothing to add
        extendingRef.current = true;
        setLoad({ ...loaded, ...next, resetView: false });
      }, 180);
    };

    chart.timeScale().subscribeVisibleTimeRangeChange(onRangeChange);

    let raf = 0;
    const onLogical = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setLaneTick((t) => t + 1); });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onLogical);

    return () => {
      // Drop every handle *before* removing the chart: if `remove()` throws
      // mid-teardown the refs would otherwise stay pointing at a dead chart and
      // the next effect would call into it. The load window goes too — it
      // describes data that lived on this chart, so a remount re-pads from the
      // current state instead of resurrecting the old one.
      chartAliveRef.current = false;
      chartRef.current = null;
      catSeriesRef.current.clear();
      circuitSeriesRef.current.clear();
      totalSeriesRef.current = null;
      dataRef.current = null;
      loadRef.current = null;
      lastViewRef.current = null;
      extendingRef.current = false;
      if (gestureTimer.current) {
        clearTimeout(gestureTimer.current);
        gestureTimer.current = null;
      }
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onRangeChange);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onLogical);
      if (raf) cancelAnimationFrame(raf);
      chart.remove();
    };
    // intentionally empty: stable chart instance; callback read via onVisibleRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A preset/bucket change picks the *visible* window; pad it out to the
  // loaded window here. The bucket stays keyed to the visible span (chosen
  // upstream by autoInterval) — padWindow shrinks the padding if the wider
  // fetch would blow past MAX_BUCKETS.
  useEffect(() => {
    const prev = lastViewRef.current;
    const viewChanged =
      !prev ||
      prev.fromMs !== state.fromMs ||
      prev.toMs !== state.toMs ||
      prev.interval !== state.interval;
    lastViewRef.current = {
      fromMs: state.fromMs,
      toMs: state.toMs,
      interval: state.interval,
    };

    // Drill toggled on its own: keep the exact window already loaded (edge
    // extensions included) and don't touch the visible range — only the drilled
    // series is missing, and it must arrive at the user's current zoom.
    if (!viewChanged) {
      const loaded = loadRef.current;
      if (loaded) {
        setLoad({ ...loaded, drill: state.drill, resetView: false });
        return;
      }
    }

    const now = Date.now();
    const intervalMs = intervalSeconds(state.interval) * 1000;
    const viewFromMs = state.fromMs;
    const viewToMs = Math.min(now, state.toMs);
    const padded = padWindow(
      { fromMs: viewFromMs, toMs: viewToMs },
      { nowMs: now, intervalMs, maxBuckets: MAX_BUCKETS },
    );
    extendingRef.current = false;
    setLoad({
      ...padded,
      interval: state.interval,
      viewFromMs,
      viewToMs,
      drill: state.drill,
      resetView: true,
    });
  }, [state.fromMs, state.toMs, state.interval, state.drill]);

  // Fetch + render the loaded window. Runs on a preset/bucket change (snapping
  // the view back to the preset) and on an edge extension (keeping the user's
  // current view). Plain pan/zoom inside the padding does NOT run this.
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    const prevLoad = loadRef.current;
    // The chart this fetch is for. A remount swaps in a new one while the
    // request is still in flight, and the series we're about to draw into
    // belong to the old one.
    const chartAtStart = chartRef.current;
    loadRef.current = load;
    // Extensions load in the background — the chart already has data to show.
    // A drill change does show the spinner: the new lines can take seconds and
    // nothing else on screen indicates work is happening.
    if (load.resetView || load.drill !== prevLoad?.drill) setLoading(true);
    setError(null);

    // Category data is fetched drilled or not — the drilled category's band is
    // just hidden, and Total still needs its numbers. The circuit fetch is a
    // second, independently-cached request, so toggling a drill off and on again
    // is a pure cache hit on both.
    Promise.all([
      fetchSeriesCached(load.fromMs, load.toMs, load.interval),
      load.drill
        ? fetchSeriesCached(
            load.fromMs,
            load.toMs,
            // A drill multiplies the row count by the circuit count; coarsen
            // the bucket if that would blow the per-fetch point budget.
            drillInterval(load.interval, load.fromMs, load.toMs),
            load.drill,
          )
        : Promise.resolve<SeriesPoint[]>([]),
    ])
      .then(([data, drillData]) => {
        const chart = chartRef.current;
        if (cancelled || !chart || !chartAliveRef.current || chart !== chartAtStart)
          return;

        const { byCat, totalByTime, sortedTimes } = shapeData(data);
        // Drilled series get their own time axis: their fetch may have been
        // coarsened, so their bucket stamps needn't line up with the categories'.
        const drilled = shapeData(drillData);
        const drillNames = Array.from(drilled.byCat.keys()).sort((a, b) =>
          a.localeCompare(b),
        );

        // Sentinels pin the axis to exactly the loaded window so pan/zoom has
        // the full padding to move through, even when bucket alignment leaves
        // the first/last point inside it.
        const outerFromSec = Math.floor(load.fromMs / 1000) as UTCTimestamp;
        const outerToSec = Math.floor(load.toMs / 1000) as UTCTimestamp;
        dataRef.current = { byCat, sortedTimes, outerFromSec, outerToSec };

        // setData rescales the time axis, so an extension has to put the
        // user's view back exactly where it was.
        const keep = load.resetView
          ? null
          : chart.timeScale().getVisibleRange();

        try {
          reconcileCircuitSeries(
            chart,
            circuitSeriesRef.current,
            drillNames,
            categoryColor(load.drill ?? ""),
          );
          for (const name of drillNames) {
            const series = circuitSeriesRef.current.get(name);
            if (!series) continue;
            const pts = padBounds(
              pointsFor(drilled.sortedTimes, drilled.byCat.get(name)),
              outerFromSec,
              outerToSec,
            );
            try { series.setData(toChartData(pts)); }
            catch (e) { console.warn(`setData failed for circuit ${name}`, e); }
          }
          setCircuitNames(drillNames);

          try {
            totalSeriesRef.current?.setData(
              toChartData(padBounds(pointsFor(sortedTimes, totalByTime), outerFromSec, outerToSec)),
            );
          } catch (e) {
            console.warn("setData failed for Total", e);
          }
          // Bands and the Total line's visibility come from the selection.
          // Total is hidden inside a drill: Lights' circuits are ~0.2 kW and a
          // 5 kW dotted reference flattens them into noise along the axis.
          applyStack(offRef.current, load.drill);

          // Show the preset window (a slice of the loaded one) on a reset;
          // restore the pre-setData view on an extension.
          chart.timeScale().setVisibleRange(
            keep ?? {
              from: toDisplay(Math.floor(load.viewFromMs / 1000)),
              to: toDisplay(Math.floor(load.viewToMs / 1000)),
            },
          );
        } catch (e) {
          console.error("PowerChart apply failed", e);
        } finally {
          extendingRef.current = false;
          setLoading(false);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("PowerChart fetch failed:", e);
        extendingRef.current = false;
        // An extension failure is silent: the chart keeps the data it has, and
        // loadRef goes back to matching it so the edge can be retried.
        if (!load.resetView) loadRef.current = prevLoad;
        if (load.resetView) {
          setError(
            "Couldn't load this range — try a narrower window or coarser bucket.",
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // applyStack reads refs; the selection comes from offRef. Not deps (loaded window only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Selection toggle: redraw the stack and visibility from the already loaded
  // data — no refetch, no setVisibleRange, so the current zoom is kept.
  useEffect(() => {
    applyStack(state.off, state.drill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializeOff(state.off), state.drill]);

  // Drilled circuits are listed under their category, capped so a big category
  // (Else can be 10+) can't push the label stack over the plot area. Shades are
  // regenerated from the same sorted names the series were built from, so a
  // legend swatch always matches its line.
  const drillShades = circuitShades(
    categoryColor(state.drill ?? ""),
    circuitNames.length,
  );
  const shownCircuits = state.drill ? circuitNames.slice(0, LEGEND_MAX_CIRCUITS) : [];
  const hiddenCircuitCount = state.drill
    ? circuitNames.length - shownCircuits.length
    : 0;

  // Top of the stack first, so the legend reads like the bands look.
  const legend: LegendEntry[] = [
    ...(!showTotal(state.off) || state.drill
      ? []
      : [{ label: "Total", color: TOTAL_COLOR, dotted: true }]),
    ...chartCategories(state.off)
      .slice()
      .reverse()
      .flatMap((c): LegendEntry[] =>
        c === state.drill
          ? [
              { label: c, color: categoryColor(c), header: true },
              ...shownCircuits.map((name, i) => ({
                label: name,
                color: drillShades[i] ?? categoryColor(c),
                indent: true,
              })),
              ...(hiddenCircuitCount > 0
                ? [
                    {
                      label: `+${hiddenCircuitCount} more`,
                      color: categoryColor(c),
                      indent: true,
                      header: true,
                    },
                  ]
                : []),
            ]
          : [{ label: c, color: categoryColor(c), filled: true }],
      ),
  ];

  // Lanes read the chart's own scale so they stay pinned under the data
  // during a pan; laneTick forces this block to re-run per scale change.
  void laneTick;
  const laneChart = chartAliveRef.current ? chartRef.current : null;
  const laneBucketMs = intervalSeconds(state.interval) * 1000;
  const laneWidth = laneChart ? laneChart.timeScale().width() : 0;
  // getVisibleRange() returns null — and throws — before the chart has data.
  let range: { from: Time; to: Time } | null = null;
  try {
    range = laneChart?.timeScale().getVisibleRange() ?? null;
  } catch {
    range = null;
  }
  const laneVisible = range
    ? { fromMs: fromDisplay(Number(range.from)) * 1000, toMs: fromDisplay(Number(range.to)) * 1000 }
    : { fromMs: state.fromMs, toMs: state.toMs };

  // timeToCoordinate only resolves times that are actual points on the series,
  // and run/event boundaries are rarely bucket-aligned. Rather than probe per
  // block, resolve two bucket anchors near the visible edges once per render
  // and derive one affine time→x map from them — the axis is index-linear, so
  // that is exact between real grid points and cheap (2 probes, not 3 per edge).
  const anchors = laneChart
    ? resolveAnchors(laneVisible.fromMs, laneVisible.toMs, laneBucketMs, (at) =>
        laneChart.timeScale().timeToCoordinate(toDisplay(at / 1000)),
      )
    : null;
  const xOf: XOf = (anchors && affineXOf(anchors[0], anchors[1])) ?? (() => null);

  return (
    <div className="relative">
      <div className="relative">
        <div
          ref={containerRef}
          className="h-[55vh] min-h-[280px] w-full touch-none sm:h-[420px]"
        />
        <div className="pointer-events-none absolute left-2 top-1 flex flex-col gap-0.5 text-[11px]">
          {legend.map((it) => (
            <div
              key={it.label}
              className={`flex items-center gap-1.5 ${it.indent ? "pl-3" : ""}`}
            >
              {it.filled ? (
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0"
                  style={{ background: it.color }}
                />
              ) : (
                <span
                  className="inline-block h-0 w-3.5 shrink-0"
                  style={
                    it.header
                      ? undefined
                      : {
                          borderTop: `${it.dotted ? "1px dotted" : "2px solid"} ${it.color}`,
                        }
                  }
                />
              )}
              <span className="text-zinc-500 dark:text-zinc-400">{it.label}</span>
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute right-1 top-0 text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          kW
        </div>
        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-50/60 backdrop-blur-[1px] dark:bg-zinc-950/60">
            <div className="flex items-center gap-2 rounded-full border border-zinc-300 bg-white/90 px-3 py-1.5 text-xs text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200">
              <Spinner />
              loading…
            </div>
          </div>
        )}
        {error && !loading && (
          <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-center">
            <div className="rounded-md border border-red-300 bg-red-50/95 px-3 py-1.5 text-xs text-red-800 shadow-sm dark:border-red-900/60 dark:bg-red-950/80 dark:text-red-200">
              {error}
            </div>
          </div>
        )}
      </div>
      {eventsOn && laneWidth > 0 && (
        <EventLanes data={events} visible={laneVisible} xOf={xOf} width={laneWidth} />
      )}
    </div>
  );
}
