import { NextResponse } from "next/server";
import { cachedQueryTrendPeriod } from "@/lib/trendsQuery";
import { trendsPayload } from "@/lib/trendsPayload";
import { TREND_GRAINS, type TrendGrain } from "@/lib/trends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const grain = url.searchParams.get("grain") ?? "month";
  if (!TREND_GRAINS.includes(grain as TrendGrain)) {
    return NextResponse.json({ error: `invalid grain ${grain}` }, { status: 400 });
  }
  const periods = await trendsPayload(
    { grain: grain as TrendGrain, endKey: url.searchParams.get("end") },
    Date.now(),
    cachedQueryTrendPeriod,
  );
  const live = periods.length > 0 && !periods[periods.length - 1].complete;
  return NextResponse.json(
    { periods },
    {
      headers: {
        "Cache-Control": `public, max-age=${live ? 60 : 86400}, stale-while-revalidate=3600`,
      },
    },
  );
}
