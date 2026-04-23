import { getCoreDataTablesStatus } from '@/lib/supabase/data-tables-status';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
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
