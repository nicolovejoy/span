import { categoryLabel } from "@/lib/explorerCopy";
import { costForKwh, proratedBaseCharge } from "@/lib/rates";
import {
  computeDelta,
  periodLabel,
  prevPeriodLabel,
  previousPeriodStart,
} from "@/lib/energyWindow";
import type { EnergyRow } from "@/lib/queryCache";

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

/** Δ cell — snapped period vs the prior period's matching span, signed and
 *  colored (red = more usage, green = less). Absolute kWh first; percent only
 *  when the prior period is big enough for one to be honest. */
function DeltaCell({
  kwh,
  prevPeriodKwh,
}: {
  kwh: number;
  prevPeriodKwh: number | undefined;
}) {
  const delta = computeDelta(kwh, prevPeriodKwh);
  if (delta.kind === "none") {
    return <span className="text-zinc-400">—</span>;
  }
  const up = delta.kwh > 0;
  const color = up ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400";
  const sign = up ? "+" : "";
  return (
    <span className={color}>
      {`${sign}${delta.kwh.toFixed(1)}`}
      {delta.percent !== undefined && (
        <span className="ml-1 text-zinc-400 dark:text-zinc-500">
          {`(${sign}${delta.percent.toFixed(0)}%)`}
        </span>
      )}
    </span>
  );
}

export function BreakdownTable({ rows }: { rows: EnergyRow[] }) {
  // Drill-down rows (#12) are children of a category row that is still present
  // as their subtotal, so they're excluded from every aggregate — counting both
  // would double the total and break Share.
  const categoryRows = rows.filter((r) => !r.parent);
  // Only include non-negative kWh in the total — a negative would mean
  // bad upstream data and would poison the Share column.
  const total = categoryRows.reduce((acc, r) => (r.kwh > 0 ? acc + r.kwh : acc), 0);
  const totalCost = categoryRows.reduce(
    (acc, r) => (r.kwh > 0 ? acc + costForKwh(r.kwh) : acc),
    0,
  );
  // Snap metadata is the same on every row (carried by the API for exactly
  // this) — read it off the first row rather than threading separate props
  // through ExplorerClient.
  const periodFromMs = rows[0]?.periodFromMs;
  const periodToMs = rows[0]?.periodToMs;
  const periodGrain = rows[0]?.periodGrain;
  const periodComplete = rows[0]?.periodComplete;
  const baseCharge =
    periodFromMs !== undefined && periodToMs !== undefined
      ? proratedBaseCharge(periodToMs - periodFromMs)
      : 0;

  return (
    <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Category</th>
            <th className="px-3 py-2 text-right font-medium">
              {periodFromMs !== undefined && periodGrain !== undefined
                ? `kWh · ${periodLabel(periodFromMs, periodGrain)}${
                    periodComplete === false ? " · so far" : ""
                  }`
                : "kWh"}
            </th>
            <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">
              {periodFromMs !== undefined && periodGrain !== undefined
                ? prevPeriodLabel(previousPeriodStart(periodFromMs, periodGrain), periodGrain)
                : "Δ"}
            </th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            <th className="px-3 py-2 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.parent ?? ""}|${r.category}`}
              className={[
                "border-t border-zinc-100 dark:border-zinc-800",
                r.parent ? "text-xs text-zinc-600 dark:text-zinc-400" : "",
              ].join(" ")}
            >
              <td className={r.parent ? "py-1.5 pl-8 pr-3" : "px-3 py-2"}>
                {r.parent && <span className="mr-1.5 text-zinc-400">└</span>}
                {r.parent ? r.category : categoryLabel(r.category)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.kwh.toFixed(1)}</td>
              <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">
                <DeltaCell kwh={r.kwh} prevPeriodKwh={r.prevPeriodKwh} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(costForKwh(r.kwh))}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                {total > 0 ? `${((r.kwh / total) * 100).toFixed(0)}%` : "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-4 text-center text-zinc-500">
                No data in selected range.
              </td>
            </tr>
          )}
          {rows.length > 0 && (
            <>
              <tr className="border-t-2 border-zinc-300 font-medium dark:border-zinc-700">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{total.toFixed(1)}</td>
                <td className="hidden sm:table-cell"></td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(totalCost)}</td>
                <td className="px-3 py-2"></td>
              </tr>
              <tr className="border-t border-zinc-100 text-zinc-500 dark:border-zinc-800">
                <td className="px-3 py-2 text-xs">+ base charge</td>
                <td className="px-3 py-2"></td>
                <td className="hidden sm:table-cell"></td>
                <td className="px-3 py-2 text-right text-xs tabular-nums">{fmtUsd(baseCharge)}</td>
                <td className="px-3 py-2"></td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
