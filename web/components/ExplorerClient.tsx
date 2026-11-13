"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { PowerChart, type VisibleChange } from "./PowerChart";
import { TimeNav } from "./TimeNav";
import { COPY as TRENDS_COPY } from "@/lib/trendsCopy";
import { BucketSelector } from "./BucketSelector";
import { QuickFilters } from "./QuickFilters";
import { FocusToggle } from "./FocusToggle";
import { BreakdownTable } from "./BreakdownTable";
import { OverviewStrip } from "./OverviewStrip";
import { EventList } from "./EventList";
import { stepWindow } from "@/lib/brush";
import { initView, reducer } from "@/lib/viewState";
import { buildIntentSearch, type DashState } from "@/lib/url-state";
import { fetchEnergyCached, fetchEventsCached, seedEnergy } from "@/lib/clientFetch";
import { mergeDrillRows } from "@/lib/energyWindow";
import { MODES_MAX_WINDOW_MS, type EventsPayload } from "@/lib/eventRuns";
import type { EnergyRow } from "@/lib/queryCache";

// Header range label — pinned to Pacific so server and client render the same
// string (no hydration mismatch) and it matches the chart axis.
const headerFmt = (ms: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));

export function ExplorerClient({
  initial,
  initialEnergy,
  buildTime,
}: {
  initial: DashState;
  initialEnergy: EnergyRow[];
  buildTime?: string;
}) {
  const [view, dispatch] = useReducer(reducer, initial, initView);

  // Seed the energy cache once with the SSR rows so the first table render needs
  // no client round-trip.
  const seeded = useRef(false);
  if (!seeded.current) {
    seedEnergy(initial.fromMs, initial.toMs, initialEnergy);
    seeded.current = true;
  }

  // Visible sub-window — what the chart currently shows. Equals the preset
  // window on a preset/bucket change; pan/zoom moves it around inside the
  // chart's padded load window. Drives the header + table so both follow.
  const [visible, setVisible] = useState({
    fromMs: initial.fromMs,
    toMs: initial.toMs,
  });
  // Reset the visible window to the preset window whenever the range or bucket
  // changes (preset/bucket click).
  useEffect(() => {
    setVisible({ fromMs: view.fromMs, toMs: view.toMs });
  }, [view.fromMs, view.toMs, view.interval]);
  const onVisibleChange: VisibleChange = (fromMs, toMs) =>
    setVisible({ fromMs, toMs });

  // Intent-only URL — preset + filter, never the pan/zoom window. replaceState
  // (not router) so there's no server navigation.
  useEffect(() => {
    const search = buildIntentSearch(
      view.rangePreset,
      view.show,
      view.drill,
      view.events,
    );
    window.history.replaceState(null, "", search ? `/?${search}` : "/");
  }, [view.rangePreset, view.show, view.drill, view.events]);

  // Breakdown table — cache-backed energy fetch for the visible window.
  const [rows, setRows] = useState<EnergyRow[]>(initialEnergy);
  const [tableLoading, setTableLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setTableLoading(true);
    fetchEnergyCached(visible.fromMs, visible.toMs)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setTableLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible.fromMs, visible.toMs]);

  // Drilled circuit rows — a separate request from the category rows above, so
  // the category table stays a cache hit while a drill is toggled on and off.
  const [circuitRows, setCircuitRows] = useState<EnergyRow[]>([]);
  useEffect(() => {
    if (!view.drill) {
      setCircuitRows([]);
      return;
    }
    let cancelled = false;
    fetchEnergyCached(visible.fromMs, visible.toMs, view.drill)
      .then((r) => {
        if (!cancelled) setCircuitRows(r);
      })
      .catch(() => {
        if (!cancelled) setCircuitRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible.fromMs, visible.toMs, view.drill]);

  // Events layer — mode runs + bath/charge events for the visible window. No
  // fetch while the Events chip is off.
  const [events, setEvents] = useState<EventsPayload | null>(null);
  const [eventsError, setEventsError] = useState(false);
  useEffect(() => {
    if (!view.events) {
      // Drop the payload rather than keeping it: panning while the chip is off
      // would otherwise re-render stale blocks for the old window for one pass
      // when the chip comes back on.
      setEvents(null);
      setEventsError(false);
      return;
    }
    let cancelled = false;
    // Pad toward ~3× the visible window, matching the chart's own load padding,
    // so the lanes stay populated while panning inside the loaded data. The pad
    // is capped so the request never crosses the 62-day mode cap: a ≤62-day view
    // must not lose its HP-mode runs to `modesTruncated` just from padding.
    const span = visible.toMs - visible.fromMs;
    const pad = Math.min(span, Math.max(0, (MODES_MAX_WINDOW_MS - span) / 2));
    const evFrom = Math.max(0, visible.fromMs - pad);
    const evTo = Math.min(Date.now(), visible.toMs + pad);
    fetchEventsCached(evFrom, evTo)
      .then((d) => {
        if (!cancelled) {
          setEvents(d);
          setEventsError(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvents(null);
          setEventsError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible.fromMs, visible.toMs, view.events]);

  const filtered =
    view.show.length === 0
      ? rows
      : rows.filter(
          (r) =>
            view.show.includes(r.category) ||
            (r.parent !== undefined && view.show.includes(r.parent)),
        );
  const tableRows = mergeDrillRows(filtered, circuitRows, view.drill);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 sm:gap-6 sm:p-6">
      <header className="focus-hide flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">SPAN — power explorer</h1>
          <a href="/trends" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
            {TRENDS_COPY.trendsLink}
          </a>
        </div>
        <div className="flex flex-col text-xs text-zinc-500 sm:items-end">
          <div>
            {headerFmt(visible.fromMs)} → {headerFmt(visible.toMs)}
          </div>
          {buildTime && (
            <div className="text-[10px] text-zinc-400">build {buildTime} PT</div>
          )}
        </div>
      </header>

      <div className="focus-hide">
        <TimeNav
          range={view.rangePreset}
          fromMs={view.fromMs}
          toMs={view.toMs}
          onPreset={(preset) =>
            dispatch({ type: "preset", preset, now: Date.now() })
          }
          onStep={(dir) => {
            // Step the *visible* window (what you're looking at), clamped at
            // `now` on the right — same clamp the brush uses.
            const now = Date.now();
            const next = stepWindow(visible, dir, {
              fromMs: 0,
              toMs: Math.max(now, visible.toMs),
            });
            dispatch({ type: "window", ...next, now });
          }}
        />
      </div>

      <div className="focus-hide">
        <BucketSelector
          interval={view.interval}
          intervalAuto={view.intervalAuto}
          fromMs={view.fromMs}
          toMs={view.toMs}
          onSelect={(key) => dispatch({ type: "bucket", key })}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="focus-hide min-w-0 flex-1">
          <QuickFilters
            show={view.show}
            onChange={(show) => dispatch({ type: "show", show })}
            drill={view.drill}
            onDrill={(category) => dispatch({ type: "drill", category })}
            events={view.events}
            onEvents={(on) => dispatch({ type: "events", on })}
          />
        </div>
        <FocusToggle />
      </div>

      <PowerChart
        state={view}
        onVisibleChange={onVisibleChange}
        events={events}
        eventsOn={view.events}
      />

      {/* All-history overview: the brush follows `visible` (so preset clicks and
          pan/zoom move it too) and dragging it loads an arbitrary window. */}
      <div className="focus-hide">
        <OverviewStrip
          fromMs={visible.fromMs}
          toMs={visible.toMs}
          onChange={(fromMs, toMs) =>
            dispatch({ type: "window", fromMs, toMs, now: Date.now() })
          }
        />
      </div>

      <div className="focus-hide">
        {tableLoading && rows.length === 0 ? (
          <div className="h-32 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900" />
        ) : (
          <BreakdownTable rows={tableRows} />
        )}
      </div>

      {view.events && (
        <div className="focus-hide">
          <EventList
            data={events}
            error={eventsError}
            visible={visible}
            onZoom={(fromMs, toMs) =>
              dispatch({ type: "window", fromMs, toMs, now: Date.now() })
            }
          />
        </div>
      )}
    </main>
  );
}
