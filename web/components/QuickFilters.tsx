"use client";

import { EXPLORER_COPY } from "@/lib/explorerCopy";

export function QuickFilters({
  events,
  onEvents,
}: {
  events: boolean;
  onEvents: (on: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <Chip active={events} onClick={() => onEvents(!events)} title={EXPLORER_COPY.eventsTitle}>
        {EXPLORER_COPY.events}
      </Chip>
    </div>
  );
}

export function Chip({
  active,
  dim,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  dim?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={[
        "rounded-full border px-3 py-1 text-xs transition-colors",
        active
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
          : dim
            ? "border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-600"
            : "border-zinc-300 text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
