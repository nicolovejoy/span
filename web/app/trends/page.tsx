import { TrendsClient } from "@/components/TrendsClient";
import { cachedQueryTrendPeriod } from "@/lib/trendsQuery";
import { trendsPayload } from "@/lib/trendsPayload";
import { parseTrendsState } from "@/lib/trendsUrl";

type SP = Promise<Record<string, string | string[] | undefined>>;

export const metadata = { title: "SPAN — trends" };

export default async function TrendsPage({ searchParams }: { searchParams: SP }) {
  const nowMs = Date.now();
  const initial = parseTrendsState(await searchParams, nowMs);
  try {
    const periods = await trendsPayload(initial, nowMs, cachedQueryTrendPeriod);
    return <TrendsClient initial={initial} initialPeriods={periods} />;
  } catch (e) {
    // Influx unreachable (e.g. a Cloudflare challenge): render the shell with
    // an error rather than Next's bare error page; the client can retry.
    console.error("[trends] SSR query failed", e);
    return <TrendsClient initial={initial} initialPeriods={null} />;
  }
}
