import { NextResponse } from 'next/server';
import {
  getGiftCatalog,
  upsertGiftCatalog,
  type GiftCatalogPayload,
} from '@/lib/supabase/gift-catalog';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const result = await getGiftCatalog();
  if (result.error) return NextResponse.json(result, { status: 500 });
  return NextResponse.json(result);
}

export async function PUT(request: Request) {
  try {
    const authz = await requireFeatureEdit('hr', 'gift_tracker');
    if (!authz.ok) return deniedResponse(authz);
    const body = (await request.json()) as {
      catalog?: GiftCatalogPayload;
      updated_by?: string | null;
    };
    if (!body.catalog) {
      return NextResponse.json({ error: 'Missing catalog' }, { status: 400 });
    }
    const { error } = await upsertGiftCatalog(body.catalog, body.updated_by ?? null);
    if (error) return NextResponse.json({ error }, { status: 500 });

    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: authz.roles[0] ?? 'hr',
      action: 'gift.catalog_saved',
      resource: 'gift_catalog',
      resource_id: null,
      details: { sections: Object.keys(body.catalog ?? {}) },
    });

    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
