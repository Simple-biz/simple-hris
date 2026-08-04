import { NextResponse } from "next/server";
import {
  insertBankExemption,
  listActiveBankExemptions,
  revokeBankExemption,
} from "@/lib/supabase/payroll-bank-exemptions";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess, requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Temporary Exemption" on Payroll Wizard → Readiness → Bank Info.
 *
 * An exemption acknowledges one person's missing payout details for ONE pay
 * week: readiness moves them off the Bank Info list (and out of the score's
 * bank dimension) and onto the Exceptions list. Week-scoped with no expiry job
 * — they reappear next week if their details are still missing.
 *
 * Readiness-only: Payment Dispatch never reads this table, so an exemption
 * changes nothing about whether the person can actually be paid.
 *
 * Same gates as the rest of the wizard: reading needs `view`, filing/undoing an
 * exemption needs `edit` (the same grant behind the "Set bank" / "Set rate"
 * inline fixers).
 */

/** GET — active exemptions for a week. `?week_start=YYYY-MM-DD` (required). */
export async function GET(req: Request) {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  const weekStart = new URL(req.url).searchParams.get("week_start") ?? "";
  const { rows, error } = await listActiveBankExemptions(weekStart);
  if (error) return NextResponse.json({ rows: [], error }, { status: 400 });
  return NextResponse.json({ rows });
}

/**
 * POST — file an exemption.
 * Body: { weekStart, name, workEmail?, personalEmail?, department?, reason? }
 *
 * Re-filing an already-active exemption is a no-op that returns the existing
 * row (see insertBankExemption) — a double-click must not stack duplicates that
 * would then each need their own Undo.
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("accounting", "payroll_wizard");
  if (!authz.ok) return deniedResponse(authz);

  let body: {
    weekStart?: unknown;
    name?: unknown;
    workEmail?: unknown;
    personalEmail?: unknown;
    department?: unknown;
    reason?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  const weekStart = str(body.weekStart);
  if (!weekStart) return NextResponse.json({ error: "weekStart is required" }, { status: 400 });

  const { row, error } = await insertBankExemption({
    weekStart,
    name: str(body.name) ?? "",
    workEmail: str(body.workEmail),
    personalEmail: str(body.personalEmail),
    department: str(body.department),
    // Free text, but bounded — this renders in the Exceptions list.
    reason: str(body.reason)?.slice(0, 300) ?? null,
    createdBy: authz.sessionEmail,
  });
  if (error || !row) {
    return NextResponse.json({ error: error ?? "Could not file the exemption" }, { status: 400 });
  }

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "accounting",
    action: "payroll.bank.exempted",
    resource: "payroll_bank_exemptions",
    resource_id: row.id,
    details: {
      person: row.name,
      work_email: row.work_email,
      personal_email: row.personal_email,
      department: row.department,
      week_start: row.week_start,
      reason: row.reason,
      source: "payroll_wizard_readiness",
    },
  });

  return NextResponse.json({ row });
}

/** DELETE — undo an exemption (soft delete). Body: { id }. */
export async function DELETE(req: Request) {
  const authz = await requireFeatureEdit("accounting", "payroll_wizard");
  if (!authz.ok) return deniedResponse(authz);

  let body: { id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { row, revoked, error } = await revokeBankExemption(id, authz.sessionEmail);
  if (error) return NextResponse.json({ error }, { status: 400 });
  // Already revoked (or never existed) — the end state the caller wanted is
  // already true, so this is a success, not a 404.
  if (revoked === 0) return NextResponse.json({ revoked: 0 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "accounting",
    action: "payroll.bank.exemption_undone",
    resource: "payroll_bank_exemptions",
    resource_id: id,
    details: {
      person: row?.name ?? null,
      work_email: row?.work_email ?? null,
      week_start: row?.week_start ?? null,
      source: "payroll_wizard_readiness",
    },
  });

  return NextResponse.json({ revoked });
}
