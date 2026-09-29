/**
 * `employee_gift_receipts` — the tenure-gift fulfilment ledger.
 *
 * Keyed by WORK email, deliberately: `employee_gift_shipping_details` is
 * UNIQUE (personal_email, milestone_index), and personal_email is not injective
 * on this roster (two people share one, a third has none). See
 * references/sql/migrate/2026-09-11_gift_receipts.sql for the full reasoning.
 *
 * A row is an assertion that somebody made. THE ABSENCE OF A ROW IS "UNKNOWN",
 * never "not received" — `src/lib/gift-tracker/receipts.ts` is the only place
 * that turns rows into a verdict, and it keeps the two apart.
 */
import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';

/** Where an assertion came from. Mirrors the CHECK constraint on the table. */
export type GiftReceiptSource = 'sheet_import' | 'hris';

export interface EmployeeGiftReceiptRow {
  id: string;
  work_email: string;
  milestone_index: number;
  received: boolean;
  /** What the SOURCE claimed the milestone date was. Evidence, not a date rule. */
  source_milestone_date: string | null;
  source: GiftReceiptSource;
  source_file: string | null;
  note: string;
  recorded_by: string;
  recorded_at: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertGiftReceiptInput {
  work_email: string;
  milestone_index: number;
  received: boolean;
  source: GiftReceiptSource;
  source_file?: string | null;
  source_milestone_date?: string | null;
  note?: string;
  /** The signed-in actor. Never read from a request body. */
  recorded_by: string;
}

const SELECT_COLS =
  'id, work_email, milestone_index, received, source_milestone_date, source, source_file, note, recorded_by, recorded_at, created_at, updated_at';

/**
 * Every receipt on file, or one person's when `workEmail` is passed.
 *
 * PAGED, not a bare `.select()`. The Gift Tracker joins these onto the FULL
 * roster, so a PostgREST truncation at 1000 rows would not shorten anything
 * visible — it would silently turn real `received` rows into `unknown` and
 * print people as owed a gift they already have. Same failure mode, and the
 * same fix, as `listShippingDetails`.
 */
export async function listGiftReceipts(
  opts: { workEmail?: string | null } = {},
): Promise<{ rows: EmployeeGiftReceiptRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase client unavailable' };

  const { rows, error } = await selectAllPaged<EmployeeGiftReceiptRow>((from, to) => {
    let q = supabase.from('employee_gift_receipts').select(SELECT_COLS);
    if (opts.workEmail) q = q.eq('work_email', opts.workEmail.trim().toLowerCase());
    return q
      .order('work_email', { ascending: true })
      .order('milestone_index', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: EmployeeGiftReceiptRow[] | null;
        error: { message: string } | null;
      }>;
  });
  if (error) return { rows: [], error };
  return { rows, error: null };
}

/**
 * Record (or correct) one assertion. The unique
 * (work_email, milestone_index) constraint is the conflict key, so re-stating
 * the same gift updates the row rather than growing a second opinion.
 *
 * `recorded_by` is required by the table, not just by this type: the
 * PAB-exclusion table shipped without an author column and 107 entries are
 * permanently unattributable. Every correction here carries who made it.
 */
export async function upsertGiftReceipt(
  input: UpsertGiftReceiptInput,
): Promise<{ row: EmployeeGiftReceiptRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };

  const { data, error } = await supabase
    .from('employee_gift_receipts')
    .upsert(
      {
        work_email: input.work_email.trim().toLowerCase(),
        milestone_index: input.milestone_index,
        received: input.received,
        source: input.source,
        source_file: input.source_file ?? null,
        source_milestone_date: input.source_milestone_date ?? null,
        note: input.note ?? '',
        recorded_by: input.recorded_by,
        recorded_at: new Date().toISOString(),
      },
      { onConflict: 'work_email,milestone_index' },
    )
    .select(SELECT_COLS)
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as EmployeeGiftReceiptRow, error: null };
}

/** One (person, milestone) assertion, or null when nobody has stated anything. */
export async function getGiftReceipt(args: {
  workEmail: string;
  milestoneIndex: number;
}): Promise<{ row: EmployeeGiftReceiptRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };

  const { data, error } = await supabase
    .from('employee_gift_receipts')
    .select(SELECT_COLS)
    .eq('work_email', args.workEmail.trim().toLowerCase())
    .eq('milestone_index', args.milestoneIndex)
    .maybeSingle();

  if (error) return { row: null, error: error.message };
  return { row: (data as EmployeeGiftReceiptRow | null) ?? null, error: null };
}

/**
 * Record one assertion ONLY IF the row is still in the state the caller read —
 * the app's write path (the importer keeps `upsertGiftReceipt`).
 *
 *   expectReceived undefined → INSERT; a unique violation means somebody else
 *                              recorded it in between → `conflict`.
 *   expectReceived boolean   → UPDATE … WHERE received = expectReceived; no row
 *                              updated means it changed in between → `conflict`.
 *
 * Without this, the route's "received cannot become owed" check is a read
 * followed by an unconditional upsert, and a Received landing between the two
 * would be overwritten with owed.
 */
export async function writeGiftReceiptIfUnchanged(
  input: UpsertGiftReceiptInput & { expectReceived: boolean | undefined },
): Promise<{ row: EmployeeGiftReceiptRow | null; conflict: boolean; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, conflict: false, error: 'Supabase client unavailable' };

  const workEmail = input.work_email.trim().toLowerCase();
  const values = {
    received: input.received,
    source: input.source,
    source_file: input.source_file ?? null,
    source_milestone_date: input.source_milestone_date ?? null,
    note: input.note ?? '',
    recorded_by: input.recorded_by,
    recorded_at: new Date().toISOString(),
  };

  if (input.expectReceived === undefined) {
    const { data, error } = await supabase
      .from('employee_gift_receipts')
      .insert({ work_email: workEmail, milestone_index: input.milestone_index, ...values })
      .select(SELECT_COLS)
      .single();
    if (error) {
      if (error.code === '23505') return { row: null, conflict: true, error: null };
      return { row: null, conflict: false, error: error.message };
    }
    return { row: data as EmployeeGiftReceiptRow, conflict: false, error: null };
  }

  const { data, error } = await supabase
    .from('employee_gift_receipts')
    .update(values)
    .eq('work_email', workEmail)
    .eq('milestone_index', input.milestone_index)
    .eq('received', input.expectReceived)
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) return { row: null, conflict: false, error: error.message };
  if (!data) return { row: null, conflict: true, error: null };
  return { row: data as EmployeeGiftReceiptRow, conflict: false, error: null };
}

/**
 * Withdraw an assertion entirely, returning the (person, milestone) to UNKNOWN.
 *
 * This is a real and necessary operation, distinct from setting `received`
 * false: "we were wrong to say anything" is not the same statement as "they did
 * not get it", and only one of the two puts a person on the owed list.
 */
export async function deleteGiftReceipt(args: {
  workEmail: string;
  milestoneIndex: number;
  /** Delete only while the row still says this — the state the reason was written about. */
  expectReceived?: boolean;
}): Promise<{ row: EmployeeGiftReceiptRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };

  // Return the deleted row so the caller can snapshot it into the audit trail.
  let q = supabase
    .from('employee_gift_receipts')
    .delete()
    .eq('work_email', args.workEmail.trim().toLowerCase())
    .eq('milestone_index', args.milestoneIndex);
  if (args.expectReceived !== undefined) q = q.eq('received', args.expectReceived);
  const { data, error } = await q.select(SELECT_COLS).maybeSingle();

  if (error) return { row: null, error: error.message };
  return { row: (data as EmployeeGiftReceiptRow | null) ?? null, error: null };
}
