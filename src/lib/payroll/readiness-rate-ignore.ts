/**
 * The No Pay Rate list's per-week "Ignore" rule — pure, so the identity-matching
 * hazards are pinned by tests instead of by a live database.
 *
 * Accounting can acknowledge one person's missing rate FOR ONE PAY WEEK
 * (mirroring the Bank Info tab's "Temporary Exemption"): the person leaves the
 * No Pay Rate list and the rate dimension's worker denominator, and shows up
 * under Exceptions instead — an expected non-payment, like an onboarding hire.
 * Week-scoped with no expiry job: the record is only honoured for the
 * `week_start` it was filed against, so the person reappears next week
 * automatically if they log hours and still have no rate.
 *
 * This partition runs AFTER `rowsStillMissingAfterRetry` on purpose — an ignore
 * is only consulted for rows the real rate chain still can't resolve, so an
 * ignore someone has since made moot (the rate got set) simply stops mattering
 * rather than lingering as a stale "ignored" row.
 *
 * Identity direction of safety (same as the bank exemption's): the exemption
 * map is EMAIL-keyed, with a `name:` key only when the record carries no email
 * at all — the master list is full of namesakes and duplicate person rows, so a
 * blanket name key could silently ignore someone who was never ignored (hiding
 * a real payday blocker). The name fallback here is likewise only consulted for
 * a row that matched no alias.
 *
 * Sibling of `readiness-rate-retry.ts`: no I/O, no `server-only` import, so it
 * unit-tests directly.
 */

/** The shape this rule needs — structural, so the server-only row type in
 *  `payroll-readiness.ts` satisfies it without this module importing it. */
export interface IgnorableMissingRate {
  name: string;
}

/**
 * Split the still-missing rows into the ones that stay listed (`kept`) and the
 * ones an active per-week ignore covers (`ignored`, each paired with its
 * matching exemption record so the caller can surface the reason and an Undo).
 *
 * @param aliasesFor       every normalized email the row is known by — the same
 *                          union the post-enrichment retry resolves on.
 * @param exemptByIdentity the week's active ignore records, keyed by normalized
 *                          email (preferred) or `name:<lowercased name>` ONLY
 *                          when the record has no email — see the module doc.
 */
export function partitionIgnoredRates<T extends IgnorableMissingRate, E>(
  rows: T[],
  aliasesFor: (row: T) => string[],
  exemptByIdentity: Map<string, E>,
): { kept: T[]; ignored: { row: T; exemption: E }[] } {
  const kept: T[] = [];
  const ignored: { row: T; exemption: E }[] = [];
  for (const row of rows) {
    let exemption: E | undefined;
    if (exemptByIdentity.size > 0) {
      for (const alias of aliasesFor(row)) {
        exemption = exemptByIdentity.get(alias);
        if (exemption !== undefined) break;
      }
      if (exemption === undefined) {
        const n = row.name.trim().toLowerCase();
        if (n) exemption = exemptByIdentity.get(`name:${n}`);
      }
    }
    if (exemption !== undefined) ignored.push({ row, exemption });
    else kept.push(row);
  }
  return { kept, ignored };
}
