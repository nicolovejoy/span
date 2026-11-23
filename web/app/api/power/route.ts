import { NextResponse } from "next/server";
import { cachedQueryPower } from "@/lib/queryCache";
import { INTERVAL_ORDER, intervalSeconds, type IntervalKey } from "@/lib/interval";
import { isCategory } from "@/lib/categories";
import { powerCacheControl, wantsGrid } from "@/lib/powerCacheControl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isInterval = (v: string): v is IntervalKey =>
  (INTERVAL_ORDER as string[]).includes(v);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fromMs = Number(url.searchParams.get("from"));
  const toMs = Number(url.searchParams.get("to"));
  const intervalRaw = url.searchParams.get("interval") ?? "1h";
  // Optional: one series per circuit within this category instead of the five
  // category lines (#12). Absent = the original category response.
  const drill = url.searchParams.get("drill") ?? undefined;
  // `grid=0` skips the panel query and the Unmonitored series (the Overview
  // strip, which only sums the five categories).
  const grid = wantsGrid(url.searchParams.get("grid"));

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return NextResponse.json(
      { error: "invalid from/to (ms epoch, from < to required)" },
      { status: 400 },
    );
  }
  if (!isInterval(intervalRaw)) {
    return NextResponse.json({ error: `invalid interval ${intervalRaw}` }, { status: 400 });
  }
  if (drill !== undefined && !isCategory(drill)) {
    return NextResponse.json({ error: `invalid drill ${drill}` }, { status: 400 });
  }

  // Defensive quantize so unquantized clients still produce stable cache keys.
  const intervalMs = intervalSeconds(intervalRaw) * 1000;
  const qFromMs = Math.floor(fromMs / intervalMs) * intervalMs;
  const qToMs = Math.floor(toMs / intervalMs) * intervalMs;

  const { data, partial } = await cachedQueryPower({
    fromMs: qFromMs,
    toMs: qToMs,
    interval: intervalRaw,
    drill,
    grid,
  });

  // `partial` rides along only when set, so the payload is unchanged otherwise.
  return NextResponse.json(partial ? { data, partial: true } : { data }, {
    headers: {
      "Cache-Control": powerCacheControl({
        partial,
        toMs,
        intervalMs,
        nowMs: Date.now(),
      }),
    },
  });
}
