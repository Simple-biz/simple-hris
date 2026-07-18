import { NextRequest, NextResponse } from "next/server";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { getPaystubDispatchEntry } from "@/lib/supabase/paystub-dispatch-queue";
import { listPaymentDispatches } from "@/lib/supabase/payment-dispatches";
import { mapPayloadToPayStub } from "@/lib/payroll/paystub-view";
import { resolveEmployeeProcessor, resolvePayDateIso } from "@/lib/payroll/pay-schedule";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/accounting/paystub?source_file=<file>&email=<work email>
 *
 * Accounting-facing reader so the Payment Dispatch queue can OPEN any employee's
 * pay statement in the same modal the employee sees — without downloading. Unlike
 * the employee route (`/api/employee/paystub`, session-scoped to the caller), this
 * takes an explicit `email` and is RBAC-gated to the dispatch-queue audience.
 *
 * It is a STAGED-PAYLOAD read only (the exact per-employee `DispatchEmployee` the
 * wizard locked in): one indexed row read + `mapPayloadToPayStub`. No
 * `computeCurrentPay` — so opening a stub per row across the ~1000-row queue stays
 * cheap (no N+1 pay recomputation). A week that was never staged for this employee
 * returns `available: false`.
 *
 * Response shape matches the modal's expectation (same as the employee route):
 *   { paystub: PayStubView | null, available: boolean, paidAt: string | null, status }
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess("accounting", "payment_dispatch", "view");
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = req.nextUrl.searchParams.get("source_file")?.trim();
  const emailRaw = req.nextUrl.searchParams.get("email")?.trim();
  const email = emailRaw ? normEmail(emailRaw) ?? emailRaw.toLowerCase() : null;
  if (!sourceFile || !email) {
    return NextResponse.json(
      { paystub: null, available: false, paidAt: null, error: "Missing source_file or email" },
      { status: 400 },
    );
  }

  const { row: staged, error } = await getPaystubDispatchEntry(sourceFile, email);
  if (error) {
    return NextResponse.json({ paystub: null, available: false, paidAt: null, error }, { status: 500 });
  }
  if (!staged?.payload) {
    return NextResponse.json({ paystub: null, available: false, paidAt: null });
  }

  // Real paid date for this (cycle, employee), when Payment Dispatch has marked it.
  let paidAt: string | null = null;
  try {
    const { rows: dispatches } = await listPaymentDispatches({ recipientEmail: email });
    const paid = dispatches.find(
      (r) => r.status === "paid" && r.cycle_source_file === sourceFile,
    );
    paidAt = paid?.sent_date ?? null;
  } catch {
    /* best-effort — the statement still renders without a paid date */
  }

  const paystub = mapPayloadToPayStub(staged.payload, staged.pay_period);
  // Display pay date: real disbursement date, else the scheduled Tue (HuruPay) /
  // Thu (wires) for this week + this employee's payout method.
  const processor = await resolveEmployeeProcessor([email]);
  return NextResponse.json({
    paystub,
    available: true,
    paidAt,
    payDate: resolvePayDateIso(paidAt, paystub.weekEnd, processor),
    status: paidAt ? "paid" : "issued",
  });
}
