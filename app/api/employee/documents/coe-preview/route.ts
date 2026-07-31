import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { resolveCoeFacts } from '@/lib/documents/coe-facts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The facts that will appear on the caller's Certificate of Engagement, for the
 * read-only card shown when they pick that document type. No PDF is rendered
 * and nothing is written — this only exists so a wrong start date or a stale
 * rate gets caught by the person who would notice, before Accounting sees it.
 *
 * Always scoped to the CALLER's own session email, never a query parameter.
 *
 *   200 → { facts }
 *   422 → { blocked } the certificate can't be issued yet (message is for the
 *         employee: no start date / no department / no rate on file)
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string | null } | undefined)?.email
    ?.trim()
    .toLowerCase();
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { facts, blocked, error } = await resolveCoeFacts(email);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (blocked) return NextResponse.json({ blocked: blocked.message, code: blocked.code }, { status: 422 });
  return NextResponse.json({ facts });
}
