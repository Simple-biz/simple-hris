import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "./server";

/**
 * One staged paystub per (cycle, employee). Written by the Payroll Wizard's
 * "Lock in Values & Send to Payment Dispatch" action; read by the mark-paid
 * send path (POST /api/payment-dispatches) and by the dispatch queue (to move
 * wizard-excluded people into the Excluded tab).
 *
 * `payload` is the exact per-employee object the old batch dispatch posted to
 * n8n (name, personal_email, hours, rates_php, pay_php breakdown, …). It is
 * staged for EVERYONE with a resolvable personal email — including the
 * `excluded` ("do not pay") set — so they can still be paid + emailed later
 * from the Excluded tab once accounting clears them.
 */
export interface PaystubQueueEntryInput {
  recipient_email: string;
  personal_email?: string | null;
  recipient_name?: string | null;
  department_key?: string | null;
  amount_php?: number | null;
  amount_usd?: number | null;
  payload?: Record<string, unknown> | null;
  excluded?: boolean;
  exclude_reason?: string | null;
}

/** Lightweight row for the dispatch queue (no heavy `payload` / `pay_period`). */
export interface PaystubQueueListItem {
  id: string;
  cycle_source_file: string;
  recipient_email: string;
  personal_email: string | null;
  recipient_name: string | null;
  department_key: string | null;
  excluded: boolean;
  exclude_reason: string | null;
  amount_php: number | null;
  amount_usd: number | null;
  sent_at: string | null;
  sent_by: string | null;
  send_count: number;
  last_error: string | null;
}

/** Full row including the n8n payload — used by the single-send path. */
export interface PaystubQueueEntry extends PaystubQueueListItem {
  pay_period: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  locked_at: string | null;
  locked_by: string | null;
}

const LIST_COLUMNS =
  "id, cycle_source_file, recipient_email, personal_email, recipient_name, department_key, excluded, exclude_reason, amount_php, amount_usd, sent_at, sent_by, send_count, last_error";

function norm(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Replace-for-cycle stage. Upserts every entry under `sourceFile` and removes
 * stale rows (people no longer in this run) — but never deletes a row whose
 * paystub already went out (`sent_at` set), so re-locking after a partial pay
 * run can't drop the paid history. Send-tracking columns are intentionally
 * omitted from the upsert so they survive a re-stage.
 */
export async function upsertPaystubDispatchQueue(params: {
  sourceFile: string;
  payPeriod: Record<string, unknown> | null;
  lockedBy: string | null;
  entries: PaystubQueueEntryInput[];
}): Promise<{ staged: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { staged: 0, error: "Supabase client unavailable" };

  const lockedAt = new Date().toISOString();
  const rows = params.entries.map((e) => ({
    cycle_source_file: params.sourceFile,
    recipient_email: norm(e.recipient_email),
    personal_email: e.personal_email ? norm(e.personal_email) : null,
    recipient_name: e.recipient_name ?? null,
    department_key: e.department_key ?? null,
    amount_php: e.amount_php ?? null,
    amount_usd: e.amount_usd ?? null,
    pay_period: params.payPeriod,
    payload: e.payload ?? null,
    excluded: e.excluded ?? false,
    exclude_reason: e.exclude_reason ?? null,
    locked_at: lockedAt,
    locked_by: params.lockedBy,
  }));

  if (rows.length > 0) {
    const { error } = await supabase
      .from("paystub_dispatch_queue")
      .upsert(rows, { onConflict: "cycle_source_file,recipient_email" });
    if (error) return { staged: 0, error: error.message };
  }

  // Prune people no longer in this run (but keep anyone already sent). We diff
  // against the existing emails and delete only the (usually small) stale set,
  // rather than a NOT-IN over ~all employees — a big NOT-IN list would be sent
  // in the request URL and can blow the URL-length limit on a full run.
  const keep = new Set(rows.map((r) => r.recipient_email));
  const { data: existing, error: exErr } = await supabase
    .from("paystub_dispatch_queue")
    .select("recipient_email")
    .eq("cycle_source_file", params.sourceFile)
    .is("sent_at", null);
  if (exErr) return { staged: rows.length, error: exErr.message };
  const stale = (existing ?? [])
    .map((r) => (r as { recipient_email: string }).recipient_email)
    .filter((e) => !keep.has(e));
  // Chunk the delete: an `.in(...)` list rides in the request URL, so a big
  // stale set (bulk re-stage / recovery) could overflow the URL-length cap.
  // 30 emails/batch keeps each request well under it.
  const DELETE_BATCH = 30;
  for (let i = 0; i < stale.length; i += DELETE_BATCH) {
    const batch = stale.slice(i, i + DELETE_BATCH);
    const { error: delErr } = await supabase
      .from("paystub_dispatch_queue")
      .delete()
      .eq("cycle_source_file", params.sourceFile)
      .is("sent_at", null)
      .in("recipient_email", batch);
    if (delErr) return { staged: rows.length, error: delErr.message };
  }

  return { staged: rows.length, error: null };
}

/**
 * Overwrite one staged row's figures with a fresher payload (the wizard-snapshot
 * merge from `paystub-fresh.ts`), so the queue row records exactly what was
 * emailed/paid. Send-tracking and lock columns are untouched — this refreshes the
 * WHAT, not the WHO/WHEN of the stage.
 */
export async function refreshPaystubQueuePayload(params: {
  sourceFile: string;
  recipientEmail: string;
  payload: Record<string, unknown>;
  payPeriod: Record<string, unknown> | null;
  amountPhp: number | null;
  amountUsd: number | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { error: "Supabase client unavailable" };
  const { error } = await supabase
    .from("paystub_dispatch_queue")
    .update({
      payload: params.payload,
      pay_period: params.payPeriod,
      amount_php: params.amountPhp,
      amount_usd: params.amountUsd,
    })
    .eq("cycle_source_file", params.sourceFile)
    .eq("recipient_email", norm(params.recipientEmail));
  return { error: error ? error.message : null };
}

/** Single staged row (with payload) by cycle + work email. */
export async function getPaystubDispatchEntry(
  sourceFile: string,
  recipientEmail: string,
): Promise<{ row: PaystubQueueEntry | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { row: null, error: "Supabase client unavailable" };

  const { data, error } = await supabase
    .from("paystub_dispatch_queue")
    .select("*")
    .eq("cycle_source_file", sourceFile)
    .eq("recipient_email", norm(recipientEmail))
    .maybeSingle();

  if (error) return { row: null, error: error.message };
  return { row: (data as PaystubQueueEntry | null) ?? null, error: null };
}

/**
 * Every cycle for one employee that has a renderable staged paystub (payload not
 * null). Lightweight — the heavy `payload`/`pay_period` columns are filtered on
 * but never selected. Backs the employee-facing "Open Paystubs" affordance,
 * which is then intersected with PAID payment_dispatches so an employee only
 * opens statements for weeks they were actually paid.
 */
export async function listPaystubEntriesForEmployee(
  email: string,
): Promise<{
  rows: Array<{ cycle_source_file: string; sent_at: string | null }>;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { rows: [], error: "Supabase client unavailable" };

  const { data, error } = await supabase
    .from("paystub_dispatch_queue")
    .select("cycle_source_file, sent_at")
    .eq("recipient_email", norm(email))
    .not("payload", "is", null);

  if (error) return { rows: [], error: error.message };
  const rows = (data ?? []).map((r) => {
    const row = r as { cycle_source_file: string; sent_at: string | null };
    return { cycle_source_file: row.cycle_source_file, sent_at: row.sent_at ?? null };
  });
  return { rows, error: null };
}

/**
 * Every renderable staged paystub for one employee, WITH its payload + pay_period
 * — one query, no N+1. Backs the "Pay Stubs" profile tab and its all-weeks
 * PDF/XLSX export. The caller intersects these with PAID payment_dispatches so an
 * employee only ever sees statements for weeks they were actually paid.
 */
export async function listPaystubPayloadsForEmployee(
  email: string,
): Promise<{
  rows: Array<{
    cycle_source_file: string;
    recipient_email: string;
    pay_period: Record<string, unknown> | null;
    payload: Record<string, unknown> | null;
    locked_at: string | null;
    excluded: boolean;
  }>;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { rows: [], error: "Supabase client unavailable" };

  const { data, error } = await supabase
    .from("paystub_dispatch_queue")
    .select("cycle_source_file, recipient_email, pay_period, payload, locked_at, excluded")
    .eq("recipient_email", norm(email))
    .not("payload", "is", null);

  if (error) return { rows: [], error: error.message };
  const rows = (data ?? []).map((r) => {
    const row = r as {
      cycle_source_file: string;
      recipient_email: string;
      pay_period: Record<string, unknown> | null;
      payload: Record<string, unknown> | null;
      locked_at: string | null;
      excluded: boolean | null;
    };
    return {
      cycle_source_file: row.cycle_source_file,
      recipient_email: row.recipient_email,
      pay_period: row.pay_period ?? null,
      payload: row.payload ?? null,
      locked_at: row.locked_at ?? null,
      excluded: row.excluded ?? false,
    };
  });
  return { rows, error: null };
}

/** Lightweight list for a cycle — drives the queue's Excluded-bucket routing. */
export async function listPaystubDispatchQueue(
  sourceFile: string,
): Promise<{ rows: PaystubQueueListItem[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { rows: [], error: "Supabase client unavailable" };

  const { data, error } = await supabase
    .from("paystub_dispatch_queue")
    .select(LIST_COLUMNS)
    .eq("cycle_source_file", sourceFile);

  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as PaystubQueueListItem[], error: null };
}

/** One unpaid held cycle in an employee's arrears ledger. */
export interface ArrearsCycle {
  sourceFile: string;
  amountPhp: number | null;
  amountUsd: number | null;
  lockedAt: string | null;
  paystubSentAt: string | null;
  lastError: string | null;
}

/** An employee's cumulative pending pay across all unpaid held cycles. */
export interface ArrearsEntry {
  email: string;
  name: string | null;
  totalPhp: number;
  totalUsd: number;
  cycles: ArrearsCycle[];
}

/**
 * Cross-cycle arrears: every employee with `excluded=true` staged rows that have
 * NOT been settled, summed into a running total with a per-cycle breakdown.
 *
 * "Settled" is keyed on a PAID payment_dispatches row for that (cycle, email) —
 * i.e. money actually moved — not on `sent_at` (which only reflects the paystub
 * email and is best-effort). So a held employee accumulates pending pay each
 * cycle they're not paid, and a cycle drops off the ledger only once it's paid.
 */
export async function listExcludedArrears(): Promise<{
  entries: ArrearsEntry[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { entries: [], error: "Supabase client unavailable" };

  // PAGINATED. PostgREST caps a response at 1000 rows and BOTH selects here span
  // every cycle, not one: live there are ~7.7k staged rows and ~3.2k paid
  // dispatches. Unranged, `held` silently lost rows and — far worse — `paidSet`
  // below saw an arbitrary ~30% sample of settlements, so an ALREADY-PAID held week
  // reappeared on the arrears ledger as still owed. (Pre-existing; fixed here
  // because this function's paid-set is now also payee-filtered.)
  const PAGE = 1000;

  type HeldRow = {
    cycle_source_file: string | null;
    recipient_email: string;
    recipient_name: string | null;
    amount_php: number | null;
    amount_usd: number | null;
    locked_at: string | null;
    sent_at: string | null;
    last_error: string | null;
  };
  const held: HeldRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("paystub_dispatch_queue")
      .select(
        "cycle_source_file, recipient_email, recipient_name, amount_php, amount_usd, locked_at, sent_at, last_error",
      )
      .eq("excluded", true)
      .range(from, from + PAGE - 1);
    if (error) return { entries: [], error: error.message };
    const page = (data ?? []) as HeldRow[];
    held.push(...page);
    if (page.length < PAGE) break;
  }

  // `payee_type` is selected so contractor-invoice settlements can be excluded
  // below. It only exists after add_contractor_dispatch_link.sql, so retry without
  // it — correct in that case, since no contractor dispatch row can exist yet.
  type PaidRow = { cycle_source_file: string | null; recipient_email: string; payee_type?: string | null };
  const paid: PaidRow[] = [];
  {
    // Probe once for the column, then page through with whichever select works.
    const probe = await supabase.from("payment_dispatches").select("payee_type").limit(1);
    let columns = "cycle_source_file, recipient_email, payee_type";
    if (probe.error) {
      const isMissingColumn =
        probe.error.code === "42703" ||
        probe.error.code === "PGRST204" ||
        /payee_type/.test(probe.error.message ?? "");
      // Only a missing column may drop the payee filter — a transient error must
      // not silently reintroduce the "invoice settles a salary" defect.
      if (!isMissingColumn) return { entries: [], error: probe.error.message };
      columns = "cycle_source_file, recipient_email";
    }
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("payment_dispatches")
        .select(columns)
        .eq("status", "paid")
        .range(from, from + PAGE - 1);
      if (error) return { entries: [], error: error.message };
      const page = (data ?? []) as unknown as PaidRow[];
      paid.push(...page);
      if (page.length < PAGE) break;
    }
  }

  // Contractor settlements are excluded: this set is keyed by (cycle, EMAIL) and is
  // used to decide whether a HELD week has been paid off. Settling someone's invoice
  // would otherwise erase their genuinely-owed held week from the arrears ledger —
  // the same defect as the dispatch queue's paidEmails filter.
  const paidSet = new Set(
    paid
      .filter((p) => (p.payee_type ?? "employee") === "employee")
      .map((p) => `${p.cycle_source_file ?? ""}|${p.recipient_email.trim().toLowerCase()}`),
  );

  const byEmail = new Map<string, ArrearsEntry>();
  for (const r of held ?? []) {
    const row = r as {
      cycle_source_file: string;
      recipient_email: string;
      recipient_name: string | null;
      amount_php: number | null;
      amount_usd: number | null;
      locked_at: string | null;
      sent_at: string | null;
      last_error: string | null;
    };
    const email = row.recipient_email.trim().toLowerCase();
    if (paidSet.has(`${row.cycle_source_file}|${email}`)) continue; // already settled
    let entry = byEmail.get(email);
    if (!entry) {
      entry = { email, name: row.recipient_name ?? null, totalPhp: 0, totalUsd: 0, cycles: [] };
      byEmail.set(email, entry);
    }
    if (!entry.name && row.recipient_name) entry.name = row.recipient_name;
    entry.totalPhp += Number(row.amount_php ?? 0);
    entry.totalUsd += Number(row.amount_usd ?? 0);
    entry.cycles.push({
      sourceFile: row.cycle_source_file,
      amountPhp: row.amount_php,
      amountUsd: row.amount_usd,
      lockedAt: row.locked_at,
      paystubSentAt: row.sent_at,
      lastError: row.last_error,
    });
  }

  const entries = Array.from(byEmail.values()).map((e) => ({
    ...e,
    totalPhp: Math.round(e.totalPhp * 100) / 100,
    totalUsd: Math.round(e.totalUsd * 100) / 100,
    // Most recent held cycle first.
    cycles: e.cycles.sort((a, b) => (b.lockedAt ?? "").localeCompare(a.lockedAt ?? "")),
  }));

  return { entries, error: null };
}

/** Stamp a successful paystub send. */
export async function markPaystubSent(params: {
  sourceFile: string;
  recipientEmail: string;
  sentBy: string | null;
  sendCount: number;
}): Promise<void> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return;
  await supabase
    .from("paystub_dispatch_queue")
    .update({
      sent_at: new Date().toISOString(),
      sent_by: params.sentBy,
      send_count: params.sendCount,
      last_error: null,
    })
    .eq("cycle_source_file", params.sourceFile)
    .eq("recipient_email", norm(params.recipientEmail));
}

/** Record a failed paystub send so the Excluded/Done UI can surface it. */
export async function markPaystubSendError(params: {
  sourceFile: string;
  recipientEmail: string;
  error: string;
}): Promise<void> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return;
  await supabase
    .from("paystub_dispatch_queue")
    .update({ last_error: params.error.slice(0, 500) })
    .eq("cycle_source_file", params.sourceFile)
    .eq("recipient_email", norm(params.recipientEmail));
}
