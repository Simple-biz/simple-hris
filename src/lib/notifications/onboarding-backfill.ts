/**
 * Which onboarding submissions already have an `onboarding.submitted`
 * notification — asked PER SUBMISSION, never derived from one read of every
 * such row.
 *
 * `POST /api/hr/backfill-onboarding-notifications` runs on every HR
 * Notifications open. It used to build this set from a single unpaged select of
 * every `onboarding.submitted` row. PostgREST stops at 1000 rows: on 2026-10-01
 * there were 186,581, the 1000 returned covered 306 submissions, and all 7
 * pending submissions — every one already notified — looked new. Each open
 * re-sent them to all 20 HR/admin recipients, 140 rows a time (item 305).
 *
 * A failed probe fails the whole answer, and the caller inserts nothing. On a
 * write path an uncertain dedupe does not fail, it inserts duplicates.
 */
export type ProbeResult = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

export type AlreadyNotified = { ok: true; notified: Set<string> } | { ok: false; error: string };

export async function submissionsAlreadyNotified(
  submissionIds: readonly string[],
  /** Any `onboarding.submitted` row for this submission? Build it with `.limit(1)`. */
  probe: (submissionId: string) => ProbeResult,
  concurrency = 10,
): Promise<AlreadyNotified> {
  const notified = new Set<string>();
  for (let i = 0; i < submissionIds.length; i += concurrency) {
    const chunk = submissionIds.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((id) => probe(id)));
    for (let j = 0; j < chunk.length; j++) {
      const { data, error } = results[j];
      if (error) return { ok: false, error: error.message };
      if ((data ?? []).length > 0) notified.add(chunk[j]);
    }
  }
  return { ok: true, notified };
}
