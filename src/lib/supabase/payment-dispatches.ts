import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "./server";

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
  amount_usd: number | null;
  amount_php: number | null;
  transaction_id: string;
  bank_used: string;
  sent_date: string;
  arrival_date: string | null;
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
  amount_usd?: number | null;
  amount_php?: number | null;
  transaction_id: string;
  bank_used: string;
  sent_date: string;
  arrival_date?: string | null;
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
      amount_usd: input.amount_usd ?? null,
      amount_php: input.amount_php ?? null,
      transaction_id: input.transaction_id,
      bank_used: input.bank_used,
      sent_date: input.sent_date,
      arrival_date: input.arrival_date ?? null,
      created_by: input.created_by ?? null,
    })
    .select("*")
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as PaymentDispatchRow, error: null };
}

export async function listPaymentDispatches(params: {
  cycleId?: string | null;
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

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as PaymentDispatchRow[], error: null };
}
