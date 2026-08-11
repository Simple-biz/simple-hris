/**
 * The No Pay Rate list's post-enrichment retry rule — pure, so the ordering bug
 * it fixes is pinned by tests instead of by a live database.
 *
 * `buildMissingRates` (payroll-readiness.ts) resolves each Hubstaff worker's
 * rate against a department read from `active_employees`. That view is
 * `global_master_list WHERE last_seen_upload_id = <current> AND off_boarded_at
 * IS NULL`, so it drops every off-boarded person the instant HR stamps them —
 * which is the very pay week that pays their final check — plus anyone lost to
 * a sheet-sync race. Those people resolve with `department = null`, and
 * `resolveDeptCatalogRate` short-circuits on a null department, so they land on
 * the No Pay Rate list even when their department carries a Payment Catalog
 * base rate. `enrichMissingRatesFromMaster` then fills the real department in —
 * but it used to run AFTER the only resolve, purely for display.
 *
 * Readiness weights a missing rate at 10/50 with a hard pin, so one false row
 * caps the whole week's score at 60. Hence: retry, then re-judge.
 *
 * Direction of safety matches the rest of readiness — a row may only LEAVE the
 * list by resolving through the real rate chain. No department, no identity, or
 * a failed read all keep the row exactly where it was, so this can remove a
 * false blocker and never hide a real one.
 *
 * Sibling of `readiness-score.ts` / `readiness-week-scope.ts`: no I/O, no
 * `server-only` import, so it unit-tests directly.
 */

/** The shape this rule needs — structural, so the server-only row type in
 *  `payroll-readiness.ts` satisfies it without this module importing it. */
export interface RetryableMissingRate {
  /** Enriched department label. Null means the backfill found nothing, so
   *  there is no new information to retry with. */
  department: string | null;
}

/**
 * Filter `missing` down to the rows that are STILL rate-less once the enriched
 * department and identity are taken into account.
 *
 * @param identityFor  every email the row may be resolved on — the aliases it
 *                     was first tried with, unioned with the master row's, and
 *                     only from an exact-alias match (a name-token match is
 *                     trusted for a department label, never for identity: an
 *                     individual catalog or sheet rate resolved off a wrong
 *                     name match would hand someone another person's rate).
 * @param resolvesRate the real rate chain — individual catalog → sheet →
 *                     department base. Must be the SAME resolver the first pass
 *                     used; a weaker test here would be a loosened guard.
 */
export function rowsStillMissingAfterRetry<T extends RetryableMissingRate>(
  missing: T[],
  identityFor: (row: T) => string[],
  resolvesRate: (emails: string[], department: string) => boolean,
): T[] {
  return missing.filter((row) => {
    if (!row.department) return true;
    const emails = identityFor(row);
    if (emails.length === 0) return true;
    return !resolvesRate(emails, row.department);
  });
}
