import 'server-only';

/**
 * Cycle close-out — persistence. See `cycle-closeout.ts` for what a close-out
 * IS and why it is not a published pay-cycle report.
 *
 * ONE `app_settings` row per cycle, `dispatch.cycle_closeout.<source_file>`,
 * written with a plain INSERT so two clerks racing (or a double-click) cannot
 * overwrite an existing declaration — the first close stands, the second is
 * told `already`. Reopening a closed week is deliberately NOT offered here: the
 * record's whole value is that it says what was true when Accounting stopped.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import {
  buildCycleCloseoutRecord,
  cycleCloseoutKey,
  parseCycleCloseout,
  CYCLE_CLOSEOUT_PREFIX,
  type CycleCloseoutRecord,
  type CycleCloseoutRecordsOutstanding,
} from './cycle-closeout';

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
