import { createSupabaseServiceRoleClient } from './server';

export type EmployeeGiftShippingStatus = 'pending' | 'approved' | 'rejected';

export interface EmployeeGiftShippingRow {
  id: string;
  personal_email: string;
  milestone_index: number;
  milestone_date: string;
  preferred_delivery_location: string;
  active_contact_number: string;
  notes: string;
  status: EmployeeGiftShippingStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  /** Snapshot of gift_catalog.items[i].id chosen at approval time. */
  gift_catalog_item_id: string | null;
  /** Display name snapshot — survives catalog edits. */
  gift_name: string | null;
  /** Price in PHP at approval time. Drives the Accounting weekly outflow. */
  gift_price_php: number | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertShippingInput {
  personal_email: string;
  milestone_index: number;
  milestone_date: string; // YYYY-MM-DD
  preferred_delivery_location: string;
  active_contact_number: string;
  notes: string;
}

const SELECT_COLS =
  'id, personal_email, milestone_index, milestone_date, preferred_delivery_location, active_contact_number, notes, status, decided_by, decided_at, decision_note, gift_catalog_item_id, gift_name, gift_price_php, created_at, updated_at';

/**
 * List shipping submissions. Pass `personalEmail` to scope to one employee
 * (used by the employee dashboard); omit for the Orphanage team's roster view.
 */
export async function listShippingDetails(opts: {
  personalEmail?: string | null;
  status?: EmployeeGiftShippingStatus;
} = {}): Promise<{ rows: EmployeeGiftShippingRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase client unavailable' };

  let q = supabase.from('employee_gift_shipping_details').select(SELECT_COLS);
  if (opts.personalEmail) {
    q = q.eq('personal_email', opts.personalEmail.trim().toLowerCase());
  }
  if (opts.status) q = q.eq('status', opts.status);

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as EmployeeGiftShippingRow[], error: null };
}

/**
 * Insert or update an employee's submission for a given milestone. The
 * unique (personal_email, milestone_index) constraint is the conflict key.
 * Refuses to overwrite a row that has already been approved.
 */
export async function upsertShippingDetail(
  input: UpsertShippingInput,
): Promise<{ row: EmployeeGiftShippingRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };

  const personalEmail = input.personal_email.trim().toLowerCase();

  // Guard against editing an already-approved row.
  const { data: existing } = await supabase
    .from('employee_gift_shipping_details')
    .select('id, status')
    .eq('personal_email', personalEmail)
    .eq('milestone_index', input.milestone_index)
    .maybeSingle();
  if (existing && (existing as { status: string }).status === 'approved') {
    return { row: null, error: 'This submission has been approved and can no longer be edited.' };
  }

  const { data, error } = await supabase
    .from('employee_gift_shipping_details')
    .upsert(
      {
        personal_email: personalEmail,
        milestone_index: input.milestone_index,
        milestone_date: input.milestone_date,
        preferred_delivery_location: input.preferred_delivery_location,
        active_contact_number: input.active_contact_number,
        notes: input.notes,
        // Resubmitting after a rejection moves the row back to pending so the
        // Orphanage team sees the updated answers.
        status: 'pending',
      },
      { onConflict: 'personal_email,milestone_index' },
    )
    .select(SELECT_COLS)
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as EmployeeGiftShippingRow, error: null };
}

/**
 * Orphanage manager edit to shipping fields on an existing row. Lets the
 * manager fix typos in the address / phone / notes on the employee's behalf
 * without changing approval state. Does NOT touch status, gift_*, or decision_*.
 */
export async function editShippingDetailFields(args: {
  id: string;
  preferred_delivery_location?: string;
  active_contact_number?: string;
  notes?: string;
}): Promise<{ row: EmployeeGiftShippingRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };
  const patch: Record<string, unknown> = {};
  if (args.preferred_delivery_location !== undefined) {
    patch.preferred_delivery_location = args.preferred_delivery_location;
  }
  if (args.active_contact_number !== undefined) {
    patch.active_contact_number = args.active_contact_number;
  }
  if (args.notes !== undefined) patch.notes = args.notes;
  if (Object.keys(patch).length === 0) {
    return { row: null, error: 'No fields to update' };
  }
  const { data, error } = await supabase
    .from('employee_gift_shipping_details')
    .update(patch)
    .eq('id', args.id)
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as EmployeeGiftShippingRow, error: null };
}

/** Hard-delete a submission. */
export async function deleteShippingDetail(
  id: string,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase
    .from('employee_gift_shipping_details')
    .delete()
    .eq('id', id);
  return { error: error ? error.message : null };
}

export async function decideShippingDetail(args: {
  id: string;
  status: 'approved' | 'rejected';
  decided_by: string | null;
  decision_note: string | null;
  /** Required when status='approved'. Snapshot the catalog item picked. */
  gift_catalog_item_id?: string | null;
  gift_name?: string | null;
  gift_price_php?: number | null;
}): Promise<{ row: EmployeeGiftShippingRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };

  // On approval, the gift name + price must be present. We snapshot them onto
  // the row so the Accounting view (which queries this table directly) doesn't
  // need to re-resolve them from gift_catalog at read time.
  if (args.status === 'approved') {
    if (!args.gift_name || !args.gift_name.trim()) {
      return { row: null, error: 'Gift name is required when approving' };
    }
    if (
      args.gift_price_php == null ||
      !Number.isFinite(args.gift_price_php) ||
      args.gift_price_php < 0
    ) {
      return { row: null, error: 'A valid PHP gift price is required when approving' };
    }
  }

  const patch: Record<string, unknown> = {
    status: args.status,
    decided_by: args.decided_by,
    decided_at: new Date().toISOString(),
    decision_note: args.decision_note,
  };
  if (args.status === 'approved') {
    patch.gift_catalog_item_id = args.gift_catalog_item_id ?? null;
    patch.gift_name = args.gift_name ?? null;
    patch.gift_price_php = args.gift_price_php ?? null;
  } else {
    // Rejection clears any previously-assigned gift so a re-approval picks fresh.
    patch.gift_catalog_item_id = null;
    patch.gift_name = null;
    patch.gift_price_php = null;
  }

  const { data, error } = await supabase
    .from('employee_gift_shipping_details')
    .update(patch)
    .eq('id', args.id)
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as EmployeeGiftShippingRow, error: null };
}
