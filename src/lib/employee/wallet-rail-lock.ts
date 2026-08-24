import 'server-only';

import { getEmployeeIdRowByEmail } from '@/lib/supabase/employee-ids';
import { getEmployeeHourlyRateRowByEmail } from '@/lib/supabase/employee-hourly-rates';
import {
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
