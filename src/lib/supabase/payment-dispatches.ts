import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "./server";

export type PaymentDispatchStatus = "paid" | "not_paid" | "threshold" | "problem";

export type PaymentDispatchRow = {
  id: string;
  cycle_id: string | null;
  cycle_period_start: string | null;
  cycle_period_end: string | null;
  cycle_source_file: string | null;
  recipient_email: string;
  recipient_name: string | null;
  processor: string;
  bank_preferred_raw: string | null;
  /** Snapshotted recipient banking — where the money went TO. */
  recipient_preferred_bank: string | null;
  recipient_account_number: string | null;
  recipient_account_holder: string | null;
  recipient_swift_code: string | null;
  amount_usd: number | null;
  amount_php: number | null;
  /** Native COP amount (whole pesos) when the recipient is paid in COP; null otherwise. */
  amount_cop: number | null;
  transaction_id: string;
  bank_used: string;
  sent_date: string;
  arrival_date: string | null;
  /** Outcome of this dispatch — defaults to 'paid'. */
  status: PaymentDispatchStatus;
  /** Free-text note Lenny can attach (e.g. "bank rejected, retrying tomorrow"). */
  note: string | null;
  /**
   * Which kind of payee this row paid. 'employee' (the DB default, so every
   * pre-existing row reads correctly) = hourly payroll. 'contractor' = settles
   * one approved `contractor_invoices` row, identified by contractor_invoice_id.
   *
   * Also read by `sync_disbursement_from_dispatch()`: contractor rows return
   * early there, so paying an invoice can't overwrite that person's employee
   * disbursement record for the same week.
   */
  payee_type: 'employee' | 'contractor';
  /** The invoice this row settled. Cleared by trigger if the row is deleted (Undo). */
  contractor_invoice_id: string | null;
  /**
   * PHP amount of the Payment Catalog system bonus (PAB / Technology Bonus, or
   * a custom variant) already included in `amount_php`, snapshotted at Mark
   * Paid. Null when this dispatch carried no system bonus, or when it predates
   * `add_system_bonus_to_payment_dispatches.sql`.
   */
  system_bonus_php: number | null;
  /** Human-readable breakdown, e.g. "PAB ₱5,000 + Tech ₱1,850". Null when `system_bonus_php` is null. */
  system_bonus_label: string | null;
  created_by: string | null;
  created_at: string;
};

export interface InsertPaymentDispatchInput {
  cycle_id?: string | null;
  cycle_period_start?: string | null;
  cycle_period_end?: string | null;
  cycle_source_file?: string | null;
  recipient_email: string;
  recipient_name?: string | null;
  processor: string;
  bank_preferred_raw?: string | null;
  recipient_preferred_bank?: string | null;
  recipient_account_number?: string | null;
  recipient_account_holder?: string | null;
  recipient_swift_code?: string | null;
  amount_usd?: number | null;
  amount_php?: number | null;
  amount_cop?: number | null;
  transaction_id: string;
  bank_used: string;
  sent_date: string;
  arrival_date?: string | null;
  status?: PaymentDispatchStatus;
  note?: string | null;
  /** Defaults to 'employee' so every existing call site keeps its meaning. */
  payee_type?: 'employee' | 'contractor';
  contractor_invoice_id?: string | null;
  /** See {@link PaymentDispatchRow.system_bonus_php}. Omit/null when this dispatch carries no system bonus. */
  system_bonus_php?: number | null;
  system_bonus_label?: string | null;
  created_by?: string | null;
}

export async function insertPaymentDispatch(
  input: InsertPaymentDispatchInput,
): Promise<{ row: PaymentDispatchRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { row: null, error: "Supabase client unavailable" };

  const { data, error } = await supabase
    .from("payment_dispatches")
    .insert({
      cycle_id: input.cycle_id ?? null,
      cycle_period_start: input.cycle_period_start ?? null,
      cycle_period_end: input.cycle_period_end ?? null,
      cycle_source_file: input.cycle_source_file ?? null,
      recipient_email: input.recipient_email,
      recipient_name: input.recipient_name ?? null,
      processor: input.processor,
      bank_preferred_raw: input.bank_preferred_raw ?? null,
      recipient_preferred_bank: input.recipient_preferred_bank ?? null,
      recipient_account_number: input.recipient_account_number ?? null,
      recipient_account_holder: input.recipient_account_holder ?? null,
      recipient_swift_code: input.recipient_swift_code ?? null,
      amount_usd: input.amount_usd ?? null,
      amount_php: input.amount_php ?? null,
      amount_cop: input.amount_cop ?? null,
      transaction_id: input.transaction_id,
      bank_used: input.bank_used,
      sent_date: input.sent_date,
      arrival_date: input.arrival_date ?? null,
      status: input.status ?? "paid",
      note: input.note ?? null,
      // Named ONLY for a contractor payment. PostgREST rejects a payload that
      // mentions an unknown column (PGRST204, from its schema cache) before the
      // row is ever written, so naming these unconditionally would 500 EVERY
      // insert — employee Mark Paid, MESA disbursements and urgent one-offs all
      // route through this one function — until
      // references/sql/alter/add_contractor_dispatch_link.sql is applied.
      // Omitting them is semantically identical for employees: payee_type
      // defaults to 'employee' in the DB.
      ...(input.payee_type === "contractor"
        ? {
            payee_type: "contractor",
            contractor_invoice_id: input.contractor_invoice_id ?? null,
          }
        : {}),
      // Named ONLY when a system bonus is actually present — same PGRST204
      // reasoning as payee_type above, applied to
      // add_system_bonus_to_payment_dispatches.sql: naming these unconditionally
      // would 500 EVERY dispatch insert until that migration is applied, since
      // most weeks carry no bonus and would otherwise never exercise this path.
      ...(input.system_bonus_php != null
        ? {
            system_bonus_php: input.system_bonus_php,
            system_bonus_label: input.system_bonus_label ?? null,
          }
        : {}),
      created_by: input.created_by ?? null,
    })
    .select("*")
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as PaymentDispatchRow, error: null };
}

export async function listPaymentDispatches(params: {
  cycleId?: string | null;
  recipientEmail?: string;
} = {}): Promise<{ rows: PaymentDispatchRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { rows: [], error: "Supabase client unavailable" };

  // Paged: PostgREST silently caps un-ranged selects at 1,000 rows. The table
  // passed 3,700 rows in Jul 2026 (a single cycle can pay 1,000+ people), so an
  // un-paged read returns only the newest slice with no error.
  const PAGE = 1000;
  const rows: PaymentDispatchRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("payment_dispatches")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);

    if (params.cycleId !== undefined) {
      if (params.cycleId === null) q = q.is("cycle_id", null);
      else q = q.eq("cycle_id", params.cycleId);
    }

    if (params.recipientEmail) {
      q = q.eq("recipient_email", params.recipientEmail.trim().toLowerCase());
    }

    const { data, error } = await q;
    if (error) return { rows: [], error: error.message };
    rows.push(...((data ?? []) as PaymentDispatchRow[]));
    if (!data || data.length < PAGE) break;
  }
  return { rows, error: null };
}

/**
 * A cheap fingerprint of one cycle's dispatch activity: how many rows exist and
 * when the newest one was written.
 *
 * Backs the Payment Dispatch queue's fallback poll. The queue needs to know
 * *whether* anything changed, and paging ~1,000 full rows every few seconds to
 * find out — on every open accounting tab — would be absurd. Two indexed
 * aggregate reads instead: a HEAD count and one ordered row.
 *
 * Any INSERT (a payment logged), UPDATE (status corrected) or DELETE (an Undo)
 * moves at least one of the two, EXCEPT the pathological case of a delete and an
 * insert landing between two polls with the count unchanged and an older
 * `created_at` — which the Realtime broadcast covers, and the next real change
 * corrects.
 */
export async function getPaymentDispatchSignature(
  cycleId: string | null,
): Promise<{ count: number; latest: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { count: 0, latest: null, error: "Supabase client unavailable" };

  const countBase = supabase.from("payment_dispatches").select("id", { count: "exact", head: true });
  const latestBase = supabase
    .from("payment_dispatches")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);

  const [countRes, latestRes] = await Promise.all([
    cycleId === null ? countBase.is("cycle_id", null) : countBase.eq("cycle_id", cycleId),
    cycleId === null ? latestBase.is("cycle_id", null) : latestBase.eq("cycle_id", cycleId),
  ]);

  if (countRes.error) return { count: 0, latest: null, error: countRes.error.message };
  if (latestRes.error) return { count: 0, latest: null, error: latestRes.error.message };
  const latestRow = (latestRes.data ?? [])[0] as { created_at?: string } | undefined;
  return {
    count: countRes.count ?? 0,
    latest: latestRow?.created_at ?? null,
    error: null,
  };
}

/**
 * Deletes dispatch rows by id ("send back to the pay processor" — undo a
 * payment so the recipient drops out of paid and reappears in the pending
 * queue). The disbursement_records sync trigger reverts the matching record to
 * status='pending' on delete. Returns how many rows were removed.
 */
export async function deletePaymentDispatches(
  ids: string[],
): Promise<{ deleted: number; deletedRows: PaymentDispatchRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { deleted: 0, deletedRows: [], error: "Supabase client unavailable" };
  if (ids.length === 0) return { deleted: 0, deletedRows: [], error: null };

  // supabase-js encodes `.in('id', ids)` into the request URL as
  // `?id=in.(uuid1,uuid2,…)`. A large multi-select (e.g. "select all" → 100+
  // UUIDs) overflows the gateway's URL-length limit and fails as a generic
  // "bad request"/500. Deleting in batches keeps each request small and also
  // isolates any single failing row to its own batch.
  //
  // `.select("*")` (not "id"): the RETURNING clause is the last atomic look at
  // rows this call destroys — the undo route's `payment.undone` audit events
  // are built from these, so a pre-delete snapshot race can never blank them.
  const CHUNK = 50;
  const deletedRows: PaymentDispatchRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("payment_dispatches")
      .delete()
      .in("id", batch)
      .select("*");
    if (error) {
      const detail = [error.message, error.details, error.hint, error.code]
        .filter(Boolean)
        .join(" · ");
      console.error("[deletePaymentDispatches] batch delete failed", {
        batchSize: batch.length,
        deletedSoFar: deletedRows.length,
        error,
      });
      return { deleted: deletedRows.length, deletedRows, error: detail || "Delete failed" };
    }
    for (const row of (data ?? []) as PaymentDispatchRow[]) deletedRows.push(row);
  }
  return { deleted: deletedRows.length, deletedRows, error: null };
}

/** One PAID dispatch row as the lower-left "X paid Y $Z" toast needs it. */
export interface RecentPaidDispatch {
  id: string;
  created_by: string | null;
  recipient_email: string;
  recipient_name: string | null;
  amount_usd: number | null;
  amount_php: number | null;
  amount_cop: number | null;
  processor: string | null;
  cycle_source_file: string | null;
  created_at: string;
}

/** Rows per poll tick. Deliberately BOUNDED, not paged: this is a rolling
 *  watermark read — the client advances `since` to `latest` and, when
 *  `truncated`, polls again at once, so nothing is lost and no tick ever
 *  pages a whole cycle. */
export const RECENT_PAID_LIMIT = 50;

const RECENT_PAID_COLUMNS =
  "id, created_by, recipient_email, recipient_name, amount_usd, amount_php, amount_cop, processor, cycle_source_file, created_at";

/**
 * PAID dispatch rows written strictly after `sinceIso`, oldest first, for the
 * Accounting shell's toast poll (the fallback for a payer whose browser runs an
 * older build or whose Realtime socket is down).
 *
 * `sinceIso === null` establishes the watermark: returns NO rows, only the
 * newest paid `created_at`, so a screen that opens mid-cycle does not replay
 * history and the client never trusts its own clock against the database's.
 */
export async function listRecentPaidDispatches(
  sinceIso: string | null,
): Promise<{
  rows: RecentPaidDispatch[];
  /** Newest `created_at` the caller now knows about — the next `since`. */
  latest: string | null;
  truncated: boolean;
  /** Server clock, so freshness is judged against the database's timeline. */
  now: string;
  error: string | null;
}> {
  const now = new Date().toISOString();
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { rows: [], latest: null, truncated: false, now, error: "Supabase client unavailable" };
  }

  if (sinceIso === null) {
    const { data, error } = await supabase
      .from("payment_dispatches")
      .select("created_at")
      .eq("status", "paid")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return { rows: [], latest: null, truncated: false, now, error: error.message };
    const latest = ((data ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null;
    return { rows: [], latest, truncated: false, now, error: null };
  }

  const { data, error } = await supabase
    .from("payment_dispatches")
    .select(RECENT_PAID_COLUMNS)
    .eq("status", "paid")
    .gt("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(RECENT_PAID_LIMIT);
  if (error) return { rows: [], latest: sinceIso, truncated: false, now, error: error.message };
  const rows = (data ?? []) as unknown as RecentPaidDispatch[];
  const latest = rows.length > 0 ? rows[rows.length - 1].created_at : sinceIso;
  return { rows, latest, truncated: rows.length >= RECENT_PAID_LIMIT, now, error: null };
}

/**
 * Every `paid` row already logged for ONE person in ONE cycle — the read behind
 * the server-side double-pay guard in `POST /api/payment-dispatches`
 * (`findDuplicatePaid` decides; this only fetches).
 *
 * Keyed by `cycle_source_file` when the body names one, else by `cycle_id`: the
 * arrears "Settle" legs POST with `cycle_id: null`, so the file is the only key
 * that identifies their cycle. Case-insensitive on the email (`ilike` with no
 * wildcard is an equality test) because rows written before the normalisation
 * trigger may carry mixed case. Bounded: one person in one cycle has a handful
 * of rows at most, never a page.
 */
export async function listPaidDispatchesForRecipientCycle(params: {
  cycleSourceFile: string | null;
  cycleId: string | null;
  recipientEmail: string;
}): Promise<{ rows: PaymentDispatchRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { rows: [], error: "Supabase client unavailable" };
  const file = params.cycleSourceFile?.trim() || null;
  if (!file && !params.cycleId) return { rows: [], error: null };

  let q = supabase
    .from("payment_dispatches")
    .select("*")
    .eq("status", "paid")
    .ilike("recipient_email", params.recipientEmail.trim())
    .order("created_at", { ascending: true })
    .limit(50);
  q = file ? q.eq("cycle_source_file", file) : q.eq("cycle_id", params.cycleId as string);

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as PaymentDispatchRow[], error: null };
}
