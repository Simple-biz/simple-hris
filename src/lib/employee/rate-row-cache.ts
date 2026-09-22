/**
 * What of an `EmployeeHourlyRateRow` may be written to `sessionStorage`.
 *
 * ## Why this module exists
 *
 * `GET /api/employee-hourly-rates` returns ONE row that carries two unrelated
 * things: the person's pay rate, and their **payment-dispatch routing** —
 * `bank_preferred`, `hurupay_email`, `higlobe_email`, `higlobe_account_name`,
 * `phone_number`, `full_address`, `city`, `province_state` and the open MESA
 * `mesa_account_number`.
 *
 * `employee-dashboard-cache.md` says the bank/payout row is never cached
 * ("account numbers stay out of storage"), and `admin-dashboard-cache.md` states
 * the same prohibition for its own store. Both are pinned by tests that grep
 * **key spellings** — no key is named after a bank — and a routing field riding
 * inside a rate row is exactly the shape those tests cannot see. `EmployeeProfile`
 * cached the whole row under `employee:profile-rate` from 2026-09-03 until this
 * module landed, so every signed-in employee's own home address, phone number
 * and wallet addresses sat in `sessionStorage` until the tab closed.
 *
 * So the cache stores a PROJECTION, and the projection is the only way in.
 *
 * ## The partition is checked by the compiler, not by a comment
 *
 * Every key of `EmployeeHourlyRateRow` must appear in exactly one of the two
 * lists below. Adding a field to that type without classifying it here is a
 * **compile error**, not a silent leak — which is the property the key-spelling
 * tests could not give us. A new routing field therefore cannot reach storage by
 * being added upstream and forgotten about here.
 */

import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';

/** Pay identity and programme membership. Safe to mirror. */
const CACHEABLE_RATE_KEYS = [
  'work_email',
  'personal_email',
  'regular_rate',
  'ot_rate',
  'department',
  'mesa_member',
  'mesa_member_since',
  'mesa_fpu_completed_on',
] as const;

/**
 * Payment routing and contact details. NEVER mirrored.
 *
 * `mesa_account_number` is in here because it is an account number, even though
 * it is not a bank account: the rule is about what the string identifies, not
 * which system issued it.
 */
const UNCACHEABLE_RATE_KEYS = [
  'bank_preferred',
  'hurupay_email',
  'higlobe_email',
  'higlobe_account_name',
  'phone_number',
  'full_address',
  'city',
  'province_state',
  'mesa_account_number',
] as const;

type CacheableKey = (typeof CACHEABLE_RATE_KEYS)[number];
type UncacheableKey = (typeof UNCACHEABLE_RATE_KEYS)[number];

/**
 * Compile-time proof that the two lists above **partition** the row's keys —
 * neither overlapping nor leaving a field unclassified.
 *
 * If you added a column to `EmployeeHourlyRateRow` and landed here: decide which
 * list it belongs in. If it identifies where money goes or how to reach the
 * person, it belongs in `UNCACHEABLE_RATE_KEYS`.
 */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _keysArePartitioned: AssertEqual<
  CacheableKey | UncacheableKey,
  keyof EmployeeHourlyRateRow
> = true;
void _keysArePartitioned;

/** The rate row as it is allowed to exist in `sessionStorage`. */
export type CachedEmployeeRate = Pick<EmployeeHourlyRateRow, CacheableKey>;

/**
 * Narrow a live rate row to the cacheable projection.
 *
 * Call this on the way INTO state that is bound to `useEmployeeCachedState`, so
 * the routing fields are gone before anything can persist them. Reads the keys
 * off the allow-list rather than spreading-and-deleting: a field that is not
 * named here is not copied, so the failure direction is "missing", never "leaked".
 */
export function toCachedEmployeeRate(
  row: EmployeeHourlyRateRow | null | undefined,
): CachedEmployeeRate | null {
  if (!row) return null;
  const out = {} as Record<CacheableKey, unknown>;
  for (const key of CACHEABLE_RATE_KEYS) out[key] = row[key];
  return out as CachedEmployeeRate;
}

/** Exported for the test that pins the prohibition from the outside. */
export const __RATE_CACHE_KEY_LISTS = {
  cacheable: CACHEABLE_RATE_KEYS,
  uncacheable: UNCACHEABLE_RATE_KEYS,
} as const;
