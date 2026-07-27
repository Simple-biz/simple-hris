import { normEmail } from '@/lib/email/norm-email';

// Per-person department overrides — the Sales ⁄ Sales Assistant split.
//
// The Global Master List (Google Sheet) labels BOTH sales cohorts "Sales":
// the US sales team AND the PH sales assistants share one Department cell
// value. The business treats them as two different departments (Kane,
// 2026-07-27): US people are **Sales** (new payroll key `sales`), PH people
// are **Sales Assistant** (the existing `sales_assistant` key, which keeps
// the ₱150-per-sale KPI bonus).
//
// The sheet can't express the split without relabelling rows (and re-syncs
// would keep re-importing whatever the sheet says), so membership is pinned
// HERE, in code, keyed on email: anyone below whose master-list label is the
// ambiguous "Sales" is re-read as "Sales Assistant" at roster-load time.
// Everyone else labelled "Sales" (the US team, plus any future hire) resolves
// to the new Sales department via normalizeDeptToKey('sales') → 'sales'.
//
// Scope rules, deliberately narrow:
//   • The override ONLY disambiguates the label "Sales". A person transferred
//     to another department (sheet label changes to "HR", "Edit Team", …)
//     keeps that new label untouched — the override never fights a transfer.
//   • If the sheet is ever relabelled to "Sales Assistant" directly, the
//     override becomes a harmless no-op for that row (label already right).
//   • To MOVE someone between the two sales cohorts: add or remove their
//     email here (one-line change) — do not edit the sheet label, it would
//     be re-synced anyway.
//
// This module is client-safe (pure data + string logic, no Supabase).

/** Canonical label the PH cohort re-reads as. Must stay in sync with the
 *  master-list synonym map: normalizeDeptToKey('sales assistant') → 'sales_assistant'. */
export const SALES_ASSISTANT_LABEL = 'Sales Assistant';

/** The ambiguous sheet label shared by both cohorts (compared lowercased). */
const AMBIGUOUS_SALES_LABEL = 'sales';

/**
 * PH Sales Assistant cohort (Kane's list, 2026-07-27). Master sheet says
 * "Sales" for all of them; they belong to Sales Assistant.
 */
export const SALES_ASSISTANT_OVERRIDE_EMAILS: ReadonlySet<string> = new Set([
  'aleighshaa@simple.biz', // Alviz, Aleighsha
  'mar@simple.biz',        // Castillo, Marionne
  'vine@simple.biz',       // Evangelista, Chaelvin Aron
  'markf@simple.biz',      // Florentino, Mark
  'deanm@simple.biz',      // Maniquiz, Dean Kevin
  'debm@simple.biz',       // Maniquiz, Debraleen
  'heartm@simple.biz',     // Morales, Katherine Heart
  'gladysp@simple.biz',    // Parreno, Gladys
  'jcr@simple.biz',        // Rosales, Jolly
  'larat@simple.biz',      // Trinidad Co, Lara Mae
]);

/**
 * Effective department label for a person: rewrites the ambiguous "Sales"
 * label to "Sales Assistant" when ANY of the person's emails is on the PH
 * override list. Any other label — including null — passes through untouched.
 */
export function overrideDeptLabel(
  label: string | null | undefined,
  ...emails: (string | null | undefined)[]
): string | null {
  const raw = label ?? null;
  if (!raw || raw.trim().toLowerCase() !== AMBIGUOUS_SALES_LABEL) return raw;
  for (const e of emails) {
    const norm = normEmail(e ?? '');
    if (norm && SALES_ASSISTANT_OVERRIDE_EMAILS.has(norm)) return SALES_ASSISTANT_LABEL;
  }
  return raw;
}

/**
 * Same override for a raw PostgREST row (quoted-column shape:
 * `Department` / `Work Email` / `Personal Email` / alternates). Returns the
 * row unchanged unless the override applies — callers can map over pages
 * without re-allocating untouched rows.
 */
export function applyDeptOverrideToRawRow<T extends Record<string, unknown>>(row: T): T {
  const dept = typeof row['Department'] === 'string' ? (row['Department'] as string) : null;
  const effective = overrideDeptLabel(
    dept,
    row['Work Email'] as string | null | undefined,
    row['Personal Email'] as string | null | undefined,
    row['Alternate Work Email'] as string | null | undefined,
    row['Alternate Work Email 2'] as string | null | undefined,
  );
  if (effective === dept) return row;
  return { ...row, Department: effective };
}
