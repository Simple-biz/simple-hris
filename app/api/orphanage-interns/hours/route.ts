import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  deleteInternHoursUpload,
  listInternHoursUploads,
  replaceInternHoursFromCsvText,
} from '@/lib/supabase/orphanage-intern-hours-db';
import { listInternPayBySourceFile } from '@/lib/supabase/orphanage-intern-pay-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The interns' own weekly Hubstaff report.
 *
 *  GET    /api/orphanage-interns/hours                    → uploaded batches, newest week first
 *  POST   /api/orphanage-interns/hours   (multipart file) → parse, refuse non-interns, store
 *  DELETE /api/orphanage-interns/hours?source_file=…      → remove a batch (refused once locked)
 *
 * It NEVER touches hubstaff_hours, is_current, MESA, notifications or the
 * disbursement seeder — that is the whole reason this route exists.
 */
export async function GET() {
  const authz = await requireFeatureAccess('orphanage', 'interns', 'view');
  if (!authz.ok) return deniedResponse(authz);
  const { uploads, error } = await listInternHoursUploads();
  if (error) return NextResponse.json({ uploads: [], error }, { status: 500 });
  return NextResponse.json({ uploads, error: null });
}

export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('orphanage', 'interns');
  if (!authz.ok) return deniedResponse(authz);

  const form = await req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'Missing file' }, { status: 400 });
  const text = await (file as Blob).text();
  const fileName = (file as File).name || form.get('fileName')?.toString() || undefined;

  const actor = await getSessionActor();
  const by = actor.user_name !== 'anonymous' ? actor.user_name : null;
  const { result, error } = await replaceInternHoursFromCsvText(text, fileName, by);
  if (error || !result) return NextResponse.json({ error: error ?? 'Upload failed' }, { status: 400 });

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage_intern_hours.uploaded',
    resource: 'orphanage_intern_hours_uploads',
    resource_id: result.upload.source_file,
    details: {
      file: result.upload.source_file,
      week_start: result.upload.week_start,
      week_end: result.upload.week_end,
      stored: result.stored,
      refused: result.refused.length,
      refused_emails: result.refused.map((r) => r.email),
      replaced: result.replaced,
    },
  });

  return NextResponse.json({ ...result, error: null }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const authz = await requireFeatureEdit('orphanage', 'interns');
  if (!authz.ok) return deniedResponse(authz);
  const sourceFile = req.nextUrl.searchParams.get('source_file')?.trim();
  if (!sourceFile) return NextResponse.json({ error: 'source_file is required' }, { status: 400 });

  const { rows, error: payErr } = await listInternPayBySourceFile(sourceFile);
  if (payErr) return NextResponse.json({ error: payErr }, { status: 500 });
  if (rows.length > 0) {
    return NextResponse.json(
      { error: `This week has been locked in (${rows[0].status}). Withdraw or have Accounting reopen it before removing the report.` },
      { status: 409 },
    );
  }

  const { error } = await deleteInternHoursUpload(sourceFile);
  if (error) return NextResponse.json({ error }, { status: 500 });
  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage_intern_hours.deleted',
    resource: 'orphanage_intern_hours_uploads',
    resource_id: sourceFile,
    details: { file: sourceFile },
  });
  return NextResponse.json({ ok: true });
}
