/**
 * Multi-currency FX, USD-anchored.
 *
 * USD is the org's conversion anchor. We store two rates in `app_settings`:
 *   - `usd_to_php_rate` (PHP per $1, ~56)   -- the existing rate (see usd-php.ts)
 *   - `usd_to_cop_rate` (COP per $1, ~4000) -- Colombian peso
 *
 * PHP <-> COP is NEVER a stored rate; it is *derived* through USD
 * (`php_per_cop = usd_to_php_rate / usd_to_cop_rate`). The internal pay engine
 * keeps computing in PHP-equivalent; a non-PHP catalog rate is converted to
 * PHP via `phpPerUnit`, and a native payout amount is reconstructed from the
 * USD anchor via `nativeAmountFromPhp`.
 */
import type { PayCurrency } from '@/lib/payment-catalog/pay-structure';
import {
  OFFICIAL_USD_TO_PHP_RATE,
  effectiveUsdToPhpRateFromStored,
} from './usd-php';

/** Reference COP per $1 used when the stored rate is missing/invalid. */
export const OFFICIAL_USD_TO_COP_RATE = 4000;

/** `app_settings` keys for the two anchor rates. */
export const USD_TO_PHP_SETTINGS_KEY = 'usd_to_php_rate';
export const USD_TO_COP_SETTINGS_KEY = 'usd_to_cop_rate';

/** Value from `app_settings` key `usd_to_cop_rate` (COP per $1). Falls back to the official rate when missing or invalid. */
export function effectiveUsdToCopRateFromStored(raw: string | null | undefined): number {
  if (raw == null || String(raw).trim() === '') return OFFICIAL_USD_TO_COP_RATE;
  const n = parseFloat(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return OFFICIAL_USD_TO_COP_RATE;
  return n;
}

/** The two USD-anchored rates the app converts through. */
export interface FxRates {
  /** PHP per $1. */
  usdToPhp: number;
  /** COP per $1. */
  usdToCop: number;
}

/** Build an {@link FxRates} from a bag of raw app_settings values (as returned
 *  by `getAppSettings`). Missing/invalid values fall back to the official rates. */
export function buildFxRates(appSettings: Record<string, string | null | undefined>): FxRates {
  return {
    usdToPhp: effectiveUsdToPhpRateFromStored(appSettings[USD_TO_PHP_SETTINGS_KEY]),
    usdToCop: effectiveUsdToCopRateFromStored(appSettings[USD_TO_COP_SETTINGS_KEY]),
  };
}

/** Convenience default (official rates). */
export function officialFxRates(): FxRates {
  return { usdToPhp: OFFICIAL_USD_TO_PHP_RATE, usdToCop: OFFICIAL_USD_TO_COP_RATE };
}

/** PHP value of 1 unit of `currency`. PHP->1, USD->usdToPhp, COP->usdToPhp/usdToCop.
 *  This is the factor the rate engine multiplies a native rate by to get a
 *  PHP-equivalent. Guards against a zero/invalid COP rate (-> 0, never Infinity). */
export function phpPerUnit(currency: PayCurrency, fx: FxRates): number {
  switch (currency) {
    case 'USD':
      return fx.usdToPhp;
    case 'COP':
      return fx.usdToCop > 0 ? fx.usdToPhp / fx.usdToCop : 0;
    case 'PHP':
    default:
      return 1;
  }
}

/** Derived PHP <-> COP cross-rates (display only; USD is the real anchor). */
export function phpPerCop(fx: FxRates): number {
  return fx.usdToCop > 0 ? fx.usdToPhp / fx.usdToCop : 0;
}
export function copPerPhp(fx: FxRates): number {
  return fx.usdToPhp > 0 ? fx.usdToCop / fx.usdToPhp : 0;
}

/** Reconstruct the NATIVE payout amount for `currency` from a PHP-equivalent
 *  figure, pivoting on the USD anchor:
 *    PHP -> as-is
 *    USD -> phpAmount / usdToPhp
 *    COP -> (phpAmount / usdToPhp) * usdToCop
 *  Returns 0 on a non-finite input. Rounding (e.g. whole COP) is the caller's job. */
export function nativeAmountFromPhp(
  phpAmount: number,
  currency: PayCurrency,
  fx: FxRates,
): number {
  if (!Number.isFinite(phpAmount)) return 0;
  switch (currency) {
    case 'USD':
      return fx.usdToPhp > 0 ? phpAmount / fx.usdToPhp : 0;
    case 'COP':
      return fx.usdToPhp > 0 ? (phpAmount / fx.usdToPhp) * fx.usdToCop : 0;
    case 'PHP':
    default:
      return phpAmount;
  }
}
