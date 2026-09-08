/**
 * SETTLEMENT currency — the currency a person is actually PAID in.
 *
 * This is a DIFFERENT AXIS from a bonus's or a pay structure's catalog currency,
 * and conflating the two is the expensive bug this module exists to prevent:
 *
 *   catalog currency     what an AMOUNT is denominated in
 *                        → `phpPerUnit()` → PHP-equivalent → stored/paid
 *   settlement currency  what a PERSON is paid in  (this module)
 *                        → `nativeAmountFromPhp()` → the figure a human keys
 *                          into the bank
 *
 * A Colombian on the ordinary PHP rails has catalog currency PHP (their rates
 * and bonuses are peso-denominated) and settlement currency COP (Kane keys
 * Colombian banks in COP). Feeding a settlement currency into `phpPerUnit` —
 * i.e. treating a ₱1,200 bonus as COP 1,200 — pays about ₱18 instead of ₱1,200.
 * So settlement currency NEVER reaches `computeAmount`, `resolveCatalogRate`,
 * `bonus_catalog_applied.amount` or `pay_php`: those stay PHP-pivot, and the
 * native figure is reconstructed for display/settlement only.
 *
 * `payCurrency` is also untouched. Flipping a Colombian's `payCurrency` to
 * 'COP' would move them out of their Kolan/Wires processor queue and into the
 * empty COP tab, i.e. silently unpaid.
 *
 * Docs: `docs/features/cop-country-payees.md`.
 */
import type { PayCurrency } from '@/lib/payment-catalog/pay-structure';
import {
  type FxRates,
  OFFICIAL_USD_TO_COP_RATE,
  nativeAmountFromPhp,
} from '@/lib/fx/currency-fx';
import { OFFICIAL_USD_TO_PHP_RATE } from '@/lib/fx/usd-php';
import { currencyForCountry } from '@/lib/onboarding/countries';
import { normEmail } from '@/lib/email/norm-email';

/** A row of the onboarding paperwork, narrowed to the country question.
 *
 *  `country` is the hire's OWN selection and the only trustworthy source.
 *  `invite_country` (HR's invite-side pick) is deliberately absent from this
 *  type so it cannot be passed by mistake: it has real misclicks on
 *  never-submitted invites — a Filipino hire was invited under "Colombia" —
 *  and a wrong COP marker puts a Colombian-peso figure on a Filipino's pay. */
export type OnboardingCountryRow = {
  email: string | null;
  invite_personal_email: string | null;
  country: string | null;
};

/** A work↔personal pair belonging to one human (e.g. an `employee_hourly_rates`
 *  row) — the second identity bridge, for people whose master row is missing or
 *  carries a different personal email than their submission. */
export type EmailPair = {
  work_email: string | null;
  personal_email: string | null;
};

/**
 * Build `email → settlement currency` for every alias of everyone who filed
 * onboarding paperwork with a mappable country.
 *
 * Submissions are filed under the hire's PERSONAL email while pay entries key
 * on the work (Hubstaff) email, so the marker is bridged two ways — through the
 * master-list alias map, then through work↔personal rate pairs. A missing
 * bridge is the difference between a Colombian seeing COP and seeing nothing,
 * which is why both passes are here rather than only the obvious one.
 *
 * Pure and synchronous so the same logic serves the bulk pay computation and
 * the per-surface route without a second implementation to keep in sync.
 * First writer wins on every key (a primary is never overwritten by an alias).
 */
export function buildSettlementCurrencyByEmail(
  onboardingRows: readonly OnboardingCountryRow[],
  aliasesByEmail: ReadonlyMap<string, readonly string[]>,
  aliasPairs: readonly EmailPair[] = [],
): Map<string, PayCurrency> {
  const byEmail = new Map<string, PayCurrency>();
  for (const row of onboardingRows) {
    const cur = currencyForCountry(row.country);
    if (!cur) continue;
    for (const raw of [row.email, row.invite_personal_email]) {
      const e = normEmail(raw);
      if (!e) continue;
      for (const alias of aliasesByEmail.get(e) ?? [e]) {
        if (!byEmail.has(alias)) byEmail.set(alias, cur);
      }
    }
  }
  // Second bridge: a rates row pairs one human's work and personal addresses,
  // so a marker landing on either end propagates to the other.
  for (const pair of aliasPairs) {
    const we = normEmail(pair.work_email);
    const pe = normEmail(pair.personal_email);
    if (!we || !pe) continue;
    const cur = byEmail.get(we) ?? byEmail.get(pe);
    if (!cur) continue;
    if (!byEmail.has(we)) byEmail.set(we, cur);
    if (!byEmail.has(pe)) byEmail.set(pe, cur);
  }
  return byEmail;
}

/**
 * TRUE when a settlement currency is worth showing natively — i.e. it differs
 * from the PHP the amount is already denominated in. A Filipino settles in PHP,
 * so there is no second figure to render and no sticker to show.
 */
export function isNativeSettlement(currency: PayCurrency | null | undefined): boolean {
  return currency != null && currency !== 'PHP';
}

/**
 * Whether the FX rates on hand may be used to state a native settlement figure.
 *
 * This exists because BOTH failure modes are silent:
 *
 * - **`unset`** — the per-cycle rate starts at 0 on every new Hubstaff upload
 *   (setting it IS the confirmation). At 0 a COP figure renders as `COP 0` on a
 *   real bonus.
 * - **`fallback`** — `effectiveUsdToCopRateFromStored` replaces a missing rate
 *   with `OFFICIAL_USD_TO_COP_RATE` (4000), which is indistinguishable from a
 *   real COP rate, and `OFFICIAL_USD_TO_PHP_RATE` is literally 1. A figure built
 *   on either is a fabricated number wearing a currency symbol.
 *
 * So callers must resolve provenance from the RAW `app_settings` values, never
 * through the `effectiveUsdTo*RateFromStored` helpers — those are precisely what
 * erase the zero. A non-`live` result means: show the peso figure and say the
 * rate is not set. It must never mean: show a native figure anyway.
 */
export type SettlementRate =
  | { status: 'live'; fx: FxRates }
  | { status: 'unset' }
  | { status: 'fallback' };

/** Parse one raw `app_settings` rate string. Null when absent/blank/unparseable/≤0. */
function parseRate(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve a displayable settlement rate from the RAW `usd_to_php_rate` /
 * `usd_to_cop_rate` values. Either leg absent or ≤ 0 → `unset`; either leg
 * sitting exactly on its official placeholder → `fallback`.
 *
 * Both legs matter even for a COP figure: COP is reconstructed through the USD
 * anchor (`php → usd → cop`), so a bad PHP leg corrupts the COP result just as
 * badly as a bad COP leg.
 */
export function resolveSettlementRate(
  rawUsdToPhp: string | null | undefined,
  rawUsdToCop: string | null | undefined,
): SettlementRate {
  const php = parseRate(rawUsdToPhp);
  const cop = parseRate(rawUsdToCop);
  if (php == null || cop == null) return { status: 'unset' };
  if (php === OFFICIAL_USD_TO_PHP_RATE || cop === OFFICIAL_USD_TO_COP_RATE) {
    return { status: 'fallback' };
  }
  return { status: 'live', fx: { usdToPhp: php, usdToCop: cop } };
}

/**
 * The native settlement figure for a PHP-equivalent amount, or NULL when it
 * cannot be stated honestly (non-native settlement, or a rate that is not
 * `live`). Null is the whole point: the caller renders pesos instead of a
 * plausible-looking fabrication.
 *
 * COP has no minor unit, so a COP result is rounded to whole pesos — the same
 * granularity Payment Dispatch copies into a bank field.
 */
export function settlementAmountFromPhp(
  php: number,
  currency: PayCurrency | null | undefined,
  rate: SettlementRate,
): number | null {
  if (!isNativeSettlement(currency) || rate.status !== 'live') return null;
  if (!Number.isFinite(php)) return null;
  const native = nativeAmountFromPhp(php, currency as PayCurrency, rate.fx);
  if (!Number.isFinite(native)) return null;
  return currency === 'COP' ? Math.round(native) : Math.round(native * 100) / 100;
}
