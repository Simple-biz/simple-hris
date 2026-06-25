import { NextRequest, NextResponse } from "next/server";
import { computeCurrentPay } from "@/lib/payroll/current-pay";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireRateVisibilityOrFeatureEdit } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  // Returns full per-employee payroll (rates, OT, bonuses, totals) for a whole
  // cycle — and with `?source_file=` for ANY past cycle — so it must be gated.
  // Access = rate-visible roles (admin / accounting / ceo) OR anyone an admin
  // granted Edit on Payment Dispatch. Same gate as the other dispatch-queue
  // reads, so a caller can't pass one endpoint and 403 another.
  const authz = await requireRateVisibilityOrFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);

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
