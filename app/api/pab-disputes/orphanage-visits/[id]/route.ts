import { NextResponse } from 'next/server';
import { adminDeleteOrphanageVisit } from '@/lib/supabase/pab-day-disputes';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireFeatureEdit('accounting', 'disputes');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await context.params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const { searchParams } = new URL(request.url);
    const admin_name = searchParams.get('admin_name')?.trim();
    if (!admin_name) {
      return NextResponse.json({ error: 'admin_name query param is required' }, { status: 400 });
    }

    const { error } = await adminDeleteOrphanageVisit(id, { admin_name });
    if (error) {
      const code = error === 'Visit not found' ? 404 : 500;
      return NextResponse.json({ error }, { status: code });
    }
    return NextResponse.json({ success: true, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
