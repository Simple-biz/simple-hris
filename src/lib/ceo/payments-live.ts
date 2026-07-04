import 'server-only';

import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from '@/lib/supabase/server';
import { listHubstaffUploads, getCurrentHubstaffUploadId } from '@/lib/supabase/hubstaff-hours-db';
import { formatDisbursementReportName } from '@/lib/payroll/disbursement-reports';

/**
 * Live "payments to send" progress for the CURRENT pay cycle — the number that
 * counts DOWN on the CEO Overview as each employee is paid.
 *
 *   remaining = total (dispatchable this cycle) − paid (so far)
 *
 * "paid" is sourced from the ground truth the payroll clerk writes:
 * `payment_dispatches` rows (status='paid'), which the sync trigger also
 * mirrors into `disbursement_records.status`. We take the larger of the two so
 * the count is correct whether or not `disbursement_records` has been seeded
 * for this cycle yet.
 *
 * The CEO dashboard refetches this on every `payment_dispatches` Realtime
 * change, so the card ticks down the instant anyone marks someone paid (and
 * back up on Undo).
 */
/** One recently-dispatched payment, for the CEO's live "being paid now" feed. */
export interface PaidFeedEntry {
  email: string;
  name: string | null;
  amountUsd: number | null;
  amountPhp: number | null;
  amountCop: number | null;
  /** ISO timestamp the dispatch was logged (created_at). */
  paidAt: string;
}

export interface PaymentsLive {
  /** Current cycle's Hubstaff source CSV (the cycle being paid). */
  sourceFile: string | null;
  /** "April 12-18, 2026" */
  label: string;
  /** Dispatchable universe for the current cycle (the denominator). */
  total: number;
  /** Recipients already paid this cycle. */
  paid: number;
  /** total − paid, never negative — what's left to pay. */
  remaining: number;
  /** Most-recently-paid recipients this cycle (newest first) — powers the live
   *  "who's getting paid at the moment" feed in the CEO watch modal. */
  recent: PaidFeedEntry[];
  /** Diagnostics — how each number was derived. Safe to expose (rate-gated). */
  debug?: {
    uploadsCount: number;
    isCurrentFound: boolean;
    currentUploadId: string | null;
    stagedTotal: number;
    disbTotal: number;
    disbPaid: number;
    hoursCount: number;
    paidFromDispatches: number;
  };
  error: string | null;
}

/** Two ISO dates inside a Hubstaff filename → "April 12-18, 2026". */
function labelFromSourceFile(file: string | null): string {
  if (!file) return 'Current pay week';
  const m = file.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (m) return formatDisbursementReportName(m[1]!, m[2]!, file.replace(/\.csv$/i, ''));
  return file.replace(/\.csv$/i, '');
}

type Supabase = NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;

async function exactCount(
  supabase: Supabase,
  table: string,
  filters: Record<string, string | number | boolean>,
): Promise<number> {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
  const { count, error } = await q;
  if (error) return 0;
  return count ?? 0;
}

/** Add the distinct paid recipients matching one column=value into `into`
 *  (deduped — a recipient may have more than one dispatch row across retries).
 *  Called once per identifier (source file, then upload id) so a payment is
 *  counted no matter which the dispatch flow stamped on the row. */
/** Collect the most-recent paid dispatch rows for one identifier into `into`,
 *  keyed by recipient email so a person appears once (their latest dispatch).
 *  Called once per identifier (source file, then upload id) — belt-and-braces
 *  against a cycle-key mismatch, exactly like {@link collectPaidEmails}. */
async function collectRecentPaid(
  supabase: Supabase,
  column: 'cycle_source_file' | 'cycle_id',
  value: string,
  into: Map<string, PaidFeedEntry>,
): Promise<void> {
  const { data, error } = await supabase
    .from('payment_dispatches')
    .select('recipient_email, recipient_name, amount_usd, amount_php, amount_cop, created_at')
    .eq(column, value)
    .eq('status', 'paid')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return;
  const rows = (data ?? []) as {
    recipient_email: string | null;
    recipient_name: string | null;
    amount_usd: number | null;
    amount_php: number | null;
    amount_cop: number | null;
    created_at: string | null;
  }[];
  for (const r of rows) {
    const email = (r.recipient_email ?? '').trim().toLowerCase();
    if (!email) continue;
    const paidAt = r.created_at ?? '';
    const existing = into.get(email);
    // Keep the most recent dispatch event per recipient (retries insert extra rows).
    if (existing && existing.paidAt >= paidAt) continue;
    into.set(email, {
      email,
      name: r.recipient_name,
      amountUsd: r.amount_usd,
      amountPhp: r.amount_php,
      amountCop: r.amount_cop,
      paidAt,
    });
  }
}

async function collectPaidEmails(
  supabase: Supabase,
  column: 'cycle_source_file' | 'cycle_id',
  value: string,
  into: Set<string>,
): Promise<void> {
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('payment_dispatches')
      .select('recipient_email')
      .eq(column, value)
      .eq('status', 'paid')
      .range(from, from + PAGE - 1);
    if (error) break;
    const page = (data ?? []) as { recipient_email: string | null }[];
    for (const r of page) {
      const e = (r.recipient_email ?? '').trim().toLowerCase();
      if (e) into.add(e);
    }
    if (page.length < PAGE) break;
    from += PAGE;
  }
}

export async function buildPaymentsLive(): Promise<PaymentsLive> {
  const empty: PaymentsLive = {
    sourceFile: null,
    label: 'Current pay week',
    total: 0,
    paid: 0,
    remaining: 0,
    recent: [],
    error: null,
  };

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { ...empty, error: 'Supabase client unavailable' };

  // Resolve the cycle currently being paid. The AUTHORITATIVE id is whatever
  // `getCurrentHubstaffUploadId` returns — the exact same resolver that
  // /api/payroll-current-pay (which stamps the payment row's cycle_id) and the
  // dispatch queue use — so our paid-count join can't drift from the payment
  // rows. We then map it to its source_file (for the disbursement / staged /
  // hours counts), falling back to the is_current flag, then the newest upload.
  let uploads: Awaited<ReturnType<typeof listHubstaffUploads>> = [];
  try {
    uploads = await listHubstaffUploads();
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
  let authoritativeId: string | null = null;
  try {
    authoritativeId = await getCurrentHubstaffUploadId(supabase);
  } catch {
    /* fall back to is_current / newest below */
  }
  const byId = authoritativeId
    ? uploads.find((u) => u.id === authoritativeId && u.source_file) ?? null
    : null;
  const isCurrentUpload = uploads.find((u) => u.is_current && u.source_file) ?? null;
  const current = byId ?? isCurrentUpload ?? uploads.find((u) => u.source_file) ?? null;
  const sourceFile = current?.source_file ?? null;
  // The cycle id payments are matched on — authoritative resolver wins so it
  // equals payment_dispatches.cycle_id exactly.
  const currentUploadId = authoritativeId ?? current?.id ?? null;
  if (!sourceFile) {
    return {
      ...empty,
      debug: {
        uploadsCount: uploads.length,
        isCurrentFound: !!isCurrentUpload,
        currentUploadId,
        stagedTotal: 0,
        disbTotal: 0,
        disbPaid: 0,
        hoursCount: 0,
        paidFromDispatches: 0,
      },
    };
  }

  const [stagedTotal, disbTotal, disbPaid] = await Promise.all([
    // The wizard stages exactly who Lenny should pay into paystub_dispatch_queue
    // (excluded=false = the dispatchable queue). This is the truest mirror of
    // the payroll clerk's pending+paid universe.
    exactCount(supabase, 'paystub_dispatch_queue', {
      cycle_source_file: sourceFile,
      excluded: false,
    }),
    exactCount(supabase, 'disbursement_records', { source_file: sourceFile }),
    exactCount(supabase, 'disbursement_records', { source_file: sourceFile, status: 'paid' }),
  ]);

  // Distinct paid recipients this cycle — matched by BOTH the cycle's source
  // file AND its upload id, so a payment row is counted whichever the dispatch
  // flow stamped (they should agree; this is belt-and-braces against a cycle
  // key mismatch that would silently freeze the counter).
  const paidEmails = new Set<string>();
  // Same two-key union, but keeping the full row per recipient for the live feed.
  const recentMap = new Map<string, PaidFeedEntry>();
  await Promise.all([
    collectPaidEmails(supabase, 'cycle_source_file', sourceFile, paidEmails),
    collectRecentPaid(supabase, 'cycle_source_file', sourceFile, recentMap),
    ...(currentUploadId
      ? [
          collectPaidEmails(supabase, 'cycle_id', currentUploadId, paidEmails),
          collectRecentPaid(supabase, 'cycle_id', currentUploadId, recentMap),
        ]
      : []),
  ]);
  const paidFromDispatches = paidEmails.size;
  // Newest first; cap so the feed payload stays small.
  const recent = Array.from(recentMap.values())
    .sort((a, b) => (a.paidAt < b.paidAt ? 1 : a.paidAt > b.paidAt ? -1 : 0))
    .slice(0, 60);

  // "paid" is the count of ACTUAL dispatch actions in `payment_dispatches`.
  // We deliberately do NOT trust `disbursement_records.status='paid'` here: that
  // column gets BULK-set (the "mark all paid" action / cycle backfills) without
  // a per-person dispatch row, so a cycle can read 880/880 "paid" in
  // disbursement_records while only 2 people were actually dispatched. Using the
  // dispatch log makes the counter tick down per real Mark-Paid, as intended.
  // (`disbPaid` is kept only for the debug block.)
  const paid = paidFromDispatches;

  // Hubstaff row count for this cycle — always computed (cheap) so it's visible
  // in debug and serves as the final fallback denominator.
  const hoursCount = await exactCount(supabase, 'hubstaff_hours', { source_file: sourceFile });

  // Universe (the denominator), best → fallback:
  //   1. the wizard's staged dispatch queue (mirrors Lenny's pending+paid),
  //   2. the seeded disbursement_records cycle population,
  //   3. the raw Hubstaff row count for the cycle.
  // Clamped to never sit below what's already been paid.
  let total: number;
  if (stagedTotal > 0) total = Math.max(stagedTotal, paid);
  else if (disbTotal > 0) total = Math.max(disbTotal, paid);
  else total = Math.max(hoursCount, paid);

  return {
    sourceFile,
    label: labelFromSourceFile(sourceFile),
    total,
    paid,
    remaining: Math.max(0, total - paid),
    recent,
    debug: {
      uploadsCount: uploads.length,
      isCurrentFound: !!isCurrentUpload,
      currentUploadId,
      stagedTotal,
      disbTotal,
      disbPaid,
      hoursCount,
      paidFromDispatches,
    },
    error: null,
  };
}
