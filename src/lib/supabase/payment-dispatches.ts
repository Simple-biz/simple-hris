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

  let q = supabase
    .from("payment_dispatches")
    .select("*")
    .order("created_at", { ascending: false });

  if (params.cycleId !== undefined) {
    if (params.cycleId === null) q = q.is("cycle_id", null);
    else q = q.eq("cycle_id", params.cycleId);
  }

  if (params.recipientEmail) {
    q = q.eq("recipient_email", params.recipientEmail.trim().toLowerCase());
  }

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as PaymentDispatchRow[], error: null };
}

/**
 * Deletes dispatch rows by id ("send back to the pay processor" — undo a
 * payment so the recipient drops out of paid and reappears in the pending
 * queue). The disbursement_records sync trigger reverts the matching record to
 * status='pending' on delete. Returns how many rows were removed.
 */
export async function deletePaymentDispatches(
  ids: string[],
): Promise<{ deleted: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { deleted: 0, error: "Supabase client unavailable" };
  if (ids.length === 0) return { deleted: 0, error: null };

  // supabase-js encodes `.in('id', ids)` into the request URL as
  // `?id=in.(uuid1,uuid2,…)`. A large multi-select (e.g. "select all" → 100+
  // UUIDs) overflows the gateway's URL-length limit and fails as a generic
  // "bad request"/500. Deleting in batches keeps each request small and also
  // isolates any single failing row to its own batch.
  const CHUNK = 50;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("payment_dispatches")
      .delete()
      .in("id", batch)
      .select("id");
    if (error) {
      const detail = [error.message, error.details, error.hint, error.code]
        .filter(Boolean)
        .join(" · ");
      console.error("[deletePaymentDispatches] batch delete failed", {
        batchSize: batch.length,
        deletedSoFar: deleted,
        error,
      });
      return { deleted, error: detail || "Delete failed" };
    }
    deleted += (data ?? []).length;
  }
  return { deleted, error: null };
}
