import { getCoreDataTablesStatus } from '@/lib/supabase/data-tables-status';
import { requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  // Admin-only. Also gated at the edge under /api/admin/*; this in-handler check
  // means the route isn't relying on the proxy matcher as its only protection.
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  try {
    const payload = await getCoreDataTablesStatus();
    return NextResponse.json(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        tables: [],
        hints: [msg],
        usedServiceRole: false,
        error: msg,
      },
      { status: 500 },
    );
  }
}
