// The explorer's client-side state machine. Pure (no React, no DOM) so the
// interactions between the range, the bucket, the selection and the expanded
// rows can be tested directly — ExplorerClient just wires it to useReducer.

import type { BucketKey } from "@/components/BucketSelector";
import {
  autoInterval,
  isIntervalAllowed,
  RANGE_PRESETS,
  type RangePreset,
} from "./interval";
import { CATEGORY_ORDER } from "./drill";
import type { OffSet } from "./selection";
import type { DashState } from "./url-state";

export type ViewState = DashState;

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
  | { type: "expand"; category: string }
  | { type: "events"; on: boolean };

/** Seed the reducer from a parsed URL. */
export const initView = (s: DashState): ViewState => s;

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
    case "select":
      return { ...s, off: a.off };
    case "expand":
      // Toggle one category's circuit rows; the selection is untouched.
      return {
        ...s,
        expanded: CATEGORY_ORDER.filter((c) =>
          c === a.category ? !s.expanded.includes(c) : s.expanded.includes(c),
        ),
      };
    case "events":
      return { ...s, events: a.on };
  }
}
