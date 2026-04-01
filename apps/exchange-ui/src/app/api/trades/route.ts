import type { NextRequest } from "next/server";
import { getSimulator } from "~/lib/market-simulator";

export async function GET(request: NextRequest) {
  const instrument =
    request.nextUrl.searchParams.get("instrument") ?? "GOLD-USDC";
  const snapshot = getSimulator().getSnapshot(instrument);
  return Response.json({
    trades: snapshot.trades,
    candles: snapshot.candles,
  });
}
