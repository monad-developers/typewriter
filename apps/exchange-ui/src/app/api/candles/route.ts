import { NextRequest, NextResponse } from "next/server";
import { getSimulator } from "~/lib/market-simulator";
import type { BucketSize } from "~/lib/types";

const VALID_BUCKETS = new Set<BucketSize>([
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
]);

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const instrument = params.get("instrument") ?? "GOLD-USDC";
  const bucket = (params.get("bucket") ?? "1h") as BucketSize;
  const before = params.get("before")
    ? Number(params.get("before"))
    : undefined;
  const count = Math.min(Number(params.get("count") ?? 200), 1000);

  if (!VALID_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }

  const simulator = getSimulator();
  const result = simulator.getCandles(instrument, bucket, before, count);

  return NextResponse.json(result);
}
