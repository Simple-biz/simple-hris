/** [TERMINATION-DOCS]
 * `reasonKey` and the departure ALLOWLIST.
 *
 * Byte-identical reimplementation of the module-PRIVATE originals at
 * src/lib/payment-catalog/catalog-roster-visibility.ts:74 (DEPARTURE_REASONS)
 * and :80 (reasonKey). Verified private: neither is exported.
 * DO NOT invent a different normalizer — `off_boarded_reason` is free text with
 * NO CHECK constraint and holds both casings of every enum plus sheet-authored
 * labels (`Policy Violation`, `Declined Offer`, `Agent Passed Away`, `Active`)
 * and synthetic non-departures (`duplicate_cleanup` 94 rows, `sheet_sync` 2).
 * An ALLOWLIST is required by ruling; a denylist is forbidden.
 */
import { TERMINATION_DEPARTURE_REASONS } from './types';

export const TERMINATION_DEPARTURE_REASON_SET: ReadonlySet<string> = new Set(
  TERMINATION_DEPARTURE_REASONS,
);

export function reasonKey(raw: string | null | undefined): string | null {
  const k = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return k || null;
}

/** LIKE-escape for `.ilike()`. `_` is legal in an email local-part and ILIKE
 *  treats it as a single-char wildcard, so `a_b@x.com` can match `axb@x.com` —
 *  a DIFFERENT person. Copy of the private escaper at
 *  src/lib/supabase/hr-pending-employees.ts:714 (verified: not exported). */
export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}
