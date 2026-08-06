import type { PaidFeedEntry } from '@/hooks/usePaymentsLive';

/**
 * Entries in `recent` whose email isn't yet in `seen` — payments that have
 * appeared in the feed since the caller last checked. Preserves the feed's
 * own order (newest-first).
 */
export function selectNewlyPaidEntries(
  recent: PaidFeedEntry[],
  seen: ReadonlySet<string>,
): PaidFeedEntry[] {
  return recent.filter((entry) => !seen.has(entry.email));
}
