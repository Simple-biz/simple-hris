/**
 * Official USD → PHP conversion (policy): Philippine peso reference amount, then
 * move the decimal 5 places left (divide by 10⁵).
 */
export const PHILIPPINE_PESO_OFFICIAL = 100_000;
export const USD_TO_PHP_DECIMAL_SHIFT = 5;

export const OFFICIAL_USD_TO_PHP_RATE =
  PHILIPPINE_PESO_OFFICIAL / 10 ** USD_TO_PHP_DECIMAL_SHIFT;

/** Value from `app_settings` key `usd_to_php_rate` (PHP per $1). Falls back to the official rate when missing or invalid. */
export function effectiveUsdToPhpRateFromStored(raw: string | null | undefined): number {
  if (raw == null || String(raw).trim() === '') return OFFICIAL_USD_TO_PHP_RATE;
  const n = parseFloat(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return OFFICIAL_USD_TO_PHP_RATE;
  return n;
}
