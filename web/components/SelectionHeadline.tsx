import { headline } from "@/lib/explorerCopy";
import type { SelectionSummary } from "@/lib/selectionSummary";

/** The selection's kWh, share of the whole house, and cost for the period. */
export function SelectionHeadline({
  summary,
  period,
}: {
  summary: SelectionSummary;
  period: string | null;
}) {
  const { main, detail } = headline(summary, period);
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-zinc-100 px-4 py-3 dark:bg-zinc-900 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="text-xl font-semibold tabular-nums">{main}</span>
      <span className="text-sm text-zinc-600 dark:text-zinc-400">{detail}</span>
    </div>
  );
}
