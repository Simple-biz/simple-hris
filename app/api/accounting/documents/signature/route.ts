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
  try {
    const authz = await requireFeatureAccess('accounting', 'documents', 'view');
    if (!authz.ok) return deniedResponse(authz);

    const { row, error } = await getDocumentSignature(authz.sessionEmail);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ row });
  } catch (e) {
    return NextResponse.json({ error: describeThrow(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    // INSIDE the try on purpose. Authorization resolves the NextAuth session
    // and reads feature grants from the database, so it can throw — a stale or
    // undecryptable session cookie ("JSON Web Token" errors), a Supabase
    // hiccup. An unhandled throw here escapes as the framework's own error
    // page, and the client's `res.json()` then reports a parse failure instead
    // of the cause. Every exit from this route answers JSON.
    const authz = await requireFeatureEdit('accounting', 'documents');
    if (!authz.ok) return deniedResponse(authz);

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
    return NextResponse.json({ error: describeThrow(e) }, { status: 500 });
  }
}

/** A thrown value as a message the operator can report back. A bare
 *  `String(e)` on a non-Error prints "[object Object]", which is no more use
 *  than the parse error this route exists to avoid. */
function describeThrow(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || 'Unknown error';
  if (typeof e === 'string' && e.trim()) return e;
  try {
    const json = JSON.stringify(e);
    if (json && json !== '{}') return json;
  } catch {
    /* fall through to the generic message */
  }
  return 'The signature service threw a non-Error value';
}
