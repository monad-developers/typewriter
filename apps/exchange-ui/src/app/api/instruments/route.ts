import { INSTRUMENTS } from "~/lib/market-simulator";

export async function GET() {
  return Response.json({ instruments: INSTRUMENTS });
}
