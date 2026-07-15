import { NextResponse } from "next/server";
import {
  deletePayrollWizardNotes,
  ensurePayrollWizardNoteSeeds,
  insertPayrollWizardNote,
  listPayrollWizardNotes,
  resolvePayrollClerkName,
  updatePayrollWizardNote,
  PAYROLL_WIZARD_NOTE_FIELDS,
  type PayrollWizardNoteValues,
} from "@/lib/supabase/payroll-wizard-notes";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess, requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FIELD_SET = new Set<string>(PAYROLL_WIZARD_NOTE_FIELDS);

/** Keep only recognised columns from an untrusted values object. */
function pickValues(raw: unknown): PayrollWizardNoteValues {
  const out: PayrollWizardNoteValues = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "done") out.done = v === true;
    else if (FIELD_SET.has(k)) {
      out[k as (typeof PAYROLL_WIZARD_NOTE_FIELDS)[number]] = v == null ? null : String(v);
    }
  }
  return out;
}

/** GET — the whole board. Anyone who can SEE the wizard can read it. Also
 *  tops every Admin-provisioned edit clerk up to 5 blank rows (best-effort —
 *  a seeding hiccup never blocks reading the board). */
export async function GET() {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  const first = await listPayrollWizardNotes();
  if (first.error) return NextResponse.json({ rows: [], error: first.error }, { status: 500 });

  const { seeded } = await ensurePayrollWizardNoteSeeds(first.rows);
  if (!seeded) return NextResponse.json({ rows: first.rows });

  const { rows, error } = await listPayrollWizardNotes();
  if (error) return NextResponse.json({ rows: first.rows });
  return NextResponse.json({ rows });
}

/** POST — add ONE note. Body: { values? }. Blank rows are fine ("Add Row"). */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("accounting", "payroll_wizard");
  if (!authz.ok) return deniedResponse(authz);

  let body: { values?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  // The clerk stamp is resolved server-side (master-list "First Last") so an
  // added row always lands in the same board section as the person's seeded
  // rows; the client-sent name is only a fallback for people off the list.
  const values = pickValues(body.values);
  values.payroll_clerk = await resolvePayrollClerkName(
    authz.sessionEmail,
    values.payroll_clerk ?? null,
  );

  const { row, error } = await insertPayrollWizardNote(values, {
    createdBy: authz.sessionEmail,
  });
  if (error || !row) return NextResponse.json({ error: error ?? "Insert failed" }, { status: 400 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "accounting",
    action: "accounting.payroll_wizard_notes.row_added",
    resource: "payroll_wizard_notes",
    resource_id: row.id,
    details: { worker: row.worker, notes: row.notes },
  });

  return NextResponse.json({ row });
}

/** PATCH — update ONE note. Body: { id, values }. Only sent fields change. */
export async function PATCH(req: Request) {
  const authz = await requireFeatureEdit("accounting", "payroll_wizard");
  if (!authz.ok) return deniedResponse(authz);

  let body: { id?: string; values?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "A row id is required" }, { status: 400 });

  const values = pickValues(body.values);
  const { row, error } = await updatePayrollWizardNote(id, values);
  if (error) return NextResponse.json({ error }, { status: 400 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "accounting",
    action: "accounting.payroll_wizard_notes.row_updated",
    resource: "payroll_wizard_notes",
    resource_id: id,
    details: { fields: Object.keys(values) },
  });

  return NextResponse.json({ row });
}

/** DELETE — remove notes by id. Body: { id? , ids?: [...] }. Owner-only: a
 *  note can only be deleted by the person who created it (no admin bypass). */
export async function DELETE(req: Request) {
  const authz = await requireFeatureEdit("accounting", "payroll_wizard");
  if (!authz.ok) return deniedResponse(authz);

  let body: { id?: string; ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? (body.ids as unknown[]).map((x) => String(x))
    : body.id
      ? [String(body.id)]
      : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "id or ids[] is required" }, { status: 400 });
  }

  const { deleted, denied, error } = await deletePayrollWizardNotes(ids, {
    ownedBy: authz.sessionEmail,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (deleted === 0 && denied > 0) {
    return NextResponse.json(
      { error: "Only the person who created a note can delete it." },
      { status: 403 },
    );
  }

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "accounting",
    action: "accounting.payroll_wizard_notes.row_deleted",
    resource: "payroll_wizard_notes",
    resource_id: ids[0]!,
    details: { count: deleted },
  });

  return NextResponse.json({ deleted });
}
