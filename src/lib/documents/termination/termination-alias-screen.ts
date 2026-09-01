/** [TERMINATION-DOCS]
 * The last screen an address must pass before it can price a signed letter.
 *
 * G1 says a printed money fact may never be derived from a PERSONAL email. The
 * round-1 fix built the rate alias set from work columns only and dropped any
 * address that appeared in one of the SUBJECT'S OWN `Personal Email` cells
 * (`workAliasesForRateContext`, termination-arbitration.ts). Round 2 found the
 * residue: that screen is scoped to the subject's own master rows, so it removes
 * the harmless self-match and KEEPS a THIRD PARTY'S personal inbox that happens
 * to be parked in an `"Alternate Work Email"` cell — which is the exact shape
 * the fix existed to stop. `hr_pending_employees` and `employee_rate_history`
 * are both keyed by whatever address the sheet era held, so one such cell prints
 * somebody else's hire rate as this person's STARTING RATE.
 *
 * So an alternate work address may enter the rate set only if it is not recorded
 * as ANY person's personal email, anywhere in `global_master_list`. That is a
 * per-address lookup against the `Personal Email` column — targeted, escaped and
 * paged, never a full-table scan into memory — expressed here as an injected
 * PORT so the rule is a unit test rather than a mocked client.
 *
 * TWO THINGS ARE DELIBERATE:
 *   · The subject's OWN WORK EMAIL is never screened. It is the identity; if it
 *     also sits in someone's `Personal Email` cell that is a roster defect, and
 *     dropping it would leave the rate resolver with no address at all.
 *   · A FAILED lookup DROPS the alias. An address whose provenance could not be
 *     established must not price a legal document; the rate falls back to the
 *     work email, and a blank is a question the rep answers, not a wrong number
 *     on a signed page.
 *
 * PURE: no `server-only`, no Supabase, no Node builtin — the same split
 * `termination-arbitration.ts` makes, for the same reason (`npm test` cannot
 * load a `server-only` module).
 */

/** One lookup against `global_master_list."Personal Email"`. */
export interface TerminationAliasScreenPort {
  /**
   * Is `email` recorded as the personal email of ANY master row?
   *
   * `error` is not optional and is never swallowed: the caller drops the alias
   * when a lookup fails, and says so.
   */
  isRecordedAsPersonalEmail(email: string): Promise<{ found: boolean; error: string | null }>;
}

export interface TerminationAliasScreenResult {
  /** The addresses that may key a rate read, work email FIRST. */
  workAliases: string[];
  /** Addresses removed, with why — carried onto the facts sheet's degraded
   *  notes so a blank rate is explained rather than mysterious. */
  dropped: Array<{ email: string; reason: 'recorded_as_personal_email' | 'screen_read_failed' }>;
  degraded: string[];
}

/**
 * Screen a rate-context alias set.
 *
 * @param workEmail the identity. Always survives, never looked up.
 * @param workAliases the candidate set from `workAliasesForRateContext`.
 */
export async function screenWorkAliases(
  workEmail: string,
  workAliases: string[],
  port: TerminationAliasScreenPort,
): Promise<TerminationAliasScreenResult> {
  const kept: string[] = [];
  const dropped: TerminationAliasScreenResult['dropped'] = [];
  const degraded: string[] = [];

  for (const alias of workAliases) {
    if (alias === workEmail) {
      if (!kept.includes(alias)) kept.push(alias);
      continue;
    }
    if (kept.includes(alias)) continue;
    const { found, error } = await port.isRecordedAsPersonalEmail(alias);
    if (error) {
      dropped.push({ email: alias, reason: 'screen_read_failed' });
      degraded.push(
        `${alias} could not be checked against the Personal Email column (${error}), so it was not used to look up a rate. A rate a personal inbox could have supplied is left blank for you to fill.`,
      );
      continue;
    }
    if (found) {
      dropped.push({ email: alias, reason: 'recorded_as_personal_email' });
      degraded.push(
        `${alias} is recorded as somebody's PERSONAL email, so it was not used to look up a rate — one personal inbox backs several master identities and the rate behind it can belong to the other person.`,
      );
      continue;
    }
    kept.push(alias);
  }

  // The identity is never screened out of its own rate lookup.
  if (!kept.includes(workEmail)) kept.unshift(workEmail);
  return { workAliases: kept, dropped, degraded };
}
