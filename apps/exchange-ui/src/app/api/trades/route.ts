import type { NextRequest } from "next/server";
import { generateCandles, generateTrades } from "~/lib/data";

export async function GET(request: NextRequest) {
  const instrument =
    request.nextUrl.searchParams.get("instrument") ?? "GOLD-USDC";
  return Response.json({
    trades: generateTrades(instrument),
    candles: generateCandles(instrument),
  });
}
