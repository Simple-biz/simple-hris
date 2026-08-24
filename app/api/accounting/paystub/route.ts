import { NextRequest, NextResponse } from "next/server";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { getFreshPaystubEntry } from "@/lib/payroll/paystub-fresh";
import { listPaymentDispatches } from "@/lib/supabase/payment-dispatches";
import {
  buildPaystubDispatchLog,
  paidSentDateFromLog,
  type PayStubDispatchEntry,
} from "@/lib/payroll/paystub-dispatch-log";
import { mapPayloadToPayStub, applyCopEquivalent } from "@/lib/payroll/paystub-view";
import { resolveCountryCurrencyForEmails, getUsdToCopRate } from "@/lib/payroll/cop-country";
import { getEmployeeMasterRecord } from "@/lib/supabase/employees";
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
 * Response shape matches the modal's expectation (same as the employee route),
 * plus the accounting-only dispatch log:
 *   { paystub: PayStubView | null, available: boolean, paidAt: string | null, status,
 *     dispatches: PayStubDispatchEntry[] }
 *
 * `dispatches` is every attempt logged against this week — paid, Not paid,
 * Threshold, Problem — carrying the clerk's free-text note. It answers "why
 * hasn't this gone out?" at the point accounting asks it. Internal by design: the
 * employee route never returns it.
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
  // Every dispatch logged for this (cycle, employee) — paid AND the non-paid
  // outcomes (Not paid / Threshold / Problem) with the clerk's note on each. The
  // paid date falls out of the same read.
  //
  // Read BEFORE the no-staged-payload bail-out: someone can be marked Threshold /
  // Problem in a week that was never staged for them (a catalog-paid person with
  // no rates row reaches the queue through buildStagedOnlyPlacement). Returning
  // the log there too means "View" still explains itself instead of showing a
  // bare "no statement available".
  let dispatchLog: PayStubDispatchEntry[] = [];
  let paidAt: string | null = null;
  try {
    const { rows: dispatches } = await listPaymentDispatches({ recipientEmail: email });
    dispatchLog = buildPaystubDispatchLog(dispatches, sourceFile);
    paidAt = paidSentDateFromLog(dispatchLog);
  } catch {
    /* best-effort — the statement still renders without a paid date or log */
  }

  const staged = fresh.staged;
  if (!staged?.payload) {
    return NextResponse.json({
      paystub: null,
      available: false,
      paidAt: null,
      dispatches: dispatchLog,
    });
  }

  // Paid → the frozen as-paid record; unpaid → the freshest wizard figures.
  let paystub = paidAt
    ? mapPayloadToPayStub(staged.payload, staged.pay_period)
    : mapPayloadToPayStub(fresh.payload, fresh.payPeriod);

  // COP-country payee (Colombian staff riding the PHP rails) → stamp the native
  // COP equivalent, the same USD-anchor figure Payment Dispatch pays. The
  // submission is keyed by the hire's personal email, so resolve through the
  // master record's aliases. Best-effort: on any failure the statement simply
  // renders without the COP line.
  try {
    const { employee: master } = await getEmployeeMasterRecord(email);
    const payloadEmail =
      staged.payload && typeof staged.payload.email === "string" ? staged.payload.email : null;
    const countryCurrency = await resolveCountryCurrencyForEmails([
      email,
      payloadEmail,
      master?.work_email,
      master?.personal_email,
      master?.alternate_work_email,
      master?.alternate_work_email_2,
    ]);
    if (countryCurrency === "COP") {
      paystub = applyCopEquivalent(paystub, await getUsdToCopRate());
    }
  } catch {
    /* best-effort — the statement still renders without the COP equivalent */
  }
  // Display pay date: real disbursement date, else the scheduled Tue (Kolan) /
  // Thu (wires) for this week + this employee's payout method.
  const processor = await resolveEmployeeProcessor([email]);
  return NextResponse.json({
    paystub,
    available: true,
    paidAt,
    payDate: resolvePayDateIso(paidAt, paystub.weekEnd, processor),
    status: paidAt ? "paid" : "issued",
    // Accounting-only: the clerk's dispatch notes for this week. The employee
    // route omits this field entirely, so the modal renders the panel for
    // accounting and stays exactly as it was for the self-serve view.
    dispatches: dispatchLog,
  });
}
