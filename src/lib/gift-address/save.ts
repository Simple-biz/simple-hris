import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { escapeLikePattern } from '@/lib/db/like-escape';
import { normEmail } from '@/lib/email/norm-email';

/**
 * The guard between a verified session and the submissions table.
 *
 * `employee_gift_shipping_details` is `UNIQUE (personal_email, milestone_index)`
 * — it keys on PERSONAL email, while this flow authenticates a WORK email. On
 * the live roster personal email is **not injective**: two active pairs share
 * one address (`corpuzmachacon@gmail.com` = johnc@/russell@, and
 * `yong092734@gmail.com`), and **7 active people have none at all**.
 *
 * Writing regardless would let one colleague's verified session overwrite the
 * other's delivery address under that shared key — the gift goes to the wrong
 * house and nothing in the app would show why. So the write is REFUSED for those
 * people and the page tells them to contact HR.
 *
 * Refusing ~11 people out of 1,300 is the correct trade against silently
 * redirecting a parcel. The real fix is for the submissions table to key on work
 * email like the receipts ledger does; that is a migration, and it is recorded
 * as open in docs/features/gift-address-external-link.md.
 */

export type SubmissionKeyVerdict =
  | { ok: true; personalEmail: string }
  | { ok: false; reason: 'missing' | 'shared' };

/**
 * Decide whether this person's personal email is a safe submission key.
 *
 * Fails CLOSED: a database error reports `shared`, because "we could not check
 * whether this key collides" must not resolve to "go ahead and write".
 */
export async function checkSubmissionKey(
  personalEmail: string | null,
): Promise<SubmissionKeyVerdict> {
  const key = normEmail(personalEmail ?? '');
  if (!key) return { ok: false, reason: 'missing' };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, reason: 'shared' };

  const { count, error } = await supabase
    .from('active_employees')
    .select('"Work Email"', { count: 'exact', head: true })
    .ilike('"Personal Email"', escapeLikePattern(key));

  if (error || count == null) return { ok: false, reason: 'shared' };
  if (count > 1) return { ok: false, reason: 'shared' };
  return { ok: true, personalEmail: key };
}
