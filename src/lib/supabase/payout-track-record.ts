import 'server-only';

import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';
import { normEmail } from '@/lib/email/norm-email';
import type { ProcessorId } from '@/lib/employee-payment-processors';
import {
  foldPayoutTrackRecord,
  payoutDestinationKey,
  type PayoutTrackRecord,
  type TrackDispatchRow,
} from '@/lib/banking/payout-change-safety';

/**
 * How many times the account on file has been paid, read from
 * `payment_dispatches` (Mark Paid's snapshot of where each payment went).
 *
 * Every address the person is known by is read, because a dispatch row is keyed on
 * whichever address the queue carried. `recipient_email` is stored trimmed and
 * lowercased (0 of 13,970 rows otherwise, measured 2026-10-07), so `.in` on
 * normalised addresses is exact. PAGED: a long-tenured payee passes 50 rows and the
 * table passed 13,970, so an un-paged read is the 1000-row trap waiting.
 *
 * A failed read is `{ status: 'unavailable' }`, never a zero count: "we could not
 * read the payment log" and "this account was never paid" must not look alike.
 * Returns no account value, only counts and dates.
 */
export async function readPayoutTrackRecord(opts: {
  emails: ReadonlyArray<string | null | undefined>;
  row: Record<string, unknown> | null;
  rail: ProcessorId | null;
}): Promise<PayoutTrackRecord> {
  const destination = payoutDestinationKey(opts.row, opts.rail);
  if (!destination) return foldPayoutTrackRecord([], null);

  const emails = [...new Set(opts.emails.map((e) => normEmail(e ?? '')).filter((e): e is string => !!e))];
  if (emails.length === 0) return { status: 'unavailable' };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { status: 'unavailable' };

  try {
    const { rows, error } = await selectAllPaged<TrackDispatchRow>((from, to) =>
      supabase
        .from('payment_dispatches')
        .select('recipient_account_number, status, sent_date, payee_type')
        .in('recipient_email', emails)
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (error) {
      console.error('[payout-track-record] payment_dispatches read failed:', error);
      return { status: 'unavailable' };
    }
    return foldPayoutTrackRecord(rows, destination);
  } catch (e) {
    console.error('[payout-track-record] payment_dispatches read threw:', e);
    return { status: 'unavailable' };
  }
}
