"use client";

import { useEffect, useRef, useState } from "react";
import { TrendsChart } from "./TrendsChart";
import { WhereItWent } from "./WhereItWent";
import { DATA_START_MS, TREND_GRAINS, shiftEndKey, TREND_WINDOW, type TrendGrain } from "@/lib/trends";
import { buildTrendsSearch, type TrendsState } from "@/lib/trendsUrl";
import type { TrendBar } from "@/lib/trendsPayload";
import type { TrendUnit } from "@/lib/whereItWent";
import { COPY } from "@/lib/trendsCopy";

const viewKey = (grain: TrendGrain, endKey: string | null) => `${grain}|${endKey ?? ""}`;

const btn = (active: boolean) =>
  `rounded px-2.5 py-1 text-sm ${
    active
      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
      : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
  } disabled:opacity-40 disabled:hover:bg-transparent`;

/** Bars plus the grain they were fetched for — rendered together so a pending
 *  or failed fetch never draws one grain's bars under another's labels. */
type Shown = { grain: TrendGrain; periods: TrendBar[] };

export function TrendsClient({
  initial,
  initialPeriods,
}: {
  initial: TrendsState;
  /** null when the SSR query failed; the client retries on mount. */
  initialPeriods: TrendBar[] | null;
}) {
  const [state, setState] = useState(initial);
  const [unit, setUnit] = useState<TrendUnit>("kwh");
  const cache = useRef(
    new Map<string, TrendBar[]>(
      initialPeriods ? [[viewKey(initial.grain, initial.endKey), initialPeriods]] : [],
    ),
  );
  const [shown, setShown] = useState<Shown>({ grain: initial.grain, periods: initialPeriods ?? [] });
  const [status, setStatus] = useState<"ok" | "loading" | "error">("ok");
  const periods = shown.periods;

  useEffect(() => {
    const qs = buildTrendsSearch(state);
    window.history.replaceState(null, "", qs ? `/trends?${qs}` : "/trends");
  }, [state]);

  useEffect(() => {
    const k = viewKey(state.grain, state.endKey);
    const hit = cache.current.get(k);
    if (hit) {
      setShown({ grain: state.grain, periods: hit });
      setStatus("ok");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    const q = new URLSearchParams({ grain: state.grain, ...(state.endKey ? { end: state.endKey } : {}) });
    fetch(`/api/trends?${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { periods: TrendBar[] }) => {
        cache.current.set(k, d.periods);
        if (!cancelled) {
          setShown({ grain: state.grain, periods: d.periods });
          setStatus("ok");
        }
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [state.grain, state.endKey]);

  // Arrows act on what's on screen; disabled until the requested view loads.
  const settled = status === "ok" && shown.grain === state.grain;
  const atFirst = periods.length > 0 && periods[0].fromMs <= DATA_START_MS;
  const anchor = state.endKey ?? periods[periods.length - 1]?.key;
  const shift = (n: number) => {
    if (!anchor) return;
    const now = Date.now();
    const next = shiftEndKey(anchor, state.grain, n, now);
    const current = shiftEndKey(next, state.grain, 1_000, now);
    setState((s) => ({ ...s, endKey: next === current ? null : next, selKey: null }));
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 sm:gap-6 sm:p-6">
      <header className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{COPY.title}</h1>
        <a href="/" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
          {COPY.explorerLink}
        </a>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1" role="group">
          {TREND_GRAINS.map((g) => (
            <button
              key={g}
              className={btn(state.grain === g)}
              onClick={() => setState({ grain: g, endKey: null, selKey: null })}
            >
              {COPY.grains[g]}
            </button>
          ))}
        </div>
        {state.grain !== "year" && (
          <div className="flex gap-1">
            <button className={btn(false)} disabled={!settled || atFirst} onClick={() => shift(-TREND_WINDOW)}>
              {COPY.prev}
            </button>
            <button className={btn(false)} disabled={!settled || state.endKey === null} onClick={() => shift(TREND_WINDOW)}>
              {COPY.next}
            </button>
          </div>
        )}
        <div className="flex gap-1" role="group">
          {(["kwh", "usd"] as const).map((u) => (
            <button key={u} className={btn(unit === u)} onClick={() => setUnit(u)}>
              {COPY.units[u]}
            </button>
          ))}
        </div>
        {status === "loading" && <span className="text-xs text-zinc-500">{COPY.loading}</span>}
        {status === "error" && <span className="text-xs text-red-600">{COPY.error}</span>}
      </div>

      <div className="flex flex-col gap-6 min-[760px]:flex-row">
        <div className="min-w-0 flex-1">
          <TrendsChart
            periods={periods}
            grain={shown.grain}
            unit={unit}
            selKey={state.selKey}
            onSelect={(selKey) => setState((s) => ({ ...s, selKey }))}
          />
          <p className="mt-2 text-xs text-zinc-500">{COPY.clearSelection}</p>
        </div>
        <div className="min-[760px]:w-80">
          <WhereItWent periods={periods} selKey={state.selKey} unit={unit} grain={shown.grain} />
        </div>
      </div>
    </main>
  );
}
