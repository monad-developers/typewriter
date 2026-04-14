import { NextRequest, NextResponse } from "next/server";
import { getSimulator } from "~/lib/market-simulator";
import type { BucketSize } from "~/lib/types";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const instrument = params.get("instrument") ?? "GOLD-USDC";
  const bucket = (params.get("bucket") as BucketSize) || undefined;

  const simulator = getSimulator();
  const snapshot = simulator.getSnapshot(instrument, bucket);

  return NextResponse.json(snapshot);
}
