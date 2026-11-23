// Shared two-sided axis for the /trends chart: house layers stack above zero,
// the car hangs below, one kWh (or $) per pixel on both sides. Pure.

import { costForKwh } from "./rates";
import { projectionFactor } from "./trends";
import type { TrendBar } from "./trendsPayload";
import type { TrendUnit } from "./whereItWent";

export type TrendAxis = {
  upMax: number;
  downMax: number;
  step: number;
  /** Signed, ascending, from -downMax to upMax in `step`s (car side negative). */
  ticks: number[];
};

const EPS = 1e-9;

/** Smallest of 1/2/2.5/5/10 × 10^n that is ≥ raw. */
export function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw - EPS * mag)! * mag;
}

/** Axis for the shown periods. An in-progress period counts at its projected
 *  full-period size, on both sides. The base charge is not drawn, so it is
 *  not included. */
export function trendAxis(periods: TrendBar[], unit: TrendUnit): TrendAxis {
  const v = (kwh: number) => (unit === "usd" ? costForKwh(kwh) : kwh);
  let up = 0;
  let down = 0;
  for (const p of periods) {
    const f = projectionFactor(p) ?? 1;
    up = Math.max(up, v(p.layers.houseKwh) * f);
    down = Math.max(down, v(p.layers.car) * f);
  }
  const big = Math.max(up, down);
  if (big <= 0) return { upMax: 1, downMax: 0, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const step = niceStep(big / 4);
  const stepsUp = Math.max(1, Math.ceil(up / step - EPS));
  const stepsDown = down > 0 ? Math.ceil(down / step - EPS) : 0;
  const ticks: number[] = [];
  for (let i = -stepsDown; i <= stepsUp; i++) ticks.push(i === 0 ? 0 : i * step); // never -0
  return { upMax: stepsUp * step, downMax: stepsDown * step, step, ticks };
}

/** y pixel for a value on the two-sided axis; car values are passed negative. */
export function axisY(axis: TrendAxis, value: number, top: number, height: number): number {
  return top + ((axis.upMax - value) / (axis.upMax + axis.downMax)) * height;
}
