import { NextRequest, NextResponse } from "next/server";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { getFreshPaystubEntry } from "@/lib/payroll/paystub-fresh";
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
 * Freshness: for a NOT-yet-paid row it renders the staged payload with any newer
 * wizard-snapshot figures merged over it (`getFreshPaystubEntry`) — the same
 * source Payment Dispatch prices the row from, so the stub always matches the
 * amount the queue shows and the wizard's live values. For a PAID row it renders
 * the staged payload untouched: the mark-paid path persisted the exact as-paid
 * figures onto that row, and a historical statement must never drift after the
 * fact. Still no `computeCurrentPay` — one indexed row read + one app_settings
 * read, so opening stubs across the ~1000-row queue stays cheap. A week that was
 * never staged for this employee returns `available: false`.
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

  const fresh = await getFreshPaystubEntry(sourceFile, email);
  if (fresh.error) {
    return NextResponse.json(
      { paystub: null, available: false, paidAt: null, error: fresh.error },
      { status: 500 },
    );
  }
  const staged = fresh.staged;
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

  // Paid → the frozen as-paid record; unpaid → the freshest wizard figures.
  const paystub = paidAt
    ? mapPayloadToPayStub(staged.payload, staged.pay_period)
    : mapPayloadToPayStub(fresh.payload, fresh.payPeriod);
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
