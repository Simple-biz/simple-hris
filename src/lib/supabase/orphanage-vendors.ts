import { createSupabaseServiceRoleClient } from './server';
import type {
  OrphanageVendorRow,
  UpsertOrphanageVendorInput,
} from '../orphanage/vendor';

// DB access for the Orphanage "3rd party vendors" directory. Types + pure
// helpers live in the client-safe module src/lib/orphanage/vendor.ts (re-exported
// here for server callers). See references/sql/create/create_orphanage_vendors.sql.
export type {
  OrphanageVendorRow,
  UpsertOrphanageVendorInput,
} from '../orphanage/vendor';

const SELECT_COLS =
  'id, business_name, contact_name, contact_email, contact_phone, address_line1, address_line2, city, country, products_services, payables, bank_name, account_holder_name, account_number, swift_code, routing_number, note, created_by, created_at, updated_at';

/** Normalize an upsert payload to the DB column shape (trim, blanks -> null). */
function toRow(input: UpsertOrphanageVendorInput) {
  const s = (v: string | null | undefined) => (v == null ? null : v.trim() || null);
  return {
    business_name: input.business_name.trim(),
    contact_name: s(input.contact_name),
    contact_email: s(input.contact_email),
    contact_phone: s(input.contact_phone),
    address_line1: s(input.address_line1),
    address_line2: s(input.address_line2),
    city: s(input.city),
    country: s(input.country),
    products_services: s(input.products_services),
    payables: s(input.payables),
    bank_name: input.bank_name?.trim() ?? '',
    account_holder_name: input.account_holder_name?.trim() ?? '',
    account_number: input.account_number?.trim() ?? '',
    swift_code: input.swift_code?.trim() ?? '',
    routing_number: input.routing_number?.trim() ?? '',
    note: s(input.note),
  };
}

/** All vendors, alphabetical by business name. */
export async function listOrphanageVendors(): Promise<{
  rows: OrphanageVendorRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('orphanage_vendors')
    .select(SELECT_COLS)
    .order('business_name', { ascending: true });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as OrphanageVendorRow[], error: null };
}

/** Fetch a single vendor by id (used to snapshot onto a new invoice). */
export async function getOrphanageVendor(
  id: string,
): Promise<{ row: OrphanageVendorRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('orphanage_vendors')
    .select(SELECT_COLS)
    .eq('id', id)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data as OrphanageVendorRow) ?? null, error: null };
}

/** Add a new vendor. */
export async function createOrphanageVendor(
  input: UpsertOrphanageVendorInput,
): Promise<{ row: OrphanageVendorRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('orphanage_vendors')
    .insert({ ...toRow(input), created_by: input.created_by ?? null })
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageVendorRow, error: null };
}

/** Edit an existing vendor. Does not touch created_by. */
export async function updateOrphanageVendor(
  id: string,
  input: UpsertOrphanageVendorInput,
): Promise<{ row: OrphanageVendorRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('orphanage_vendors')
    .update(toRow(input))
    .eq('id', id)
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageVendorRow, error: null };
}

/** Remove a vendor. Paid/pending invoices keep their snapshot (vendor_id -> NULL). */
export async function deleteOrphanageVendor(
  id: string,
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, error: 'Supabase not configured' };
  const { error } = await supabase.from('orphanage_vendors').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}
