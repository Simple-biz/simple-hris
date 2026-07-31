import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  updateMasterListProfile,
  type MasterProfileFields,
  type MasterProfilePatch,
} from '@/lib/supabase/master-list-profile';
import { updateMasterSheetRow } from '@/lib/google-sheets/update-master-sheet-row';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** snake_case patch keys the client may send → written to global_master_list. */
/** Every editable key must also exist on the returned row, or the audit diff
 *  below would silently record `before: null, after: null` for it. This alias
 *  fails the build the moment someone adds an editable field without a matching
 *  field on MasterProfileFields. */
type EditableKey = keyof MasterProfilePatch & keyof MasterProfileFields;

const ALLOWED_KEYS: EditableKey[] = [
  'name',
  'department',
  'work_email',
  'personal_email',
  'alternate_work_email',
  'alternate_work_email_2',
  'start_date',
  'phone_number',
  'location',
  'street',
  'city',
  'province',
  'postal_code',
  'full_address',
];

/** Which patch keys have a matching column in the master Google Sheet, and the
 *  header label to write. Structured address (street/city/province/postal_code/
 *  full_address) has NO sheet column — the combined address rides `location`. */
const SHEET_LABEL: Partial<Record<keyof MasterProfilePatch, string>> = {
  name: 'Name',
  department: 'Department',
  work_email: 'Work Email',
  personal_email: 'Personal Email',
  alternate_work_email: 'Alternate Work Email',
  alternate_work_email_2: 'Alternate Work Email 2',
  start_date: 'Start Date',
  phone_number: 'Phone Number',
  location: 'Location',
};

interface Body {
  id?: string;
  /** The row's CURRENT identity (before the edit) — used to locate the sheet row. */
  original_work_email?: string | null;
  original_personal_email?: string | null;
  original_department?: string | null;
  patch?: Record<string, unknown>;
}

function statusFor(code: string): number {
  switch (code) {
    case 'invalid':
      return 400;
    case 'collision':
      return 409;
    case 'not_found':
      return 404;
    case 'config':
      return 503;
    default:
      return 500;
  }
}

/**
 * Edit one person's master-list identity/contact fields from the People -> View
 * Modal. Writes global_master_list (targeted by row id) AND — best-effort —
 * flips the matching cells in the master Google Sheet so the next Sheet -> DB
 * sync doesn't revert the edit. Admin/HR reflect the change via their own live
 * refresh (same underlying table). Gated to `people` edit access
 * (accounting | ceo | admin).
 */
export async function PATCH(req: NextRequest, context: { params: Promise<{ email: string }> }) {
  const authz = await requireFeatureEditAnyView('people');
  if (!authz.ok) return deniedResponse(authz);

  const { email: rawEmail } = await context.params;
  const email = decodeURIComponent(rawEmail ?? '').trim();

  let body: Body | null;
  try {
    body = (await req.json()) as Body | null;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = (body.id ?? '').trim();
  if (!id) return NextResponse.json({ ok: false, error: 'Missing employee id' }, { status: 400 });

  // Allowlist the patch so a crafted body can't touch off_boarded_*, upload ids,
  // employee_id, etc. Only keys actually sent are written (undefined = untouched).
  const raw = body.patch ?? {};
  const patch: MasterProfilePatch = {};
  for (const key of ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      const v = raw[key];
      (patch as Record<string, string | null>)[key] =
        v == null ? null : String(v);
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: 'No editable fields provided' }, { status: 400 });
  }

  // 1. Write the DB row.
  const result = await updateMasterListProfile(id, patch);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: statusFor(result.code) });
  }
  const master = result.master;

  // Before→after for exactly the fields this request touched. The master list
  // has no version history, so without this the audit trail can only say THAT a
  // name or work email changed, never what it changed from — which is the one
  // thing an identity investigation actually needs.
  const changes = Object.keys(patch).map((key) => {
    const before = (result.previous as unknown as Record<string, unknown>)[key] ?? null;
    const after = (master as unknown as Record<string, unknown>)[key] ?? null;
    return { field: key, before, after, changed: before !== after };
  });

  // 2. Best-effort Google Sheet write for the columns the sheet actually has.
  //    Name uses the DB's canonicalized value so the round-trip is idempotent.
  const cells: Record<string, string | null> = {};
  for (const key of ALLOWED_KEYS) {
    const label = SHEET_LABEL[key];
    if (!label) continue;
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    cells[label] = key === 'name' ? master.name : (patch[key] ?? null);
  }

  let sheet: { updated: number; reason?: string } = { updated: 0, reason: 'no sheet columns changed' };
  if (Object.keys(cells).length > 0) {
    try {
      sheet = await updateMasterSheetRow({
        workEmail: body.original_work_email ?? master.work_email,
        personalEmail: body.original_personal_email ?? master.personal_email,
        matchDepartment: body.original_department ?? master.department,
        cells,
      });
    } catch (e) {
      sheet = { updated: 0, reason: e instanceof Error ? e.message : 'sheet write failed' };
    }
  }

  // 3. Audit (fire-and-forget; a failed audit must not fail the save).
  let actor = { user_name: 'unknown', user_role: 'user' };
  try {
    actor = await getSessionActor();
  } catch {
    /* best-effort */
  }
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'people.profile.updated',
    resource: 'global_master_list',
    resource_id: master.id,
    details: {
      email,
      work_email: master.work_email,
      // The email the row was keyed by BEFORE the edit — without it, an audit
      // search for the old address can never find the rename that retired it.
      previous_work_email: result.previous.work_email,
      department: master.department,
      fields: Object.keys(patch),
      changes,
      sheet_updated: sheet.updated,
      sheet_reason: sheet.reason ?? null,
    },
  });

  return NextResponse.json({ ok: true, master, sheet });
}
