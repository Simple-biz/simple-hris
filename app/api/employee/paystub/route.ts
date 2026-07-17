import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { listPaymentDispatches } from "@/lib/supabase/payment-dispatches";
import {
  getPaystubDispatchEntry,
  listPaystubEntriesForEmployee,
  listPaystubPayloadsForEmployee,
} from "@/lib/supabase/paystub-dispatch-queue";
import { mapPayloadToPayStub } from "@/lib/payroll/paystub-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Employee self-serve pay-stub reader. Always scoped to the CALLER's own pay via
 * the NextAuth session email — never a query param — so one employee can't read
 * another's statement. A stub is only ever returned for a week the caller was
 * actually PAID (a `payment_dispatches` row with status='paid'), matching the
 * "only paid/emailed weeks" rule the Overview button enforces.
 *
 * Three modes:
 *   • ?source_file=<file>  → the full paystub for that week (drives the modal).
 *   • ?all=1               → { stubs: [{ sourceFile, paidAt, view }] } every paid
 *                            week's full statement (drives the Pay Stubs profile
 *                            tab's list + all-weeks PDF/XLSX export).
 *   • (no params)          → { weeks: [...] } every week the caller can open
 *                            (drives the Overview button's enabled state).
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string | null } | undefined)?.email
    ?.trim()
    .toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const sourceFile = req.nextUrl.searchParams.get("source_file")?.trim();

  // ── Single-week mode: return the paystub for one paid week ────────────────
  if (sourceFile) {
    const { rows: dispatches } = await listPaymentDispatches({ recipientEmail: email });
    const paid = dispatches.find(
      (r) => r.status === "paid" && r.cycle_source_file === sourceFile,
    );
    if (!paid) {
      return NextResponse.json({ paystub: null, available: false, paidAt: null });
    }

    const { row: staged } = await getPaystubDispatchEntry(sourceFile, email);
    if (!staged?.payload) {
      return NextResponse.json({ paystub: null, available: false, paidAt: null });
    }

    const paystub = mapPayloadToPayStub(staged.payload, staged.pay_period);
    return NextResponse.json({
      paystub,
      available: true,
      paidAt: paid.sent_date ?? null,
      status: "paid",
    });
  }

  // ── All-weeks mode: full statement for every paid week ────────────────────
  // Drives the Pay Stubs profile tab (list of weeks + PDF/XLSX export). Same
  // paid ∩ staged gate as list mode — an employee only ever sees statements for
  // weeks they were actually paid.
  if (req.nextUrl.searchParams.get("all")) {
    const [{ rows: dispatches }, { rows: payloads }] = await Promise.all([
      listPaymentDispatches({ recipientEmail: email }),
      listPaystubPayloadsForEmployee(email),
    ]);

    // Latest paid sent_date per cycle (a cycle can have >1 dispatch row).
    const paidAtByFile = new Map<string, string | null>();
    for (const r of dispatches) {
      if (r.status === "paid" && r.cycle_source_file) {
        const prev = paidAtByFile.get(r.cycle_source_file);
        const next = r.sent_date ?? null;
        if (!paidAtByFile.has(r.cycle_source_file) || (next && (!prev || next > prev))) {
          paidAtByFile.set(r.cycle_source_file, next);
        }
      }
    }

    const stubs = payloads
      .filter((p) => p.payload && paidAtByFile.has(p.cycle_source_file))
      .map((p) => ({
        sourceFile: p.cycle_source_file,
        paidAt: paidAtByFile.get(p.cycle_source_file) ?? null,
        view: mapPayloadToPayStub(p.payload, p.pay_period),
      }))
      // Most recent week first.
      .sort((a, b) => (b.view.weekEnd ?? "").localeCompare(a.view.weekEnd ?? ""));

    return NextResponse.json({ stubs });
  }

  // ── List mode: which weeks can this employee open? ────────────────────────
  const [{ rows: dispatches }, { rows: staged }] = await Promise.all([
    listPaymentDispatches({ recipientEmail: email }),
    listPaystubEntriesForEmployee(email),
  ]);

  const paidFiles = new Set(
    dispatches
      .filter((r) => r.status === "paid" && r.cycle_source_file)
      .map((r) => r.cycle_source_file as string),
  );
  const stagedFiles = new Set(staged.map((r) => r.cycle_source_file));
  const weeks = [...paidFiles].filter((f) => stagedFiles.has(f));

  return NextResponse.json({ weeks });
}
