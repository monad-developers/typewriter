import { NextRequest, NextResponse } from "next/server";
import { getSimulator } from "~/lib/market-simulator";

export async function GET(request: NextRequest) {
  const instrument =
    request.nextUrl.searchParams.get("instrument") ?? "GOLD-USDC";

  const simulator = getSimulator();
  const snapshot = simulator.getSnapshot(instrument);

  return NextResponse.json(snapshot);
}
