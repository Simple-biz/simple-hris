/**
 * What of an `EmployeeRow` (the global master list row) may be written to
 * `sessionStorage`.
 *
 * ## Why this is separate from what the API returns
 *
 * `GET /api/employees` returns the whole roster, and an `EmployeeRow` is not
 * just an identity. It carries the person's **home address** (`street`, `city`,
 * `province`, `postal_code`, `full_address`, the free-text `location`), their
 * **contact phone**, their **pay rates** (`regular_rate`, `ot_rate`,
 * `hsl_hourly_rate`, `hsl_ot_rate`, `hourlyRate`) and a `bankInfo` block with an
 * account number and a routing number.
 *
 * An admin is allowed to *fetch* all of that. Mirroring ~2,800 people's home
 * addresses and phone numbers onto disk, where they survive reloads and sit in
 * the browser profile until the tab closes, is a different exposure from holding
 * them in memory for one render — and it is the exposure
 * `employee-dashboard-cache.md` and `admin-dashboard-cache.md` both forbid
 * ("never cache a plaintext key, a bank field, a signed URL or presence").
 *
 * Both stores pin that rule with tests that grep **key spellings**. A bank field
 * nested inside a roster row is exactly what a key-spelling test cannot see —
 * the same blind spot that let `employee:profile-rate` mirror payment routing
 * for three weeks. So the cache stores a PROJECTION, and the projection is the
 * only way in.
 *
 * `bankInfo` is `null` on every row `getEmployees()` builds today, so nothing is
 * leaking through this path right now. It is classified as uncacheable anyway:
 * the type permits it, and "the producer happens not to fill it in" is not a
 * guarantee anyone reading the call site can see.
 *
 * ## The partition is checked by the compiler
 *
 * Every key of `EmployeeRow` must appear in exactly one of the two lists below.
 * Adding a column upstream without classifying it here is a **compile error**,
 * not a silent leak.
 */

import type { EmployeeRow } from '@/lib/supabase/employees';

/** Identity, org placement and avatars — what a roster picker actually renders. */
const CACHEABLE_MASTER_KEYS = [
  'id',
  'employee_id',
  'department',
  'name',
  'personal_email',
  'work_email',
  'alternate_work_email',
  'alternate_work_email_2',
  'start_date',
  'profile_photo_url',
  'google_photo_url',
  'hsl_role',
  'mesa_member',
  'calltools_username',
] as const;

/**
 * Home address, contact phone, pay rates and bank details. NEVER mirrored.
 *
 * The rates are in here for a different reason from the addresses: a cached pay
 * rate is a stale pay figure with no "as of" label, and `manager-my-team.md`
 * strips compensation from every roster surface that is not explicitly a pay
 * screen. A roster cache must not become the back door that reintroduces one.
 */
const UNCACHEABLE_MASTER_KEYS = [
  'street',
  'city',
  'province',
  'postal_code',
  'full_address',
  'location',
  'phone_number',
  'bankInfo',
  'hourlyRate',
  'regular_rate',
  'ot_rate',
  'hsl_hourly_rate',
  'hsl_ot_rate',
] as const;

type CacheableKey = (typeof CACHEABLE_MASTER_KEYS)[number];
type UncacheableKey = (typeof UNCACHEABLE_MASTER_KEYS)[number];

/**
 * Compile-time proof that the two lists above **partition** the row's keys.
 *
 * If you added a column to `EmployeeRow` and landed here: decide which list it
 * belongs in. If it is an address, a phone number, a pay figure, or anything
 * that says where money goes, it belongs in `UNCACHEABLE_MASTER_KEYS`.
 */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _keysArePartitioned: AssertEqual<CacheableKey | UncacheableKey, keyof EmployeeRow> = true;
void _keysArePartitioned;

/** A master-list row as it is allowed to exist in `sessionStorage`. */
export type CachedMasterRow = Pick<EmployeeRow, CacheableKey>;

/**
 * Narrow one live roster row to the cacheable projection.
 *
 * Copies from the allow-list rather than spreading-and-deleting, so a field that
 * is not named here is not copied — the failure direction is "missing", never
 * "leaked". Keys whose value is `undefined` are dropped rather than written as
 * `undefined`, which `JSON.stringify` would erase anyway.
 */
export function toCachedMasterRow(row: EmployeeRow): CachedMasterRow {
  const out: Record<string, unknown> = {};
  for (const key of CACHEABLE_MASTER_KEYS) {
    const value = row[key];
    if (value !== undefined) out[key] = value;
  }
  return out as CachedMasterRow;
}

/** Narrow a whole roster. */
export function toCachedMasterRows(rows: readonly EmployeeRow[]): CachedMasterRow[] {
  return rows.map(toCachedMasterRow);
}

/** Exported for the test that pins the prohibition from the outside. */
export const __MASTER_CACHE_KEY_LISTS = {
  cacheable: CACHEABLE_MASTER_KEYS,
  uncacheable: UNCACHEABLE_MASTER_KEYS,
} as const;
