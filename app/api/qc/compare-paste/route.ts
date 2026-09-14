import { NextResponse } from 'next/server';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse, type AuthzOk } from '@/lib/auth/authorize-email';
import { rejectWhilePayrollProcessing } from '@/lib/payroll/processing-guard';
import { listManagedQcDepts } from '@/lib/supabase/qc-db';
import {
  deleteAppSetting,
  getAppSettingWithMetaStrict,
  upsertAppSetting,
} from '@/lib/supabase/app-settings';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import {
  comparePasteSettingKey,
  decodeSharedComparePaste,
  encodeSharedComparePaste,
  parseComparePasteSaveBody,
  parseComparePasteTarget,
  type SharedComparePaste,
} from '@/lib/qc/compare-paste';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The manager's Compare sheet, shared per (QC department, pay-week Sunday).
 * See `docs/features/qc-scoring.md` § *The pasted sheet is shared*.
 *
 *   GET    ?dept=&period_start=          -> { paste: SharedComparePaste | null }
 *   PUT    { dept, period_start, text }  -> { paste }   (replaces whole; stamps who/when)
 *   DELETE ?dept=&period_start=          -> { cleared: boolean }
 *
 * Gate — the one `qc-scoring.md` §Compare pins: the manager's `hsl_bonus`
 * feature (view to read, edit to write) AND a `department_managers` grant on
 * the department, admin bypassing the scope exactly as `/api/qc/review` does.
 * The `qc` role is deliberately NOT a reader: "the officers cannot see her
 * sheet, so any delta is a scoring error" is the premise Compare rests on.
 * Writes are refused with 423 while payroll is processing, like every other
 * KPI/QC mutation.
 *
 * The value is one scalar replaced whole, so the write is a plain upsert —
 * last-writer-wins is what `casUpdateAppSetting`'s own header prescribes for a
 * scalar; the attribution says who wrote last and the save audit names whom it
 * replaced. `pastedBy` is the SESSION email, never the body.
 */

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** A plain manager may only touch the departments they manage. Admins bypass. */
async function refuseOutsideScope(authz: AuthzOk, dept: string): Promise<NextResponse | null> {
  if ((authz.roles ?? []).includes('admin')) return null;
  const managed = await listManagedQcDepts(norm(authz.sessionEmail));
  if (managed.includes(dept)) return null;
  return NextResponse.json({ error: `You do not manage ${dept}.` }, { status: 403 });
}

type Stored = { paste: SharedComparePaste | null; unreadable: boolean };

/** Read the row. `unreadable` is a present row that does not decode — reported,
 *  never rendered as an attributed sheet and never silently treated as absent. */
async function readStored(key: string): Promise<Stored> {
  const row = await getAppSettingWithMetaStrict(key);
  if (!row) return { paste: null, unreadable: false };
  const paste = decodeSharedComparePaste(row.value);
  return { paste, unreadable: paste === null };
}

export async function GET(request: Request) {
  const authz = await requireFeatureAccess('manager', 'hsl_bonus', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = new URL(request.url);
  const target = parseComparePasteTarget(searchParams.get('dept'), searchParams.get('period_start'));
  if (!target.ok) return NextResponse.json({ paste: null, error: target.reason }, { status: 400 });

  const scope = await refuseOutsideScope(authz, target.dept);
  if (scope) return scope;

  try {
    const stored = await readStored(comparePasteSettingKey(target.dept, target.periodStart));
    if (stored.unreadable) {
      return NextResponse.json(
        { paste: null, error: 'A shared sheet exists for this week but could not be read — clear it and Compare again.' },
        { status: 500 },
      );
    }
    return NextResponse.json({ paste: stored.paste, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ paste: null, error: msg }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const authz = await requireFeatureEdit('manager', 'hsl_bonus');
  if (!authz.ok) return deniedResponse(authz);
  const processing = await rejectWhilePayrollProcessing('sharing a Compare sheet');
  if (processing) return processing;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ paste: null, error: 'Invalid JSON body' }, { status: 400 });
  }
  const body = parseComparePasteSaveBody(raw);
  if (!body.ok) return NextResponse.json({ paste: null, error: body.reason }, { status: 400 });

  const scope = await refuseOutsideScope(authz, body.dept);
  if (scope) return scope;

  const key = comparePasteSettingKey(body.dept, body.periodStart);
  try {
    // Read what this write replaces, so the audit row can name it. An
    // unreadable row is replaced too — that is the sanctioned repair.
    const before = await readStored(key);

    const paste: SharedComparePaste = {
      v: 1,
      text: body.text,
      pastedBy: norm(authz.sessionEmail),
      pastedAt: new Date().toISOString(),
      rowCount: body.rowCount,
    };
    const { error } = await upsertAppSetting(key, encodeSharedComparePaste(paste));
    if (error) return NextResponse.json({ paste: null, error }, { status: 500 });

    // Metadata only — the text itself is on the row. One event per Compare that
    // changed the shared sheet; the client skips the PUT when the text is
    // already what is shared, so this does not fire on every re-Compare.
    const actor = await getSessionActor();
    void insertAuditLog({
      ...actor,
      action: 'qc.compare_paste_saved',
      resource: 'qc_compare_paste',
      resource_id: `${body.dept}:${body.periodStart}`,
      details: {
        department: body.dept,
        period_start: body.periodStart,
        row_count: paste.rowCount,
        chars: paste.text.length,
        replaced_pasted_by: before.paste?.pastedBy ?? null,
        replaced_pasted_at: before.paste?.pastedAt ?? null,
        replaced_row_count: before.paste?.rowCount ?? null,
        replaced_unreadable: before.unreadable,
      },
    });

    return NextResponse.json({ paste, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ paste: null, error: msg }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const authz = await requireFeatureEdit('manager', 'hsl_bonus');
  if (!authz.ok) return deniedResponse(authz);
  const processing = await rejectWhilePayrollProcessing('clearing a Compare sheet');
  if (processing) return processing;

  const { searchParams } = new URL(request.url);
  const target = parseComparePasteTarget(searchParams.get('dept'), searchParams.get('period_start'));
  if (!target.ok) return NextResponse.json({ cleared: false, error: target.reason }, { status: 400 });

  const scope = await refuseOutsideScope(authz, target.dept);
  if (scope) return scope;

  const key = comparePasteSettingKey(target.dept, target.periodStart);
  try {
    const row = await getAppSettingWithMetaStrict(key);
    if (!row) return NextResponse.json({ cleared: false, error: null });
    const before = decodeSharedComparePaste(row.value);

    // Nothing is destroyed unsnapshotted: the FULL text goes into the audit row
    // first, and a failed audit write refuses the delete. Another manager typed
    // this sheet; after it is gone, audit_log is the only place it survives.
    const actor = await getSessionActor();
    const { error: auditError } = await insertAuditLog({
      ...actor,
      action: 'qc.compare_paste_cleared',
      resource: 'qc_compare_paste',
      resource_id: `${target.dept}:${target.periodStart}`,
      details: {
        department: target.dept,
        period_start: target.periodStart,
        pasted_by: before?.pastedBy ?? null,
        pasted_at: before?.pastedAt ?? null,
        row_count: before?.rowCount ?? null,
        // The verbatim sheet, or the raw unreadable value if it never decoded.
        text: before?.text ?? row.value,
        unreadable: before === null,
      },
    });
    if (auditError) {
      return NextResponse.json(
        { cleared: false, error: `Refused: the audit record could not be written (${auditError}). Nothing was deleted.` },
        { status: 500 },
      );
    }

    const { error } = await deleteAppSetting(key);
    if (error) return NextResponse.json({ cleared: false, error }, { status: 500 });
    return NextResponse.json({ cleared: true, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ cleared: false, error: msg }, { status: 500 });
  }
}
