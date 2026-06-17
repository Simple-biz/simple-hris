import { NextResponse } from 'next/server';
import { saveOrphanagePay, listOrphanagePay, deleteOrphanagePay, type OrphanagePayRow } from '@/lib/supabase/orphanage-pay-db';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET ?source_file=... — locked-in orphanage pay rows for one pay period.
 * Any authenticated employee may read (middleware gates /api).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
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
  const authz = await requireElevatedSession();
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

/** DELETE ?source_file=...&email=... — remove one locked-in orphanage row. */
export async function DELETE(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = new URL(request.url);
  const sourceFile = searchParams.get('source_file');
  const email = searchParams.get('email');
  if (!sourceFile || !email) {
    return NextResponse.json({ error: 'source_file and email required' }, { status: 400 });
  }
  const { error } = await deleteOrphanagePay(sourceFile, email);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ error: null });
}
