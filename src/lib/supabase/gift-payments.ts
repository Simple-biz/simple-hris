import { createSupabaseServiceRoleClient } from './server';

export type GiftPaymentLineItem = {
  id: string;
  name: string;
  quantity: number;
  unit_price: number;
};

export type GiftPaymentVendorBank = {
  label: string;
  bank_name: string;
  account_holder: string;
  account_number: string;
  routing_number: string;
  email: string;
};

export type GiftPaymentVendor = {
  name: string;
  phone: string;
  email: string;
  street: string;
  city: string;
  province: string;
  postal_code: string;
  full_address: string;
  banks: GiftPaymentVendorBank[];
};

export type GiftPaymentStatus = 'pending' | 'sent' | 'paid' | 'cancelled';

export type GiftPaymentRow = {
  id: string;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  period_label: string;
  batch_label: string;
  vendor: GiftPaymentVendor;
  items: GiftPaymentLineItem[];
  shipping_fee: number;
  ordered_by: string;
  total_usd: number;
  transaction_id: string;
  staff: string;
  date_sent: string | null;
  arrival_date: string | null;
  our_bank: string;
  status: GiftPaymentStatus;
  notes: string;
};

const SELECT_COLS =
  'id, created_by_email, created_at, updated_at, period_label, batch_label, vendor, items, shipping_fee, ordered_by, total_usd, transaction_id, staff, date_sent, arrival_date, our_bank, status, notes';

function rowFromDb(raw: Record<string, unknown>): GiftPaymentRow {
  return {
    id: String(raw.id),
    created_by_email: (raw.created_by_email as string | null) ?? null,
    created_at: String(raw.created_at),
    updated_at: String(raw.updated_at),
    period_label: String(raw.period_label ?? ''),
    batch_label: String(raw.batch_label ?? ''),
    vendor: (raw.vendor as GiftPaymentVendor) ?? {
      name: '',
      phone: '',
      email: '',
      street: '',
      city: '',
      province: '',
      postal_code: '',
      full_address: '',
      banks: [],
    },
    items: ((raw.items as GiftPaymentLineItem[]) ?? []).map((it) => ({
      id: String(it.id ?? ''),
      name: String(it.name ?? ''),
      quantity: Number(it.quantity ?? 0),
      unit_price: Number(it.unit_price ?? 0),
    })),
    shipping_fee: Number(raw.shipping_fee ?? 0),
    ordered_by: String(raw.ordered_by ?? ''),
    total_usd: Number(raw.total_usd ?? 0),
    transaction_id: String(raw.transaction_id ?? ''),
    staff: String(raw.staff ?? ''),
    date_sent: (raw.date_sent as string | null) ?? null,
    arrival_date: (raw.arrival_date as string | null) ?? null,
    our_bank: String(raw.our_bank ?? ''),
    status: (raw.status as GiftPaymentStatus) ?? 'pending',
    notes: String(raw.notes ?? ''),
  };
}

export async function listGiftPayments(opts: {
  email?: string | null;
}): Promise<{ rows: GiftPaymentRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase client unavailable' };
  let q = supabase
    .from('gift_payments')
    .select(SELECT_COLS)
    .order('created_at', { ascending: false });
  const email = opts.email?.trim().toLowerCase();
  if (email) q = q.eq('created_by_email', email);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []).map((r) => rowFromDb(r as Record<string, unknown>)), error: null };
}

export type GiftPaymentDraft = Omit<GiftPaymentRow, 'created_at' | 'updated_at' | 'created_by_email'> & {
  id?: string;
};

export async function replaceGiftPayments(
  drafts: GiftPaymentDraft[],
  createdBy: string | null,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const email = createdBy?.trim().toLowerCase() ?? null;

  // Read every existing row owned by this user (or all rows when no scope) so
  // we can detect deletes. Bulk replace is simpler than tracking dirty IDs
  // across the client; the volume here is small (< 100s) so this is fine.
  let existingQ = supabase.from('gift_payments').select('id');
  if (email) existingQ = existingQ.eq('created_by_email', email);
  const existing = await existingQ;
  if (existing.error) return { error: existing.error.message };
  const existingIds = new Set((existing.data ?? []).map((r) => String((r as { id: string }).id)));
  const incomingIds = new Set(drafts.map((d) => d.id).filter((id): id is string => Boolean(id)));

  // Delete rows the user removed.
  const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));
  if (toDelete.length > 0) {
    const del = await supabase.from('gift_payments').delete().in('id', toDelete);
    if (del.error) return { error: del.error.message };
  }

  // Upsert every draft. New drafts (no id) get one assigned by the DB.
  const payload = drafts.map((d) => ({
    ...(d.id ? { id: d.id } : {}),
    created_by_email: email,
    period_label: d.period_label,
    batch_label: d.batch_label,
    vendor: d.vendor,
    items: d.items,
    shipping_fee: d.shipping_fee,
    ordered_by: d.ordered_by,
    total_usd: d.total_usd,
    transaction_id: d.transaction_id,
    staff: d.staff,
    date_sent: d.date_sent || null,
    arrival_date: d.arrival_date || null,
    our_bank: d.our_bank,
    status: d.status,
    notes: d.notes,
  }));

  if (payload.length > 0) {
    const up = await supabase.from('gift_payments').upsert(payload, { onConflict: 'id' });
    if (up.error) return { error: up.error.message };
  }

  return { error: null };
}
