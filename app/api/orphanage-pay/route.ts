import { NextResponse } from 'next/server';
import { saveOrphanagePay, listOrphanagePay, listAllOrphanagePayHours, deleteOrphanagePay, deleteAllOrphanagePay, type OrphanagePayRow } from '@/lib/supabase/orphanage-pay-db';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit, requireFeatureAccess } from '@/lib/auth/authorize-feature';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET ?source_file=... — locked-in orphanage pay rows for one pay period.
 * Any authenticated employee may read (middleware gates /api).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // ?all=1 — every locked-in orphanage row across ALL pay weeks, reduced to
  // (source_file, email, hours). Powers the Payroll Wizard's month-wide
  // orphanage → PAB coverage; gated to accounting since it exposes the full
  // fleet's history (the per-source_file read below stays open to any employee).
  if (searchParams.get('all') === '1') {
    const authz = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
    if (!authz.ok) return deniedResponse(authz);
    try {
      const rows = await listAllOrphanagePayHours();
      return NextResponse.json({ rows, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ rows: [], error: msg }, { status: 500 });
    }
  }

  const sourceFile = searchParams.get('source_file');
  if (!sourceFile) {
    return NextResponse.json({ rows: [], error: 'source_file required' }, { status: 400 });
  }
  try {
    const rows = await listOrphanagePay(sourceFile);
    return NextResponse.json({ rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

/**
 * POST — upsert locked-in orphanage pay for a pay period (Payroll Wizard's
 * Orphanage "Lock in values"). Writing payroll values is an elevated action,
 * mirroring the additions-blob save (/api/app-settings). The actor's email is
 * recorded as `locked_by`.
 */
export async function POST(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  let body: { source_file?: string; rows?: OrphanagePayRow[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.source_file || !Array.isArray(body.rows)) {
    return NextResponse.json({ error: 'source_file and rows required' }, { status: 400 });
  }

  const { saved, error } = await saveOrphanagePay({
    sourceFile: body.source_file,
    rows: body.rows,
    actor: authz.sessionEmail,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ saved, error: null });
}

/**
 * DELETE ?source_file=...&email=... — remove one locked-in orphanage row.
 * DELETE ?source_file=...&all=1   — remove EVERY row for the period (the
 * wizard's "Remove all", so a bad paste can be wiped and re-entered fresh).
 * The period wipe requires the EXPLICIT all=1 flag — a missing email never
 * silently widens to the whole period — and passing both is refused as
 * ambiguous. Both shapes snapshot what they destroy into audit_log
 * (`orphanage_pay.record_deleted` / `orphanage_pay.period_cleared`).
 */
export async function DELETE(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = new URL(request.url);
  const sourceFile = searchParams.get('source_file');
  const email = searchParams.get('email');
  const all = searchParams.get('all') === '1';
  if (!sourceFile || (!email && !all)) {
    return NextResponse.json({ error: 'source_file and email (or all=1) required' }, { status: 400 });
  }
  if (email && all) {
    return NextResponse.json({ error: 'pass email or all=1, not both' }, { status: 400 });
  }
  const actor = { email: authz.sessionEmail, role: authz.roles[0] ?? 'accounting' };
  if (all) {
    const { deleted, error } = await deleteAllOrphanagePay(sourceFile, actor);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ deleted, error: null });
  }
  const { error } = await deleteOrphanagePay(sourceFile, email as string, actor);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ error: null });
}
