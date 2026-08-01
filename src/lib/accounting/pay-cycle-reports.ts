import 'server-only';

/**
 * Pay Cycle Reports — persistence.
 *
 * A published report is ONE `app_settings` row per cycle, keyed
 * `documents.pay_cycle_report.<source_file>`, whose value is the frozen
 * PayCycleReportSnapshot JSON. No dedicated table, and therefore no migration:
 * the report's *content* is derivable from disbursement_records /
 * payment_dispatches at any time — the only new fact is the publication itself,
 * plus the frozen numbers that must survive a later undo.
 *
 * Eligibility comes from listDisbursementReports() (which cycles exist, and
 * whether anything is still owed) AND from payment_dispatches (whether there are
 * per-payee payment rows to freeze at all). Both halves are needed: the frozen
 * payload is built from payment_dispatches, so a gate that consulted only
 * disbursement_records could green-light a cycle with nothing in it — see
 * cycleCompleteness in pay-cycle-report-snapshot.ts for the three conditions.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { listDisbursementReports } from '@/lib/payroll/disbursement-reports';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import {
  buildPayCycleReportSnapshot,
  cycleCompleteness,
  isPublishableCycle,
  tallyPaidDispatches,
  toPayCycleReportSummary,
  type CycleCompleteness,
  type PayCycleDispatchLike,
  type PayCycleReportSnapshot,
  type PayCycleReportSummary,
} from './pay-cycle-report-snapshot';
import { isUrgentSourceFile } from '@/lib/payroll/urgent-cycle';

export const PAY_CYCLE_REPORT_PREFIX = 'documents.pay_cycle_report.';

export function payCycleReportKey(sourceFile: string): string {
  return `${PAY_CYCLE_REPORT_PREFIX}${sourceFile}`;
}

export interface PublishableCycle {
  sourceFile: string;
  cycleId: string;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  payeeCount: number;
  paidUSD: number;
  paidPHP: number;
}

export interface IncompleteCycle {
  sourceFile: string;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidCount: number;
  pendingCount: number;
  blockedCount: number;
  totalCount: number;
  paidPct: number;
  /** Dispatch rows left not_paid / threshold / problem and NOT superseded by a
   *  later payment to the same payee — the bucket a logged-but-unpaid contractor
   *  invoice lands in, which disbursement_records cannot see. */
  unsettledDispatchCount: number;
  /** True when the cycle's records all read paid but Payment Dispatch holds NO
   *  paid row for it (typically a "Mark all paid" bulk UPDATE). There is
   *  nothing per-payee to freeze, so the muted card must say that rather than
   *  claiming people are still pending. */
  noDispatchData: boolean;
}

/**
 * Parse a stored value, returning null (not throwing) on anything malformed —
 * one corrupt row must not blank the whole tab.
 *
 * Anything the list view dereferences UNCONDITIONALLY has to be checked here,
 * not just `payees`: `published_at.localeCompare` in the sort below and
 * `totals.payeeCount.toLocaleString()` in ReportCard would each throw on a
 * tampered row and take the whole tab down — exactly what this guard exists to
 * prevent. A row that fails lands in `unreadable` instead, where the UI offers
 * an Unpublish. Softer fields are repaired rather than rejected.
 */
const REQUIRED_TOTALS = [
  'payeeCount',
  'employeeCount',
  'contractorCount',
  'dispatchCount',
  'paidUSD',
  'paidPHP',
] as const;

function parseSnapshot(value: string): PayCycleReportSnapshot | null {
  try {
    const parsed = JSON.parse(value) as PayCycleReportSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.source_file !== 'string' || !parsed.source_file) return null;
    if (typeof parsed.published_at !== 'string' || !parsed.published_at) return null;
    if (!parsed.totals || typeof parsed.totals !== 'object') return null;
    for (const k of REQUIRED_TOTALS) {
      if (typeof parsed.totals[k] !== 'number' || !Number.isFinite(parsed.totals[k])) return null;
    }
    if (!parsed.byProcessor || typeof parsed.byProcessor !== 'object') parsed.byProcessor = {};
    if (!Array.isArray(parsed.payees)) parsed.payees = [];
    if (typeof parsed.label !== 'string') parsed.label = parsed.source_file;
    if (typeof parsed.published_by !== 'string' || !parsed.published_by) {
      parsed.published_by = typeof parsed.published_by_email === 'string'
        ? parsed.published_by_email
        : '—';
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Every dispatch row that matters to the gate, bucketed by cycle — five/six
 * columns, SCOPED to the cycles we are actually going to evaluate, instead of a
 * per-cycle round trip at one extreme or the whole table at the other. Task 7
 * mounts this tab eagerly, so this runs on every visit to Accounting →
 * Documents, including visits that only touch the signing queue: an unscoped
 * read grew by ~1,000 rows every pay week for nothing.
 *
 * MUST still be paged: PostgREST silently caps un-ranged selects at 1,000 rows,
 * and a truncated read here would hand the gate a cycle with "no dispatches" and
 * suppress a publishable week (or, worse, hide an unpaid row and let a
 * half-finished cycle through).
 *
 * `sourceFiles` is chunked because supabase-js puts `.in()` in the request URL
 * and these are ~55-character filenames — the same URL-length ceiling
 * deletePaymentDispatches chunks for. Each chunk is drained independently.
 *
 * `payee_type` postdates the table's DDL, so a missing-column error re-queries
 * without it — correct in that case, since no contractor dispatch row can exist
 * yet either. Same probe pattern as payout-extras.ts / paystub-dispatch-queue.ts;
 * ONLY a missing column may fall back, never a transient error.
 */
type CycleDispatchRow = PayCycleDispatchLike & { cycle_source_file?: string | null };

const DISPATCH_SOURCE_FILE_CHUNK = 50;

async function loadDispatchRowsByCycle(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  sourceFiles: string[],
): Promise<{ byCycle: Map<string, CycleDispatchRow[]>; error: string | null }> {
  const byCycle = new Map<string, CycleDispatchRow[]>();
  if (sourceFiles.length === 0) return { byCycle, error: null };

  const COLS = 'cycle_source_file, status, recipient_email, amount_usd, amount_php';
  const read = (batch: string[], withPayeeType: boolean) =>
    selectAllPaged<CycleDispatchRow>((from, to) =>
      supabase
        .from('payment_dispatches')
        .select(withPayeeType ? `${COLS}, payee_type` : COLS)
        .in('cycle_source_file', batch)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: CycleDispatchRow[] | null;
        error: { message: string } | null;
      }>,
    );

  for (let i = 0; i < sourceFiles.length; i += DISPATCH_SOURCE_FILE_CHUNK) {
    const batch = sourceFiles.slice(i, i + DISPATCH_SOURCE_FILE_CHUNK);
    let res = await read(batch, true);
    if (res.error && /payee_type/i.test(res.error)) res = await read(batch, false);
    if (res.error) return { byCycle: new Map(), error: res.error };

    for (const row of res.rows) {
      const key = row.cycle_source_file;
      if (!key) continue;
      const bucket = byCycle.get(key);
      if (bucket) bucket.push(row);
      else byCycle.set(key, [row]);
    }
  }
  return { byCycle, error: null };
}

/**
 * Every published report, newest period first. `unreadable` carries the keys
 * whose JSON would not parse so the UI can offer an Unpublish on them instead
 * of silently dropping them.
 *
 * Published cycles number in the dozens per year, so one un-paged `.like()`
 * select is correct here — but note the 1000-row ceiling is real, and this read
 * would need selectAllPaged if reports ever became per-person rows.
 *
 * It is not cheap despite the low row count: `value` is the WHOLE snapshot,
 * payees included (~300 KB for a 1,300-payee cycle). Call it ONCE per request and
 * hand the result to `listCycleStatus(published)` rather than letting both run it.
 */
export async function listPayCycleReports(): Promise<{
  published: PayCycleReportSummary[];
  unreadable: string[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { published: [], unreadable: [], error: 'Supabase client unavailable' };

  const { data, error } = await supabase
    .from('app_settings')
    .select('key, value')
    .like('key', `${PAY_CYCLE_REPORT_PREFIX}%`);
  if (error) return { published: [], unreadable: [], error: error.message };

  const published: PayCycleReportSummary[] = [];
  const unreadable: string[] = [];
  for (const row of (data ?? []) as { key: string; value: string }[]) {
    const snap = parseSnapshot(row.value);
    if (!snap) {
      unreadable.push(row.key);
      continue;
    }
    published.push(toPayCycleReportSummary(snap));
  }
  published.sort((a, b) => {
    const byPeriod = (b.period_start ?? '').localeCompare(a.period_start ?? '');
    return byPeriod !== 0 ? byPeriod : b.published_at.localeCompare(a.published_at);
  });
  return { published, unreadable, error: null };
}

export async function getPayCycleReport(
  sourceFile: string,
): Promise<{ report: PayCycleReportSnapshot | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { report: null, error: 'Supabase client unavailable' };

  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', payCycleReportKey(sourceFile))
    .maybeSingle();
  if (error) return { report: null, error: error.message };
  if (!data) return { report: null, error: null };

  const snap = parseSnapshot((data as { value: string }).value);
  return snap
    ? { report: snap, error: null }
    : { report: null, error: 'Stored report could not be read' };
}

/**
 * What the Reports tab needs to render its publish card:
 *   • publishable — complete, unpublished, non-urgent cycles (newest first).
 *   • incomplete  — the newest cycle that is NOT complete, so a tab with
 *                   nothing publishable can still explain what is outstanding
 *                   instead of showing an empty card.
 *
 * `published` may be passed in by a caller that has ALREADY loaded it (the GET
 * route does): that read pulls every snapshot's full payee JSON, so running it
 * twice per request costs hundreds of KB for nothing.
 *
 * The card figures (payeeCount / paidUSD / paidPHP) come from the cycle's PAID
 * DISPATCH ROWS through the shared `tallyPaidDispatches`, not from
 * disbursement_records totals — they are what publishing will actually freeze,
 * so the clerk approves the numbers that get stored. Records totals would
 * understate by every contractor invoice (no records row exists for one) and
 * lose the second of two payments to the same person (the sync trigger's
 * last-write-wins on paid_amount_usd).
 */
export async function listCycleStatus(published?: PayCycleReportSummary[]): Promise<{
  publishable: PublishableCycle[];
  incomplete: IncompleteCycle | null;
  publishedSources: string[];
  error: string | null;
}> {
  const empty = (error: string | null) => ({
    publishable: [] as PublishableCycle[],
    incomplete: null,
    publishedSources: [] as string[],
    error,
  });

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return empty('Supabase client unavailable');

  const [{ reports, error }, publishedRes] = await Promise.all([
    listDisbursementReports(),
    published
      ? Promise.resolve({ published, error: null as string | null })
      : listPayCycleReports(),
  ]);
  if (error) return empty(error);
  if (publishedRes.error) return empty(publishedRes.error);

  // Scoped to exactly the cycles the loop below evaluates. NOT further narrowed
  // to unpublished ones: the loop tests completeness BEFORE `alreadyPublished`,
  // so starving a published cycle of its rows would make it fail the gate and
  // hijack the muted "not ready" card.
  const gatedSourceFiles = reports
    .map((r) => r.sourceFile)
    .filter((f): f is string => !!f && !isUrgentSourceFile(f));
  const dispatchRes = await loadDispatchRowsByCycle(supabase, gatedSourceFiles);
  if (dispatchRes.error) return empty(dispatchRes.error);

  const publishedSources = publishedRes.published.map((p) => p.source_file);
  const alreadyPublished = new Set(publishedSources);

  const publishable: PublishableCycle[] = [];
  let incomplete: IncompleteCycle | null = null;

  // `reports` arrives newest period first, so the first incomplete cycle we
  // meet is the newest one.
  for (const r of reports) {
    if (!r.sourceFile || isUrgentSourceFile(r.sourceFile)) continue;
    const dispatches = dispatchRes.byCycle.get(r.sourceFile) ?? [];
    const c = cycleCompleteness(r.totals, dispatches);
    if (!c.complete) {
      if (!incomplete) {
        const totalCount = c.paidCount + c.pendingCount + c.blockedCount;
        incomplete = {
          sourceFile: r.sourceFile,
          label: r.reportName,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          paidCount: c.paidCount,
          pendingCount: c.pendingCount,
          blockedCount: c.blockedCount,
          totalCount,
          paidPct: totalCount > 0 ? Math.round((c.paidCount / totalCount) * 100) : 0,
          unsettledDispatchCount: c.unsettledDispatchCount,
          // Records say done, Payment Dispatch has nothing paid to show for it.
          noDispatchData: c.recordsComplete && c.dispatchesComplete && !c.hasPaidDispatches,
        };
      }
      continue;
    }
    if (alreadyPublished.has(r.sourceFile)) continue;
    const tally = tallyPaidDispatches(dispatches);
    publishable.push({
      sourceFile: r.sourceFile,
      cycleId: r.cycleId,
      label: r.reportName,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      payeeCount: tally.payeeCount,
      paidUSD: tally.paidUSD,
      paidPHP: tally.paidPHP,
    });
  }

  return { publishable, incomplete, publishedSources, error: null };
}

/**
 * Freeze and store a cycle.
 *
 * Completeness is RE-CHECKED here against fresh totals: this is what stops a
 * stale browser tab from publishing a cycle that has since had a payment undone.
 *
 * The write is a plain INSERT, never an upsert — `app_settings.key` is unique,
 * so a double-click or two clerks racing produce one row and a 23505 for the
 * loser, reported as `already: true`.
 */
export async function publishPayCycleReport(input: {
  sourceFile: string;
  publishedBy: string;
  publishedByEmail: string;
}): Promise<{
  report: PayCycleReportSnapshot | null;
  already: boolean;
  notComplete: CycleCompleteness | null;
  error: string | null;
}> {
  const fail = (error: string) => ({ report: null, already: false, notComplete: null, error });

  if (isUrgentSourceFile(input.sourceFile)) {
    return fail('Urgent payouts are not pay cycles and cannot be published');
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail('Supabase client unavailable');

  // Fresh totals AND fresh dispatch rows, read in parallel. The dispatch read is
  // scoped straight to this cycle rather than going through
  // getDisbursementReportDetail(cycleId): that helper re-runs
  // listDisbursementReports() (every disbursement_record, ~14 paged round-trips)
  // just to re-find the summary we already hold, and matching by `cycleId`
  // against a second freshly-loaded list is a needless re-lookup.
  const [{ reports, error: listErr }, dispatchRes] = await Promise.all([
    listDisbursementReports(),
    selectAllPaged<PaymentDispatchRow>((from, to) =>
      supabase
        .from('payment_dispatches')
        .select('*')
        .eq('cycle_source_file', input.sourceFile)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    ),
  ]);
  if (listErr) return fail(listErr);
  if (dispatchRes.error) return fail(dispatchRes.error);
  const summary = reports.find((r) => r.sourceFile === input.sourceFile);
  if (!summary) return fail('Cycle not found');

  // Re-checked against fresh data — all three conditions, not just the records
  // one. This is what stops a stale browser tab publishing a cycle that has
  // since had a payment undone, an invoice go unpaid, or (the empty-snapshot
  // case) never had per-payee dispatch rows at all.
  if (!isPublishableCycle(summary, dispatchRes.rows)) {
    return {
      report: null,
      already: false,
      notComplete: cycleCompleteness(summary.totals, dispatchRes.rows),
      error: null,
    };
  }

  const snapshot = buildPayCycleReportSnapshot({
    summary,
    dispatches: dispatchRes.rows,
    publishedBy: input.publishedBy,
    publishedByEmail: input.publishedByEmail,
    publishedAt: new Date().toISOString(),
  });

  const { error: insertErr } = await supabase.from('app_settings').insert({
    key: payCycleReportKey(input.sourceFile),
    value: JSON.stringify(snapshot),
    updated_at: snapshot.published_at,
  });
  if (insertErr) {
    if (insertErr.code === '23505') {
      // Someone else won the race — the report exists, which is the outcome
      // the clerk wanted, so `already: true` stands regardless of what happens
      // next. But the read-back can still fail (transient blip, or the winning
      // row itself is unreadable — the exact case listPayCycleReports's
      // `unreadable` bucket exists for), so its `error` must be propagated, not
      // swallowed — that's the only way a caller can tell "already published,
      // here it is" apart from "already published, but I couldn't read it back".
      const { report, error: readErr } = await getPayCycleReport(input.sourceFile);
      return { report, already: true, notComplete: null, error: readErr };
    }
    return fail(insertErr.message);
  }

  return { report: snapshot, already: false, notComplete: null, error: null };
}

/**
 * Delete a published report — and RETURN what was deleted.
 *
 * That app_settings row is the sole copy of the frozen snapshot; the whole point
 * of the feature is that those numbers survive a later undo in Payment Dispatch.
 * A blind `.delete()` would destroy 800+ payee rows, transaction IDs and totals
 * with no recovery path and nothing for the audit trail to record, so the delete
 * RETURNs its row (`.select('value')`) and the caller writes it into the audit
 * event — same reasoning as payment-dispatches/undo's `payment.undone` events.
 *
 * `deleted` is now honest: false means the key matched nothing, so the caller can
 * skip claiming a deletion that never happened.
 */
export async function unpublishPayCycleReport(sourceFile: string): Promise<{
  deleted: boolean;
  /** The parsed snapshot that was deleted, when it could still be read. */
  snapshot: PayCycleReportSnapshot | null;
  /** The raw stored JSON — kept even when unparseable, so an unreadable row is
   *  still recoverable from the audit trail. */
  rawValue: string | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return { deleted: false, snapshot: null, rawValue: null, error: 'Supabase client unavailable' };
  }
  const { data, error } = await supabase
    .from('app_settings')
    .delete()
    .eq('key', payCycleReportKey(sourceFile))
    .select('value');
  if (error) return { deleted: false, snapshot: null, rawValue: null, error: error.message };

  const rows = (data ?? []) as { value: string | null }[];
  const rawValue = typeof rows[0]?.value === 'string' ? rows[0].value : null;
  return {
    deleted: rows.length > 0,
    snapshot: rawValue ? parseSnapshot(rawValue) : null,
    rawValue,
    error: null,
  };
}
