// The effective date of a MESA enrollment.
//
// Accounting picks it on Accounting → MESA → Non Members → Opt In (2026-09-15;
// before that the dialog said "effective today" and sent nothing). The toggle
// route stamps the SAME value onto two places at once:
//
//   employee_hourly_rates.mesa_member_since — the Payroll Wizard charges ₱100
//     only for pay weeks ending on/after it, and the Hubstaff upload writes the
//     ₱100 + ₱300 deposit only for those weeks (docs/features/mesa.md:128);
//   mesa_accounts.opened_on — every visible balance is the ledger sliced to
//     events on/after it, and the account number's YY-MM is minted from it
//     (references/sql/migrate/2026-07-16_mesa_accounts.sql).
//
// So the date is not a label. A malformed one lands in two DATE columns; a
// back-dated one can re-count money. The rules that keep that from happening
// live here, browser-safe, so the dialog and the route can never disagree.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict `YYYY-MM-DD` naming a real calendar day — `2026-02-30` is refused. */
export function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export type EnrollmentDateResolution =
  | { ok: true; date: string; /** True when no date was sent and `today` filled in. */ defaulted: boolean }
  | { ok: false; error: string };

/**
 * Resolve the `since` a caller sent. Absent (`undefined`, `null`, or blank)
 * means "today" — the caller's `today`, which the route reads in Manila, never
 * the server's UTC day. Anything present must be a strict calendar date.
 *
 * Nothing is sliced or coerced. The old handling was
 * `since.trim().slice(0, 10) || today`, which accepted `2026-09-05T10:00:00Z`
 * and `hello` alike and let the database be the one to object.
 */
export function resolveEnrollmentDate(input: unknown, today: string): EnrollmentDateResolution {
  if (input === undefined || input === null) return { ok: true, date: today, defaulted: true };
  if (typeof input !== 'string') return { ok: false, error: 'since must be a YYYY-MM-DD string' };
  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, date: today, defaulted: true };
  if (!isCalendarDate(trimmed)) {
    return { ok: false, error: `since must be a real calendar date in YYYY-MM-DD form (got "${input}")` };
  }
  return { ok: true, date: trimmed, defaulted: false };
}

/** The bits of a `mesa_accounts` row these rules need. */
export interface AccountRef {
  account_number: string;
  opened_on: string; // YYYY-MM-DD
}

/**
 * The member already has an OPEN account — they are enrolled. Re-enrolling
 * with no date, or with the date the account already carries, is idempotent
 * (HR re-approving a duplicate opt-in; a stale Non Members tab). A DIFFERENT
 * explicit date is refused: stamping it on `mesa_member_since` while
 * `opened_on` stays put is exactly the drift `verify-mesa-backfill` reports,
 * and a re-enrollment cannot move an open account's window. Opt out first.
 *
 * Returns the refusal, or null when the enrollment may proceed.
 */
export function openAccountConflict(
  since: string,
  sinceWasExplicit: boolean,
  open: AccountRef | null,
): string | null {
  if (!open) return null;
  if (!sinceWasExplicit || since === open.opened_on) return null;
  return (
    `Already enrolled — MESA account ${open.account_number} has been open since ${open.opened_on}. ` +
    `An effective date of ${since} cannot be applied to an open account; opt them out first to re-enroll on a new date.`
  );
}

/**
 * The member holds an open account under an ALIAS of the address being opted
 * in — their MESA identity is an old email (`dale@` for `dales@`) that
 * `src/data/mesa-email-aliases.json` bridges on the read path.
 *
 * `getOpenMesaAccount` resolves the open account by the ONE email it is handed,
 * finds none for a drifted member, and mints a SECOND account whose window
 * starts today — hiding the balance they already hold, because every balance is
 * the ledger sliced to `opened_on` (docs/features/mesa.md:225). That was a
 * latent hazard while these people sat on Active Members, out of reach of the
 * Opt In button; a failed `/api/mesa-ledger` drops them onto Non Members, where
 * the button IS reachable, so it is refused here instead of being left to
 * chance.
 *
 * The refusal is deliberate and total: this route does not enrol into someone
 * else's account row either. The repair is
 * `scripts/fix-mesa-aliased-membership.mjs`, which stamps the rate rows from
 * the EXISTING account and mints nothing.
 *
 * Returns the refusal, or null when no alias holds an open account.
 */
export function aliasAccountConflict(
  email: string,
  aliasOpen: { email: string; account: AccountRef } | null,
): string | null {
  if (!aliasOpen) return null;
  return (
    `${email} already holds MESA account ${aliasOpen.account.account_number}, open since ` +
    `${aliasOpen.account.opened_on}, under their earlier address ${aliasOpen.email}. ` +
    `Opting in here would mint a SECOND account starting today and hide the balance they already hold. ` +
    `Nothing was changed — repair the payroll flag with ` +
    `\`node scripts/fix-mesa-aliased-membership.mjs --only ${email} --apply\`.`
  );
}

/**
 * The member's most recent CLOSED stint ended on `latestClosedOn`. A new
 * account opening on or before that day would have a window
 * (events >= opened_on) reaching back into the closed stint, so its deposits
 * — whose balance was already released as an `offboard_payout` when it closed
 * (memory: mesa-optout-releases-balance) — would be counted a second time.
 * The new stint must start strictly after the old one ended.
 *
 * Returns the refusal, or null when the date is clear of every closed stint.
 */
export function closedStintConflict(since: string, latestClosedOn: string | null): string | null {
  if (!latestClosedOn) return null;
  if (since > latestClosedOn) return null;
  return (
    `Effective date ${since} is on or before ${latestClosedOn}, the day this member's previous MESA account closed. ` +
    `A new account must start after that, or the closed stint's deposits would be counted again.`
  );
}
