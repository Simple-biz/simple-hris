import { createSupabaseServiceRoleClient } from './server';

/**
 * Manager-maintained directory of partner orphanages. Backed by the
 * `public.orphanages` table (see references/create_orphanages.sql). Replaces
 * the former hardcoded seed in OrphanagesPanel.tsx.
 */

export interface OrphanageRow {
  id: string;
  name: string;
  location: string | null;
  children: number;
  phone: string | null;
  email: string | null;
  leftover_budget: number;
  image_url: string | null;
  /** Receiving bank for the interns' orphanage share (share_mode = system_split).
   *  Added 2026-09-02; edited only in the Orphanage directory. */
  bank_name: string;
  bank_account_name: string;
  bank_account_number: string;
  swift_code: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertOrphanageInput {
  name: string;
  location?: string | null;
  children?: number;
  phone?: string | null;
  email?: string | null;
  leftover_budget?: number;
  image_url?: string | null;
  bank_name?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  swift_code?: string | null;
  created_by?: string | null;
}

export type UpdateOrphanageInput = Partial<
  Pick<
    OrphanageRow,
    | 'name' | 'location' | 'children' | 'phone' | 'email' | 'leftover_budget' | 'image_url'
    | 'bank_name' | 'bank_account_name' | 'bank_account_number' | 'swift_code'
  >
>;

export async function listOrphanages(): Promise<{
  rows: OrphanageRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('orphanages')
    .select('*')
    .order('name', { ascending: true });

  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as OrphanageRow[], error: null };
}

export async function insertOrphanage(
  input: InsertOrphanageInput,
): Promise<{ row: OrphanageRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('orphanages')
    .insert({
      name: input.name.trim(),
      location: input.location?.trim() || null,
      children: Number.isFinite(input.children) ? Math.max(0, Math.trunc(input.children!)) : 0,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      leftover_budget: Number.isFinite(input.leftover_budget) ? input.leftover_budget : 0,
      image_url: input.image_url?.trim() || null,
      bank_name: input.bank_name?.trim() ?? '',
      bank_account_name: input.bank_account_name?.trim() ?? '',
      bank_account_number: input.bank_account_number?.trim() ?? '',
      swift_code: input.swift_code?.trim() ?? '',
      created_by: input.created_by?.trim() || null,
    })
    .select('*')
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageRow, error: null };
}

export async function updateOrphanage(
  id: string,
  patch: UpdateOrphanageInput,
): Promise<{ row: OrphanageRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.location !== undefined) update.location = patch.location?.trim() || null;
  if (patch.children !== undefined)
    update.children = Math.max(0, Math.trunc(Number(patch.children) || 0));
  if (patch.phone !== undefined) update.phone = patch.phone?.trim() || null;
  if (patch.email !== undefined) update.email = patch.email?.trim() || null;
  if (patch.leftover_budget !== undefined)
    update.leftover_budget = Number.isFinite(patch.leftover_budget) ? patch.leftover_budget : 0;
  if (patch.image_url !== undefined) update.image_url = patch.image_url?.trim() || null;
  if (patch.bank_name !== undefined) update.bank_name = patch.bank_name?.trim() ?? '';
  if (patch.bank_account_name !== undefined) update.bank_account_name = patch.bank_account_name?.trim() ?? '';
  if (patch.bank_account_number !== undefined) update.bank_account_number = patch.bank_account_number?.trim() ?? '';
  if (patch.swift_code !== undefined) update.swift_code = patch.swift_code?.trim() ?? '';

  if (Object.keys(update).length === 0) {
    return { row: null, error: 'No fields to update' };
  }

  const { data, error } = await supabase
    .from('orphanages')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageRow, error: null };
}

export async function deleteOrphanage(
  id: string,
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, error: 'Supabase not configured' };

  const { error } = await supabase.from('orphanages').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}
