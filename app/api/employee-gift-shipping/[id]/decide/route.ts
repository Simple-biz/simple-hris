import { NextRequest, NextResponse } from 'next/server';
import { decideShippingDetail } from '@/lib/supabase/employee-gift-shipping';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface DecideBody {
  status: 'approved' | 'rejected';
  decided_by: string | null;
  decision_note?: string | null;
  /** Required when status='approved'. */
  gift_catalog_item_id?: string | null;
  gift_name?: string | null;
  gift_price_php?: number | null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ row: null, error: 'Missing id' }, { status: 400 });
  }

  let body: DecideBody;
  try {
    body = (await req.json()) as DecideBody;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }
  if (body.status !== 'approved' && body.status !== 'rejected') {
    return NextResponse.json(
      { row: null, error: 'status must be approved or rejected' },
      { status: 400 },
    );
  }

  const { row, error } = await decideShippingDetail({
    id,
    status: body.status,
    decided_by: body.decided_by,
    decision_note: body.decision_note ?? null,
    gift_catalog_item_id: body.gift_catalog_item_id ?? null,
    gift_name: body.gift_name ?? null,
    gift_price_php: body.gift_price_php ?? null,
  });
  if (error || !row) {
    const status = error?.toLowerCase().includes('required') ? 400 : 500;
    return NextResponse.json({ row: null, error: error ?? 'Update failed' }, { status });
  }

  void insertAuditLog({
    user_name: body.decided_by ?? 'orphanage_team',
    user_role: 'orphanage_team',
    action: `employee_gift_shipping.${body.status}`,
    resource: 'employee_gift_shipping_details',
    resource_id: row.id,
    details: {
      personal_email: row.personal_email,
      milestone_index: row.milestone_index,
      decision_note: body.decision_note ?? null,
      gift_name: row.gift_name,
      gift_price_php: row.gift_price_php,
    },
  });

  return NextResponse.json({ row, error: null });
}
