import { NextResponse } from "next/server";
import { bridgeWizardAdjustment } from "@/lib/supabase/payroll-wizard-notes";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/payroll-wizard/notes/adjustment — the wizard → board half of the
 * Adjustment bridge. Body: { work_email, amount: number|null, worker_name? }.
 *
 * Called (debounced) when accounting edits an Additions "Adj." override, so
 * the worker's live-week Payroll Notes row carries the same adjustment —
 * updated in place, or created stamped like a hand-written line. amount=null
 * (override cleared) blanks the linked row's Adjustment text.
 *
 * Answers `{ skipped: "multiple_rows", amountRows }` when the worker already has
 * several amounts on the board this week: the wizard figure is their combined
 * total, so mirroring it into one row would double-count the others. The client
 * surfaces that instead of pretending the write happened.
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("accounting", "payroll_wizard");
  if (!authz.ok) return deniedResponse(authz);

  let body: { work_email?: unknown; amount?: unknown; worker_name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const workEmail = typeof body.work_email === "string" ? body.work_email.trim() : "";
  if (!workEmail) return NextResponse.json({ error: "work_email is required" }, { status: 400 });
  const amount =
    body.amount === null || body.amount === undefined
      ? null
      : typeof body.amount === "number" && Number.isFinite(body.amount)
        ? body.amount
        : undefined;
  if (amount === undefined) {
    return NextResponse.json({ error: "amount must be a finite number or null" }, { status: 400 });
  }

  const { row, created, error, skipped, amountRows } = await bridgeWizardAdjustment({
    workEmail,
    amount,
    sessionEmail: authz.sessionEmail,
    workerName: typeof body.worker_name === "string" ? body.worker_name : null,
  });
  if (error) return NextResponse.json({ error }, { status: 400 });

  if (row) {
    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: authz.roles[0] ?? "accounting",
      action: "accounting.payroll_wizard_notes.adjustment_bridged",
      resource: "payroll_wizard_notes",
      resource_id: row.id,
      details: { worker_email: workEmail.toLowerCase(), amount, created },
    });
  }

  return NextResponse.json({ row, created, skipped: skipped ?? null, amountRows: amountRows ?? null });
}
