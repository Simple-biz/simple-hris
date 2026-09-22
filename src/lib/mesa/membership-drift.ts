// Does the payroll deduction agree with the MESA ledger about who is a member?
//
// MESA membership is decided by TWO keys that resolve differently, and the
// disagreement is silent by construction:
//
//   • the READ path (Accounting → MESA → Active Members, /api/mesa-ledger,
//     `summarizeMembers`) resolves every ledger email through
//     `src/data/mesa-email-aliases.json`, so a member whose ledger identity is
//     an old address still shows up, with their balance;
//   • the PAY path (Payroll Wizard, current-pay.ts, member-monthly-pay.ts, the
//     weekly ledger writer) gates on `employee_hourly_rates.mesa_member`, which
//     nothing alias-resolves.
//
// When the two disagree the tab says "member, ₱3,600" and payroll takes
// nothing — `jimg@simple.biz` was never charged from 2026-06 to 2026-09-15 and
// `dales@simple.biz` the same, and NOTHING IN THE APP SAID SO. The defect was
// only ever visible to a hand-run probe. This module is the missing predicate:
// it states, in one place, what the pay path will actually do, and names the
// disagreement so a surface can render it.
//
// It DECIDES NOTHING ABOUT MONEY. `mesa_member` remains the sole decider of the
// deduction (docs/features/mesa.md:130, :165) — nothing here is wired into a
// compute path, and reading the ledger to decide a charge would be the opposite
// change. This only makes an existing contradiction legible.
//
// See docs/features/mesa.md § "The opposite drift", memory
// mesa-alias-members-never-flagged.

import type { MesaMemberSummary } from '@/lib/mesa/ledger';

/**
 * The two facts that disagree. `ledger` is the member's rollup as the READ path
 * produces it — alias-resolved and scoped to their OPEN account
 * (`summarizeMemberAccount`) — or null when they have no ledger history.
 *
 * `ledger: null` is genuinely ambiguous: it is also what a FAILED ledger fetch
 * leaves behind. A caller that cannot tell the two apart must not report an
 * all-clear; see `MesaDriftScan.ledgerRead` below.
 */
export interface MesaMembershipFacts {
  /** `employee_hourly_rates.mesa_member` — the ONLY thing the pay path reads. */
  readonly mesaMember: boolean;
  readonly ledger: Pick<MesaMemberSummary, 'depositCount' | 'lastEventOptedOut'> | null;
}

/**
 * - `none` — the two agree.
 * - `never_charged` — the ledger holds deposits and no trailing opt-out, but
 *   the flag is false: payroll will NOT take the ₱100. This is the alias drift.
 * - `flag_not_cleared` — the flag is true but the ledger's last event is an
 *   opt-out. Already closed: `isMesaOptedOut` suppresses the deduction
 *   (mesa.md § "Never deduct from a non-member") and the tab routes them to Non
 *   Members. Named here so both directions live in one place and a test can pin
 *   that this one stays suppressed.
 */
export type MesaMembershipDrift = 'none' | 'never_charged' | 'flag_not_cleared';

const optedOut = (f: MesaMembershipFacts): boolean => f.ledger?.lastEventOptedOut === true;

/**
 * What the Payroll Wizard will do, restated: deduct only when
 * `mesa_member === true && !isMesaOptedOut` (docs/features/mesa.md:165).
 *
 * The per-week gate is a SEPARATE and equally single definition —
 * `mesaContributesForWeek` in `./deposit-date` — and is deliberately not folded
 * in here: this answers "is this person in the payable set at all", which is
 * the question the ledger can also answer and therefore the one that can drift.
 *
 * Fail-safe, matching the Wizard's: an unreadable ledger leaves `ledger` null,
 * which reads as "not opted out" and falls back to flag-only. It can never
 * INTRODUCE a deduction the Wizard would not take.
 */
export function mesaPayrollWillCharge(f: MesaMembershipFacts): boolean {
  return f.mesaMember && !optedOut(f);
}

/**
 * What the ledger says: contributions PROVE membership. A member with at least
 * one weekly deposit and no trailing opt-out is saving — this is the same rule
 * `isActiveMember` uses on the Accounting tab, which is why these people appear
 * there at all.
 */
export function mesaLedgerSaysSaving(f: MesaMembershipFacts): boolean {
  return (f.ledger?.depositCount ?? 0) > 0 && !optedOut(f);
}

/** Which way the two sources disagree, if they do. */
export function mesaMembershipDrift(f: MesaMembershipFacts): MesaMembershipDrift {
  if (mesaLedgerSaysSaving(f) && !mesaPayrollWillCharge(f)) return 'never_charged';
  if (f.mesaMember && optedOut(f)) return 'flag_not_cleared';
  return 'none';
}

/**
 * The member is saving and payroll is not charging them. The condition that was
 * true for `jimg@` and `dales@` for fourteen staged paystubs each while every
 * MESA surface showed them as members in good standing.
 */
export function isMesaNeverCharged(f: MesaMembershipFacts): boolean {
  return mesaMembershipDrift(f) === 'never_charged';
}

/**
 * Whether the ledger leg of the comparison was actually read.
 *
 * `/api/mesa-ledger` is best-effort on the Accounting tabs — a failure yields
 * an empty member list rather than blanking the roster. Every row then arrives
 * with `ledger: null`, every drift evaluates to `none`, and a screen that
 * rendered "0 members are not being deducted" off that would be asserting an
 * all-clear it never measured. A failed read is not a clean bill of health, so
 * the scan carries the read state and callers must render the two differently.
 */
export type MesaLedgerRead = 'ok' | 'failed' | 'unknown';

export interface MesaDriftScan<T> {
  readonly ledgerRead: MesaLedgerRead;
  /** Rows whose ledger says saving and whose flag says no. Empty when `ledgerRead !== 'ok'`. */
  readonly neverCharged: readonly T[];
  /** True only when the ledger WAS read and nothing drifted — a measured all-clear. */
  readonly clear: boolean;
}

/**
 * Scan a set of rows for the drift. Returns an empty `neverCharged` with
 * `clear: false` whenever the ledger was not read, so a caller cannot
 * accidentally present an unmeasured screen as a clean one.
 */
export function scanMesaMembershipDrift<T>(
  rows: readonly T[],
  facts: (row: T) => MesaMembershipFacts,
  ledgerRead: MesaLedgerRead,
): MesaDriftScan<T> {
  if (ledgerRead !== 'ok') return { ledgerRead, neverCharged: [], clear: false };
  const neverCharged = rows.filter((r) => isMesaNeverCharged(facts(r)));
  return { ledgerRead, neverCharged, clear: neverCharged.length === 0 };
}
