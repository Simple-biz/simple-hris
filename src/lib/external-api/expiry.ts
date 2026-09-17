/**
 * Key expiry — "set time on how long that key can survive" (Kane, 2026-09-17).
 *
 * Four choices, ruled the same day: **1 day · 15 days · 30 days · does not expire**.
 * "Does not expire" is `expires_at = NULL`; Revoke is always there to stop it.
 *
 * `isExpired` FAILS CLOSED: an `expires_at` that does not parse counts as expired,
 * because a stamp we cannot read is not a stamp we can trust. Pure, clock-injectable.
 */

export const EXPIRY_OPTIONS = ['1d', '15d', '30d', 'never'] as const;
export type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

export const EXPIRY_LABELS: Record<ExpiryOption, string> = {
  '1d': '1 day',
  '15d': '15 days',
  '30d': '30 days',
  never: 'Does not expire',
};

const DAYS: Record<Exclude<ExpiryOption, 'never'>, number> = { '1d': 1, '15d': 15, '30d': 30 };
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseExpiryOption(v: unknown): ExpiryOption | null {
  return typeof v === 'string' && (EXPIRY_OPTIONS as readonly string[]).includes(v) ? (v as ExpiryOption) : null;
}

/** ISO timestamp for the chosen option, or null for "never". */
export function expiresAtFor(option: ExpiryOption, nowMs: number = Date.now()): string | null {
  if (option === 'never') return null;
  return new Date(nowMs + DAYS[option] * DAY_MS).toISOString();
}

/** null = never expires. An unparseable stamp is treated as EXPIRED (fail closed). */
export function isExpired(expiresAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (expiresAt == null) return false;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return true;
  return t <= nowMs;
}

/** Short human form for the table: "never" · "expired" · "in 3d" · "in 5h" · "in 12m". */
export function describeExpiry(expiresAt: string | null | undefined, nowMs: number = Date.now()): string {
  if (expiresAt == null) return 'never';
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return 'expired';
  const left = t - nowMs;
  if (left <= 0) return 'expired';
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(left / 3_600_000);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.ceil(left / DAY_MS)}d`;
}
