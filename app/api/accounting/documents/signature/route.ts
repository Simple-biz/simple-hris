import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getDocumentSignature, upsertDocumentSignature } from '@/lib/documents/signatures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The CALLER's saved signing signature (Accounting → Documents). Strictly
 * self-serve — there is no way to read or change anyone else's signature.
 *
 *   GET → { row | null }
 *   PUT { image_data_url?, owner_name?, title?, enabled? } → save the drawing /
 *        caption, or flip the revoke switch. Enabling requires a drawing.
 */

export async function GET() {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { row, error } = await getDocumentSignature(authz.sessionEmail);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ row });
}

export async function PUT(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'documents');
  if (!authz.ok) return deniedResponse(authz);

  try {
    const body = (await req.json().catch(() => ({}))) as {
      image_data_url?: string | null;
      owner_name?: string | null;
      title?: string | null;
      enabled?: boolean;
    };

    const { row, error } = await upsertDocumentSignature({
      owner_email: authz.sessionEmail,
      owner_name: body.owner_name,
      title: body.title,
      image_data_url: body.image_data_url,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    });
    if (error || !row) return NextResponse.json({ error: error ?? 'Save failed' }, { status: 400 });
    return NextResponse.json({ row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
