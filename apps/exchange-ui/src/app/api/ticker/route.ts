import type { NextRequest } from "next/server";
import { generateTicker } from "~/lib/data";

export async function GET(request: NextRequest) {
  const instrument =
    request.nextUrl.searchParams.get("instrument") ?? "GOLD-USDC";
  return Response.json(generateTicker(instrument));
}
