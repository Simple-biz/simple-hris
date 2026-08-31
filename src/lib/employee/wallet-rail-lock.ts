import 'server-only';

import { getEmployeeIdRowByEmail } from '@/lib/supabase/employee-ids';
import { getEmployeeHourlyRateRowByEmail } from '@/lib/supabase/employee-hourly-rates';
import {
  disbursementWalletMoveNeedsCheck,
  isWalletRailLocked,
  type ProcessorId,
} from '@/lib/employee-payment-processors';
import { resolveEffectivePayoutProcessor } from './payout-completeness';

/**
 * Is this person barred from the Kolan / HiGlobe wallet rails?
 *
 * **Judged on the EFFECTIVE rail, across all three routing tiers** —
 * `employee_ids.bank_preferred`, then `employee_ids.preferred_processor`, then
 * the legacy `employee_hourly_rates."Bank Preferred"` cell — using the same
 * resolver Payment Dispatch routes on.
 *
 * Reading only tier 1 is wrong in both directions and was the bug this module
 * exists to fix. Roughly 1,351 people were seeded into the legacy cell in
 * 2026-07-22 with `preferred_processor` deliberately cleared for 466 of them, so
 * a large population is *explicitly* on wires with `bank_preferred` still NULL.
 * Under a tier-1-only lock they read as "never assigned" and would be freely
 * assignable to a wallet they cannot receive into. The converse also held:
 * someone whose sheet cell already said Hurupay read as locked out of the very
 * rail they were being paid on.
 *
 * **Fails CLOSED.** Any read error returns `locked: true` with the error
 * attached. A transient database blip must never be the reason a wire-only
 * payee gets moved onto a wallet — the caller should surface the error rather
 * than treat it as "no rail assigned".
 */
export async function resolveWalletRailLock(email: string): Promise<{
  locked: boolean;
  effectiveRail: ProcessorId | null;
  error: string | null;
}> {
  const target = (email ?? '').trim();
  if (!target) return { locked: true, effectiveRail: null, error: 'No email supplied.' };

  const { row, error: idsErr } = await getEmployeeIdRowByEmail(target).catch((e: unknown) => ({
    row: null,
    error: e instanceof Error ? e.message : String(e),
  }));
  if (idsErr) return { locked: true, effectiveRail: null, error: idsErr };

  // Tier 3. A failure here is NOT best-effort: without the legacy cell we
  // cannot tell "never assigned" from "on wires via the rates sheet", which is
  // exactly the distinction the lock turns on.
  const { row: legacyRow, error: rateErr } = await getEmployeeHourlyRateRowByEmail(
    row?.work_email ?? target,
  ).catch((e: unknown) => ({
    row: null,
    error: e instanceof Error ? e.message : String(e),
  }));
  if (rateErr) return { locked: true, effectiveRail: null, error: rateErr };

  const effectiveRail = resolveEffectivePayoutProcessor(
    (row ?? null) as unknown as Record<string, unknown> | null,
    legacyRow ? { bankPreferredRaw: legacyRow.bank_preferred } : undefined,
  );

  // `effectiveRail === null` means no tier resolved anything at all — a
  // genuinely unassigned person, who IS assignable (Kane, 2026-08-24).
  return { locked: isWalletRailLocked(effectiveRail), effectiveRail, error: null };
}

/**
 * May this employee move their **receiving channel** (`preferred_processor`) onto
 * a WALLET rail — Kolan or HiGlobe?
 *
 * **This exists because the two fields had opposite security postures.**
 * `bank_preferred` (send-from) is approval-gated and WIRES-locked at five sites;
 * `preferred_processor` (receiving) was employee-writable, immediately, with no
 * lock check at all. But `preferred_processor` is **tier 2 of the routing
 * precedence**, so for the 1,796 people whose tier 1 is NULL that ungated field
 * *is* the rail Payment Dispatch pays out on. A payee explicitly on wires via
 * the legacy rates cell could therefore re-route their own salary onto a wallet
 * in one save — no approval, no lock — and, once the effective rail read as a
 * wallet, unlock the Bank Preferred field too on the next load. Kane's ruling
 * 2026-08-31: gate the receiving side by the same verdict, keep the coupling
 * one-way (see bank-preferred-routing.md §4 and the memory entry).
 *
 * **WALLET RAILS ONLY.** A move to wise / jeeves / wires / wepay returns
 * `allowed` without a single database read: those rails send from one place into
 * the person's own bank, so the two fields stay independent — that independence
 * is what the 2026-07-22 decoupling protected and it is untouched here.
 *
 * A no-op (`current === next`) is always allowed. Otherwise a locked payee would
 * be unable to save their ADDRESS, because both self-service forms post the whole
 * payout payload including an unchanged `preferred_processor`.
 *
 * **Fails CLOSED**: an unresolvable rail is a 503, never an allowed wallet move.
 */
export async function checkDisbursementWalletMove(opts: {
  email: string;
  /** The employee's stored `preferred_processor`. */
  current: string | null | undefined;
  /** The requested `preferred_processor`. */
  next: string | null | undefined;
}): Promise<{ allowed: true } | { allowed: false; error: string; status: number }> {
  // Scope + no-op short-circuit, pure and unit-tested: a move to
  // wise/jeeves/wires and a save that does not change the channel both return
  // here without a single database read.
  if (!disbursementWalletMoveNeedsCheck(opts.current, opts.next)) return { allowed: true };

  const { locked, effectiveRail, error } = await resolveWalletRailLock(opts.email);
  if (error) {
    return {
      allowed: false,
      status: 503,
      error: 'Could not confirm your payout rail just now. Please try again in a moment.',
    };
  }
  if (locked) {
    return {
      allowed: false,
      status: 400,
      error:
        `Your salary is sent out on ${effectiveRail ?? 'a bank rail'}, so it cannot be received ` +
        `on a Kolan or HiGlobe wallet. Accounting can change the sending rail for you.`,
    };
  }
  return { allowed: true };
}
