import 'server-only';

/**
 * Cycle close-out — persistence. See `cycle-closeout.ts` for what a close-out
 * IS and why it is not a published pay-cycle report.
 *
 * ONE `app_settings` row per cycle, `dispatch.cycle_closeout.<source_file>`,
 * written with a plain INSERT so two clerks racing (or a double-click) cannot
 * overwrite an existing declaration — the first close stands, the second is
 * told `already`.
 *
 * Reopening (added 2026-08-14) does not contradict that: `reopenCycle` MOVES the
 * filed record to `dispatch.cycle_reopened.<file>.<iso>` before freeing the live
 * key, so a declaration is never destroyed — it stops being the current one.
 * A re-close then writes a fresh record by plain INSERT, exactly as the first
 * one did. Only `payroll_manager`/`admin` may do it (`CYCLE_REOPEN_ROLES`).
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import {
  buildCycleCloseoutRecord,
  cycleCloseoutKey,
  cycleReopenedKey,
  parseCycleCloseout,
  CYCLE_CLOSEOUT_PREFIX,
  type CycleCloseoutRecord,
  type CycleCloseoutRecordsOutstanding,
} from './cycle-closeout';
import { cycleCompleteNotifiedKey, cycleReportSentKey } from './cycle-complete-trigger';

/** A close-out without its unpaid rows — what the Reports list needs to badge a
 *  card without dragging every payee across the wire. */
export type CycleCloseoutSummary = Omit<CycleCloseoutRecord, 'unpaid'> & {
  unpaid: Omit<CycleCloseoutRecord['unpaid'], 'payees'>;
};

export function toCycleCloseoutSummary(rec: CycleCloseoutRecord): CycleCloseoutSummary {
  const { payees: _payees, ...unpaidRest } = rec.unpaid;
  return { ...rec, unpaid: unpaidRest };
}

export async function getCycleCloseout(sourceFile: string): Promise<{
  closeout: CycleCloseoutRecord | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { closeout: null, error: 'Supabase client unavailable' };

  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', cycleCloseoutKey(sourceFile))
    .limit(1);
  if (error) return { closeout: null, error: error.message };

  const raw = (data ?? [])[0] as { value?: string | null } | undefined;
  if (!raw || typeof raw.value !== 'string') return { closeout: null, error: null };
  return { closeout: parseCycleCloseout(raw.value), error: null };
}

/**
 * Every close-out, newest first. Paged: the prefix scan grows one row per week
 * forever, and an un-ranged select is capped at 1,000 rows with no error.
 */
export async function listCycleCloseouts(): Promise<{
  closeouts: CycleCloseoutSummary[];
  /** Keys whose stored JSON could not be parsed — surfaced, not hidden. */
  unreadable: string[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { closeouts: [], unreadable: [], error: 'Supabase client unavailable' };

  const { rows, error } = await selectAllPaged<{ key: string; value: string | null }>(
    (from, to) =>
      supabase
        .from('app_settings')
        .select('key, value')
        .like('key', `${CYCLE_CLOSEOUT_PREFIX}%`)
        .order('key', { ascending: true })
        .range(from, to),
  );
  if (error) return { closeouts: [], unreadable: [], error };

  const closeouts: CycleCloseoutSummary[] = [];
  const unreadable: string[] = [];
  for (const row of rows) {
    const parsed = typeof row.value === 'string' ? parseCycleCloseout(row.value) : null;
    if (!parsed) {
      unreadable.push(row.key);
      continue;
    }
    closeouts.push(toCycleCloseoutSummary(parsed));
  }
  closeouts.sort((a, b) => b.closed_at.localeCompare(a.closed_at));
  return { closeouts, unreadable, error: null };
}

/**
 * Count what `disbursement_records` still shows owed for the cycle — the same
 * table the publish gate's condition 1 reads. This is a CROSS-CHECK only: it
 * includes people Payment Dispatch holds in Excluded, so it is normally larger
 * than the reported payable-unpaid count and must never be shown as the
 * headline. Returns null (recorded as null, never as zero) when the read fails.
 */
async function loadRecordsOutstanding(
  sourceFile: string,
): Promise<CycleCloseoutRecordsOutstanding | null> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;

  const { rows, error } = await selectAllPaged<{ status: string | null }>((from, to) =>
    supabase
      .from('disbursement_records')
      .select('status')
      .eq('source_file', sourceFile)
      .order('recipient_email', { ascending: true })
      .range(from, to),
  );
  if (error) return null;

  let notPaid = 0;
  let threshold = 0;
  let problem = 0;
  let neverDispatched = 0;
  for (const r of rows) {
    switch (r.status) {
      case 'not_paid':
        notPaid += 1;
        break;
      case 'threshold':
        threshold += 1;
        break;
      case 'problem':
        problem += 1;
        break;
      case 'pending':
        neverDispatched += 1;
        break;
      default:
        break;
    }
  }
  return {
    notPaid,
    threshold,
    problem,
    neverDispatched,
    total: notPaid + threshold + problem + neverDispatched,
  };
}

export async function closeCycle(input: {
  sourceFile: string;
  cycleId: string | null;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  closedBy: string;
  closedByEmail: string;
  reportedUnpaid: unknown;
}): Promise<{
  closeout: CycleCloseoutRecord | null;
  already: boolean;
  error: string | null;
}> {
  const fail = (error: string) => ({ closeout: null, already: false, error });

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail('Supabase client unavailable');

  // EVERY dispatch row for the cycle, not just the paid ones: the
  // superseded-marker rule inside tallyPaidDispatches needs the markers to match
  // against. Paged — a single cycle has passed 1,000 rows.
  const [dispatchRes, recordsOutstanding] = await Promise.all([
    selectAllPaged<PaymentDispatchRow>((from, to) =>
      supabase
        .from('payment_dispatches')
        .select('*')
        .eq('cycle_source_file', input.sourceFile)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    ),
    loadRecordsOutstanding(input.sourceFile),
  ]);
  if (dispatchRes.error) return fail(dispatchRes.error);

  const record = buildCycleCloseoutRecord({
    sourceFile: input.sourceFile,
    cycleId: input.cycleId,
    label: input.label,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    closedBy: input.closedBy,
    closedByEmail: input.closedByEmail,
    closedAt: new Date().toISOString(),
    dispatches: dispatchRes.rows,
    reportedUnpaid: input.reportedUnpaid,
    recordsOutstanding,
  });

  const { error: insertErr } = await supabase.from('app_settings').insert({
    key: cycleCloseoutKey(input.sourceFile),
    value: JSON.stringify(record),
    updated_at: record.closed_at,
  });
  if (insertErr) {
    if (insertErr.code === '23505') {
      // Someone already closed this week. Hand back what stands — the caller
      // reports it as "already closed", never as a fresh close.
      const { closeout, error: readErr } = await getCycleCloseout(input.sourceFile);
      return { closeout, already: true, error: readErr };
    }
    return fail(insertErr.message);
  }

  return { closeout: record, already: false, error: null };
}

/**
 * Reopen a closed week: unseat its close-out so the cycle can be worked and
 * closed again.
 *
 * Three writes, in an order chosen so no failure can lose a declaration:
 *
 *   1. **Burn the celebration claim.** INSERT `dispatch.cycle_complete_notified.
 *      <file>` if absent, marked `suppressed_by: 'reopen'`. Both celebration
 *      triggers (the 100% strip effect and the close path) check that exact key
 *      and go silent on `23505`, so this is the whole of "the automation must
 *      never fire again" — no new gate, nothing a future caller can forget.
 *      Consequence, accepted (Kane, 2026-08-14): a week whose email never
 *      actually delivered — the claim is released on delivery failure — will not
 *      get one after a reopen either.
 *   2. **Archive the record VERBATIM** under `dispatch.cycle_reopened.<file>.
 *      <iso>`. The stored string is copied byte-for-byte rather than
 *      re-serialized from a parsed object, so a record written by a future
 *      version cannot silently lose fields on the way to the archive, and any
 *      existing reader can still `parseCycleCloseout` it. Who reopened it lives
 *      in the audit log (`payment_cycle.reopened`), the same way
 *      `delete-authorization.md` keeps deleted rows traceable.
 *   3. **Delete the live key**, which is what actually reopens the week.
 *
 * A failure at 2 aborts before 3, so the week stays closed and the only casualty
 * is a burned celebration. A failure at 3 leaves the archive row orphaned and the
 * week still closed — reported as an error, never as a successful reopen.
 *
 * `notFound` is distinct from an error: the key genuinely does not exist, so the
 * week was already open and nothing was touched.
 */
export async function reopenCycle(input: {
  sourceFile: string;
  reopenedByEmail: string;
}): Promise<{
  reopened: boolean;
  notFound: boolean;
  /** The record as it stood, for the audit trail. `null` when the stored JSON
   *  was unreadable — the raw value is still archived either way. */
  prior: CycleCloseoutRecord | null;
  archiveKey: string | null;
  error: string | null;
}> {
  const miss = (error: string | null, notFound = false) => ({
    reopened: false,
    notFound,
    prior: null,
    archiveKey: null,
    error,
  });

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return miss('Supabase client unavailable');

  const liveKey = cycleCloseoutKey(input.sourceFile);

  // Read the RAW stored value: `getCycleCloseout` cannot tell "no such week"
  // apart from "stored JSON is junk", and those must not share an outcome — one
  // is a no-op, the other still needs archiving before the delete.
  const { data, error: readErr } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', liveKey)
    .limit(1);
  if (readErr) return miss(readErr.message);
  const row = (data ?? [])[0] as { value?: string | null } | undefined;
  if (!row) return miss(null, true);
  const rawValue = typeof row.value === 'string' ? row.value : '';
  const prior = rawValue ? parseCycleCloseout(rawValue) : null;

  const reopenedAt = new Date().toISOString();

  // 1 — burn the celebration claim. A 23505 means it was already claimed (the
  // email either went out or is already suppressed), which is the desired end
  // state either way, so it is NOT an error.
  const { error: burnErr } = await supabase.from('app_settings').insert({
    key: cycleCompleteNotifiedKey(input.sourceFile),
    value: JSON.stringify({
      at: reopenedAt,
      by: input.reopenedByEmail || '—',
      suppressed_by: 'reopen',
      notified: 0,
    }),
    updated_at: reopenedAt,
  });
  if (burnErr && burnErr.code !== '23505') {
    // Could not guarantee silence → do not reopen. Reopening anyway risks the
    // celebration firing on the re-close, which is the one thing Kane ruled out.
    return miss(`Could not suppress the celebration: ${burnErr.message}`);
  }

  // 1b — free the REPORTS claim (2026-09-04). The close-out files ride the
  // celebration email; with the celebration burned, the re-close still has to
  // mail the NEW record's files (as a plain "close-out reports" email). Deleting
  // a row that does not exist is a no-op, so a week that never mailed reports is
  // unaffected. A failure here aborts like an archive failure would: the week
  // stays closed with a burned celebration, and nothing has been lost.
  const { error: reportErr } = await supabase
    .from('app_settings')
    .delete()
    .eq('key', cycleReportSentKey(input.sourceFile));
  if (reportErr) {
    return miss(`Could not free the close-out reports claim: ${reportErr.message}`);
  }

  // 2 — archive verbatim.
  const archiveKey = cycleReopenedKey(input.sourceFile, reopenedAt);
  const { error: archiveErr } = await supabase.from('app_settings').insert({
    key: archiveKey,
    value: rawValue,
    updated_at: reopenedAt,
  });
  if (archiveErr) {
    return miss(`Could not archive the close-out record: ${archiveErr.message}`);
  }

  // 3 — free the live key. This is the reopen.
  const { error: delErr } = await supabase.from('app_settings').delete().eq('key', liveKey);
  if (delErr) {
    return {
      reopened: false,
      notFound: false,
      prior,
      archiveKey,
      error: `Close-out archived but could not be cleared: ${delErr.message}`,
    };
  }

  return { reopened: true, notFound: false, prior, archiveKey, error: null };
}
