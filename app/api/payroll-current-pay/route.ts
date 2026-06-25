import { NextRequest, NextResponse } from "next/server";
import { computeCurrentPay } from "@/lib/payroll/current-pay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  // `?source_file=` lets Payment Dispatch compute a PAST pay week instead of the
  // live cycle. Absent / blank → the current `is_current` cycle (default).
  const sourceFileRaw = req.nextUrl.searchParams.get("source_file");
  const sourceFile = sourceFileRaw?.trim() ? sourceFileRaw.trim() : null;
  try {
    const result = await computeCurrentPay(sourceFile ? { sourceFile } : undefined);
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
