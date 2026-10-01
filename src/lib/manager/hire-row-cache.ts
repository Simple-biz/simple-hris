/**
 * What of a staged-hire row (`hr_pending_employees`) may be written to the
 * Manager tab cache, which mirrors to `sessionStorage`.
 *
 * ## Why this is separate from what the API returns
 *
 * `/api/manager/pending-hires` and `/api/manager/orientation-history` both
 * return whole `HrPendingEmployeeRow`s. That row is not just an identity: it
 * carries the hire's **phone**, their **location**, the HR-record-only **middle
 * name**, and the catalog-resolved **pay rates** (`regular_rate`, `ot_rate`).
 *
 * The routes null the rates for a viewer without rate visibility — but they
 * pass them through untouched for one who has it (`hasRateVisibility`: admin,
 * accounting, CEO), and an admin who manages a department is exactly who opens
 * this tab. `manager-orientation-attendance.md` § *The manager sees no money,
 * anywhere* and `manager-dashboard-cache.md` § *Not cached, on purpose* ("anything
 * carrying a pay rate") both forbid a cached copy becoming the back door that
 * reintroduces one. Neither panel renders a rate, a phone or a location.
 *
 * So the cache stores a PROJECTION, and the projection is the only way in —
 * the shape `src/lib/employee/master-row-cache.ts` established.
 *
 * ## The partition is checked by the compiler
 *
 * Every key of `HrPendingEmployeeRow` must appear in exactly one of the two
 * lists below. Adding a column upstream without classifying it here is a
 * **compile error**, not a silent leak.
 */

import type { HrPendingEmployeeRow } from '@/lib/supabase/hr-pending-employees';

/** Identity, placement and the orientation trail — what the New Hire Check
 *  List cards and the Orientation tally actually render. */
const CACHEABLE_HIRE_KEYS = [
  'id',
  'created_at',
  'name',
  'personal_email',
  'work_email',
  'department',
  'job_description',
  'start_date',
  'status',
  'source',
  'orientation_attended_at',
  'orientation_attended_by',
  'orientation_note',
  'no_show_at',
  'no_show_by',
  'no_show_note',
] as const;

/**
 * NEVER mirrored. Pay rates, contact and address fields, the HR-record-only
 * name parts, and the bookkeeping neither panel renders.
 *
 * The failure direction of leaving an unrendered field here is "missing from a
 * painted card until the live read lands", never "leaked to disk".
 */
const UNCACHEABLE_HIRE_KEYS = [
  'regular_rate',
  'ot_rate',
  'phone',
  'location',
  'first_name',
  'middle_name',
  'last_name',
  'name_extension',
  'display_name',
  'country',
  'notes',
  'created_by',
  'updated_at',
  'promoted_at',
  'promoted_to_master_id',
  'scheduled_deletion_at',
  'deletion_processed_at',
  'onboarding_submission_id',
  'project_names',
] as const;

/**
 * Not a column: `/api/manager/pending-hires` attaches the Lead Gen hire's
 * CallTools dialer USERNAME (display-only — no password travels with it).
 */
const ATTACHED_CACHEABLE_KEYS = ['calltools_username'] as const;

type CacheableHireKey = (typeof CACHEABLE_HIRE_KEYS)[number];
type UncacheableHireKey = (typeof UNCACHEABLE_HIRE_KEYS)[number];
type AttachedHireKey = (typeof ATTACHED_CACHEABLE_KEYS)[number];

/**
 * Compile-time proof that the two lists above **partition** the row's keys.
 *
 * If you added a column to `HrPendingEmployeeRow` and landed here: decide which
 * list it belongs in. A pay figure, a phone number, an address, or anything that
 * says where money goes belongs in `UNCACHEABLE_HIRE_KEYS`.
 */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _keysArePartitioned: AssertEqual<CacheableHireKey | UncacheableHireKey, keyof HrPendingEmployeeRow> = true;
void _keysArePartitioned;

const ALLOWED = new Set<string>([...CACHEABLE_HIRE_KEYS, ...ATTACHED_CACHEABLE_KEYS]);

/** The subset of a hire-row type `R` that may exist in `sessionStorage`. */
export type CachedHireRow<R> = Pick<R, Extract<keyof R, CacheableHireKey | AttachedHireKey>>;

/**
 * Narrow one hire row to the cacheable projection.
 *
 * Generic over the CLIENT row type (`PendingHireRow`, `OrientationHire`), because
 * the JSON a panel receives carries every server column whatever its declared
 * type says. Copies from the allow-list rather than spreading-and-deleting, so a
 * field that is not named here is not copied.
 */
export function toCachedHireRow<R extends object>(row: R): CachedHireRow<R> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined && ALLOWED.has(key)) out[key] = value;
  }
  return out as CachedHireRow<R>;
}

/** Narrow a whole list. */
export function toCachedHireRows<R extends object>(rows: readonly R[]): CachedHireRow<R>[] {
  return rows.map(toCachedHireRow);
}

/** Exported for the test that pins the prohibition from the outside. */
export const __HIRE_CACHE_KEY_LISTS = {
  cacheable: CACHEABLE_HIRE_KEYS,
  uncacheable: UNCACHEABLE_HIRE_KEYS,
  attached: ATTACHED_CACHEABLE_KEYS,
} as const;
