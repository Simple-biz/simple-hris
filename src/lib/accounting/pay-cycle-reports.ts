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
 * Eligibility comes from listDisbursementReports(), the same source Payment
 * Dispatch → Reports reads, so the two screens agree about what a cycle is.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import {
  getDisbursementReportDetail,
  listDisbursementReports,
} from '@/lib/payroll/disbursement-reports';
import {
  buildPayCycleReportSnapshot,
  cycleCompleteness,
  isPublishableCycle,
  toPayCycleReportSummary,
  type CycleCompleteness,
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
}

/** Parse a stored value, returning null (not throwing) on anything malformed —
 *  one corrupt row must not blank the whole tab. */
function parseSnapshot(value: string): PayCycleReportSnapshot | null {
  try {
    const parsed = JSON.parse(value) as PayCycleReportSnapshot;
    if (!parsed || typeof parsed !== 'object' || !parsed.source_file) return null;
    if (!Array.isArray(parsed.payees)) parsed.payees = [];
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Every published report, newest period first. `unreadable` carries the keys
 * whose JSON would not parse so the UI can offer an Unpublish on them instead
 * of silently dropping them.
 *
 * Published cycles number in the dozens per year, so one un-paged `.like()`
 * select is correct here — but note the 1000-row ceiling is real, and this read
 * would need selectAllPaged if reports ever became per-person rows.
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
 */
export async function listCycleStatus(): Promise<{
  publishable: PublishableCycle[];
  incomplete: IncompleteCycle | null;
  publishedSources: string[];
  error: string | null;
}> {
  const [{ reports, error }, { published, error: pubErr }] = await Promise.all([
    listDisbursementReports(),
    listPayCycleReports(),
  ]);
  if (error) return { publishable: [], incomplete: null, publishedSources: [], error };
  if (pubErr) return { publishable: [], incomplete: null, publishedSources: [], error: pubErr };

  const publishedSources = published.map((p) => p.source_file);
  const alreadyPublished = new Set(publishedSources);

  const publishable: PublishableCycle[] = [];
  let incomplete: IncompleteCycle | null = null;

  // `reports` arrives newest period first, so the first incomplete cycle we
  // meet is the newest one.
  for (const r of reports) {
    if (!r.sourceFile || isUrgentSourceFile(r.sourceFile)) continue;
    const c = cycleCompleteness(r.totals);
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
        };
      }
      continue;
    }
    if (alreadyPublished.has(r.sourceFile)) continue;
    publishable.push({
      sourceFile: r.sourceFile,
      cycleId: r.cycleId,
      label: r.reportName,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      // Pre-publish estimate straight off the report totals. The authoritative
      // count is recomputed from the dispatch rows at publish time.
      payeeCount: r.totals.paidCount,
      paidUSD: r.totals.paidUSD,
      paidPHP: r.totals.paidPHP,
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

  const { reports, error: listErr } = await listDisbursementReports();
  if (listErr) return fail(listErr);
  const summary = reports.find((r) => r.sourceFile === input.sourceFile);
  if (!summary) return fail('Cycle not found');

  if (!isPublishableCycle(summary)) {
    return {
      report: null,
      already: false,
      notComplete: cycleCompleteness(summary.totals),
      error: null,
    };
  }

  const { report: detail, error: detailErr } = await getDisbursementReportDetail(summary.cycleId);
  if (detailErr || !detail) return fail(detailErr ?? 'Could not load cycle detail');

  const snapshot = buildPayCycleReportSnapshot({
    summary,
    dispatches: detail.dispatches,
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

export async function unpublishPayCycleReport(
  sourceFile: string,
): Promise<{ deleted: boolean; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { deleted: false, error: 'Supabase client unavailable' };
  const { error } = await supabase
    .from('app_settings')
    .delete()
    .eq('key', payCycleReportKey(sourceFile));
  return { deleted: !error, error: error ? error.message : null };
}
