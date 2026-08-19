import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';

export type EmployeeGiftShippingStatus = 'pending' | 'approved' | 'rejected';

export interface EmployeeGiftShippingRow {
  id: string;
  personal_email: string;
  milestone_index: number;
  milestone_date: string;
  preferred_delivery_location: string;
  active_contact_number: string;
  /** Employee's apparel size (XS–3XL) for wearable milestone gifts. '' when N/A. */
  apparel_size: string;
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
  apparel_size: string;
  notes: string;
}

const SELECT_COLS =
  'id, personal_email, milestone_index, milestone_date, preferred_delivery_location, active_contact_number, apparel_size, notes, status, decided_by, decided_at, decision_note, gift_catalog_item_id, gift_name, gift_price_php, created_at, updated_at';

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

  // PAGED, not a bare .select(): PostgREST caps a response at 1000 rows even with
  // an explicit .range(). The Gift Tracker export joins these submissions onto the
  // FULL roster, so a truncated read wouldn't shorten the export — it would blank
  // the shipping address on real people and read as "never submitted". Ordered by
  // the unique key so pages can't shear under a concurrent submit.
  const { rows, error } = await selectAllPaged<EmployeeGiftShippingRow>((from, to) => {
    let q = supabase.from('employee_gift_shipping_details').select(SELECT_COLS);
    if (opts.personalEmail) {
      q = q.eq('personal_email', opts.personalEmail.trim().toLowerCase());
    }
    if (opts.status) q = q.eq('status', opts.status);
    return q
      .order('personal_email', { ascending: true })
      .order('milestone_index', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: EmployeeGiftShippingRow[] | null;
        error: { message: string } | null;
      }>;
  });
  if (error) return { rows: [], error };
  return { rows, error: null };
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
        apparel_size: input.apparel_size ?? '',
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
  apparel_size?: string;
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
  if (args.apparel_size !== undefined) patch.apparel_size = args.apparel_size;
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
}): Promise<{ row: EmployeeGiftShippingRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };

  // Tenure gifts are informational only now — approval just locks the submitted
  // details. No gift/price is assigned (the milestone→gift mapping lives in the
  // catalog, and gifts carry no payment or price).
  const patch: Record<string, unknown> = {
    status: args.status,
    decided_by: args.decided_by,
    decided_at: new Date().toISOString(),
    decision_note: args.decision_note,
  };

  const { data, error } = await supabase
    .from('employee_gift_shipping_details')
    .update(patch)
    .eq('id', args.id)
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as EmployeeGiftShippingRow, error: null };
}
