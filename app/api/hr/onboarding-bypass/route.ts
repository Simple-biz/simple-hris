import { NextResponse } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { WORK_EMAIL_DOMAIN } from "@/lib/hr/work-email";
import { verifyWorkspaceAccount } from "@/lib/hr/workspace-account";
import {
  createHrPendingEmployee,
  deleteHrPendingEmployee,
  findMasterRowByWorkEmail,
  markPendingHireOrientation,
  promoteHrPendingEmployee,
} from "@/lib/supabase/hr-pending-employees";
import { listPayStructures } from "@/lib/supabase/pay-structures-db";
import { DEPARTMENTS } from "@/lib/payroll/department-bonus";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/hr/onboarding-bypass
 *
 * "Bypass" / manual setup for a worker whose @simple.biz Google Workspace
 * account is ALREADY provisioned (set up outside the self-serve onboarding
 * flow). Instead of Generate link -> hire fills the form -> Set work email
 * (which CREATES the account), HR enters the worker's details here and we:
 *
 *   1. VERIFY (server-enforced) the Workspace account actually exists. The
 *      whole pipeline is BLOCKED unless verify returns 'exists' — we never
 *      create the account, so there must be one to attach to.
 *   2. Stage the hire in `hr_pending_employees` WITHOUT firing the
 *      create-workspace webhook (no duplicate account, no Hubstaff invite, no
 *      Roboform/Hubstaff onboarding emails — they're already set up).
 *   3. Stamp orientation as attended now (bypass implies they're already
 *      onboarded), which both satisfies the promote guard and sets Start Date.
 *   4. Promote straight into `global_master_list` + the master Google Sheet in
 *      one shot, reusing the exact same promote pipeline as every other hire.
 *
 * Body: { full_name, personal_email, department, work_email,
 *         phone?, location?, start_date? }
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("hr", "onboarding");
  if (!authz.ok) return deniedResponse(authz);

  let body: {
    full_name?: string;
    personal_email?: string;
    department?: string;
    work_email?: string;
    phone?: string | null;
    location?: string | null;
    start_date?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = (body.full_name ?? "").trim();
  const personalEmail = (body.personal_email ?? "").trim().toLowerCase();
  const department = (body.department ?? "").trim();
  const workEmail = (body.work_email ?? "").trim().toLowerCase();
  const phone = (body.phone ?? "")?.toString().trim() || null;
  const location = (body.location ?? "")?.toString().trim() || null;
  const startDate = (body.start_date ?? "")?.toString().trim() || null;

  if (!name) {
    return NextResponse.json({ error: "Full name is required." }, { status: 400 });
  }
  if (!EMAIL_RE.test(personalEmail)) {
    return NextResponse.json({ error: "Enter a valid personal email." }, { status: 400 });
  }
  if (!department) {
    return NextResponse.json({ error: "Department is required." }, { status: 400 });
  }
  if (!EMAIL_RE.test(workEmail)) {
    return NextResponse.json({ error: "Enter a valid work email." }, { status: 400 });
  }
  if (!workEmail.endsWith(`@${WORK_EMAIL_DOMAIN}`)) {
    return NextResponse.json(
      { error: `Work email must be on @${WORK_EMAIL_DOMAIN}.` },
      { status: 400 },
    );
  }

  // ── 1. VERIFY GATE (server-enforced, never trusts the client) ────────────
  // Bypass is ONLY for accounts that already exist — we do not create one.
  const verify = await verifyWorkspaceAccount(workEmail);
  if (verify.state !== "exists") {
    const reason =
      verify.state === "missing"
        ? `No Google Workspace account was found for ${workEmail}. Bypass is only for workers whose @${WORK_EMAIL_DOMAIN} account already exists — use "Generate link" / "Set work email" to provision a new one.`
        : `Could not verify ${workEmail} in Google Workspace${
            verify.error ? `: ${verify.error}` : ""
          }. The account must be verifiable before it can be bypassed.`;
    return NextResponse.json(
      { error: reason, state: verify.state, http_status: verify.httpStatus ?? null },
      { status: 409 },
    );
  }

  // ── 2. Duplicate guard: already on the master list for this department? ──
  // Blocks BOTH an active employee AND a lingering off-boarded record. Bypassing
  // an off-boarded row would make promote silently REUSE it without clearing
  // off_boarded_* — leaving the "promoted" worker invisible in active_employees.
  // Off-boarded rehires belong in the re-onboarding flow, not Bypass.
  const existing = await findMasterRowByWorkEmail(workEmail, department);
  if (existing.error) {
    return NextResponse.json({ error: existing.error }, { status: 500 });
  }
  if (existing.id) {
    return NextResponse.json(
      {
        error: existing.offBoarded
          ? `${workEmail} belongs to an off-boarded employee in ${department}. Use the re-onboarding flow to reinstate them — Bypass can't recycle an off-boarded record.`
          : `${workEmail} is already an active employee in ${department}. Nothing to bypass.`,
        master_id: existing.id,
        off_boarded: existing.offBoarded,
      },
      { status: 409 },
    );
  }

  // ── 3. Resolve authoritative compensation from the Payment Catalog ───────
  // Same server-side resolution as set-work-email: HR never sends a rate, we
  // look up the department pay structure. Best-effort — a hire can be added
  // before Accounting fills the catalog (rate stays null until they do).
  let regularRate: string | null = null;
  let otRate: string | null = null;
  try {
    const deptLc = department.toLowerCase();
    const deptKey =
      DEPARTMENTS.find((d) => d.name.trim().toLowerCase() === deptLc)?.key ?? null;
    const { structures } = await listPayStructures();
    const match = structures.find((s) => {
      if (s.scope !== "department") return false;
      if (deptKey && s.departmentKey === deptKey) return true;
      const nm = DEPARTMENTS.find((d) => d.key === s.departmentKey)?.name ?? s.departmentKey;
      return nm.trim().toLowerCase() === deptLc;
    });
    if (match) {
      regularRate = String(match.regularRate);
      otRate = match.otRate != null ? String(match.otRate) : null;
    }
  } catch {
    // Catalog unreachable — leave rates null.
  }

  // ── 4. Stage the hire (NO create-workspace webhook fired) ────────────────
  const { row: pending, error: createErr } = await createHrPendingEmployee({
    name,
    personal_email: personalEmail,
    work_email: workEmail,
    department,
    phone,
    location,
    regular_rate: regularRate,
    ot_rate: otRate,
    start_date: startDate,
    source: "onboarding_bypass",
    created_by: authz.sessionEmail,
  });
  if (createErr || !pending) {
    return NextResponse.json(
      { error: createErr ?? "Failed to stage the hire." },
      { status: 500 },
    );
  }

  // Stamp orientation as attended (bypass implies the worker is already
  // onboarded). Satisfies promote's orientation guard AND fixes their Start
  // Date to the chosen date (or now).
  const { error: orientErr } = await markPendingHireOrientation(pending.id, {
    markedBy: authz.sessionEmail,
    note: "Bypass: manual setup — Workspace account pre-existing (verified).",
    attendedOn: startDate,
  });
  if (orientErr) {
    // Roll the just-created staging row back so a failed bypass leaves nothing
    // half-built behind.
    await deleteHrPendingEmployee(pending.id);
    return NextResponse.json(
      { error: `Failed to stamp orientation: ${orientErr}` },
      { status: 500 },
    );
  }

  // ── 5. Promote straight into the master list + Google Sheet ──────────────
  const { masterId, error: promoteErr, sheet } = await promoteHrPendingEmployee(pending.id);

  // HARD failure: no master row was created (masterId null). The staging row
  // stays behind so HR can retry the promote from the Pending Hires tab.
  if (promoteErr && !masterId) {
    const isValidation =
      /work email|already promoted|no current master|orientation|cancelled|no_show/i.test(
        promoteErr,
      );
    return NextResponse.json(
      { error: promoteErr, pending_employee_id: pending.id },
      { status: isValidation ? 400 : 500 },
    );
  }

  // At this point the master-list row EXISTS (masterId set). If promoteErr is
  // also set it's a PARTIAL success — the row was inserted but the master Google
  // Sheet append failed (the row is marked failed_to_promote and can be retried
  // from Pending Hires). Either way the worker is active in the roster, so we
  // always audit and return ok, surfacing the sheet issue as a warning.
  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.onboarding.bypass_promoted",
    resource: "hr_pending_employees",
    resource_id: String(pending.id),
    details: {
      name,
      work_email: workEmail,
      personal_email: personalEmail,
      department,
      master_id: masterId,
      start_date: startDate,
      verify_http_status: verify.httpStatus ?? null,
      sheet_warning: promoteErr ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    pending_employee_id: pending.id,
    master_id: masterId,
    work_email: workEmail,
    sheet: sheet ?? null,
    warning: promoteErr ?? null,
  });
}
