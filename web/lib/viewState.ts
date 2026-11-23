// The explorer's client-side state machine. Pure (no React, no DOM) so the
// interactions between the range, the bucket, the selection and the drill can
// be tested directly — ExplorerClient just wires it to useReducer.

import type { BucketKey } from "@/components/BucketSelector";
import {
  autoInterval,
  isIntervalAllowed,
  RANGE_PRESETS,
  type RangePreset,
} from "./interval";
import { isOn, onlyThese, type OffSet } from "./selection";
import type { DashState } from "./url-state";

/** DashState plus the one piece of bookkeeping nothing downstream reads: the
 *  selection to put back when a drill is backed out. Kept out of DashState
 *  so it can't leak into the URL or the chart's props. */
export type ViewState = DashState & { offBeforeDrill: OffSet | null };

// Actions only change the *visible* window and the bucket. Pan/zoom never
// dispatches here — it explores within the (wider) window the chart has
// loaded and reports its visible sub-range separately (see ExplorerClient).
// `window` is the exception: the brush and the step buttons jump to an
// arbitrary historical window, which is a real load, not a pan.
export type Action =
  | { type: "preset"; preset: RangePreset; now: number }
  | { type: "window"; fromMs: number; toMs: number; now: number }
  | { type: "bucket"; key: BucketKey }
  | { type: "select"; off: OffSet }
  | { type: "drill"; category: string | null }
  | { type: "events"; on: boolean };

/** Seed the reducer from a parsed URL — nothing to restore yet. */
export const initView = (s: DashState): ViewState => ({
  ...s,
  offBeforeDrill: null,
});

export function reducer(s: ViewState, a: Action): ViewState {
  switch (a.type) {
    case "preset": {
      const fromMs = a.now - RANGE_PRESETS[a.preset];
      return {
        ...s,
        fromMs,
        toMs: a.now,
        rangePreset: a.preset,
        interval: autoInterval(fromMs, a.now),
        intervalAuto: true,
      };
    }
    case "window": {
      // Off-preset by construction: rangePreset null drops `range` from the
      // URL (intent-only — a brushed window is deliberately not restorable by
      // reload) and soft-highlights the nearest pill in TimeNav.
      const toMs = Math.min(a.toMs, a.now);
      const fromMs = Math.min(a.fromMs, toMs - 1);
      return {
        ...s,
        fromMs,
        toMs,
        rangePreset: null,
        // A manually-picked bucket is kept, unless the new (wider) window would
        // push it past MAX_BUCKETS — then auto takes back over rather than
        // firing a query that melts the Pi.
        interval:
          s.intervalAuto || !isIntervalAllowed(s.interval, fromMs, toMs)
            ? autoInterval(fromMs, toMs)
            : s.interval,
        intervalAuto:
          s.intervalAuto || !isIntervalAllowed(s.interval, fromMs, toMs),
      };
    }
    case "bucket":
      return a.key === "auto"
        ? { ...s, interval: autoInterval(s.fromMs, s.toMs), intervalAuto: true }
        : { ...s, interval: a.key, intervalAuto: false };
    case "select": {
      // Filtering the drilled category out of view backs out of the drill —
      // otherwise its circuits would keep drawing with no parent line. That's
      // the user overriding the focus below, so there's nothing left to restore.
      const dropped = !!s.drill && !isOn(a.off, s.drill);
      return {
        ...s,
        off: a.off,
        drill: dropped ? null : s.drill,
        offBeforeDrill: dropped ? null : s.offBeforeDrill,
      };
    }
    case "drill":
      // Focus. A drilled category's circuits are often an order of magnitude
      // smaller than a sibling line (Lights ~0.2 kW next to Car at 7 kW), and
      // they share one price scale — so a drill narrows the selection to the
      // drilled category and remembers what was there before. Backing out (✕ / re-tap)
      // restores it; switching straight to another category keeps the original
      // memory, so one back-out still returns to where you started.
      return a.category
        ? {
            ...s,
            drill: a.category,
            off: onlyThese([a.category]),
            offBeforeDrill: s.drill ? s.offBeforeDrill : s.off,
          }
        : {
            ...s,
            drill: null,
            off: s.offBeforeDrill ?? s.off,
            offBeforeDrill: null,
          };
    case "events":
      return { ...s, events: a.on };
  }
}
