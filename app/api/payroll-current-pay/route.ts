import { NextResponse } from "next/server";
import { computeCurrentPay } from "@/lib/payroll/current-pay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const result = await computeCurrentPay();
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        period: { start: null, end: null, sourceFile: null },
        fxRate: 0,
        byEmail: {},
        error: msg,
      },
      { status: 500 },
    );
  }
}
