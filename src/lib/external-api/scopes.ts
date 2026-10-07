/**
 * The scopes an external key may hold — one per dataset a route serves.
 *
 * Each one is enumerated three times and the three must agree:
 *   1. here (what the admin routes accept and the gate checks),
 *   2. the SQL CHECK `external_api_clients_scopes_known` (the control outside the repo —
 *      `references/sql/alter/2026-10-07_external_api_offboarded_scope.sql`),
 *   3. the Data catalog's live datasets (`datasets.ts`).
 * `scopes.test.ts` and `datasets.test.ts` pin 1 = 2 = 3. Adding a scope means a new SQL
 * ALTER that re-ENUMERATES the CHECK (never a pattern), a route that honours it, an MCP
 * tool, and the catalog page moving to live.
 *
 * Pure: the admin panel imports it.
 */

export const GML_SCOPE = 'global_master_list.read';
/** The leavers ledger (`offboarded_sheet`). Added 2026-10-07. */
export const OFFBOARDED_SCOPE = 'offboarded.read';

/** Every scope, in picker order. */
export const EXTERNAL_SCOPES = [GML_SCOPE, OFFBOARDED_SCOPE] as const;
export type ExternalScope = (typeof EXTERNAL_SCOPES)[number];

export const SCOPE_LABELS: Record<ExternalScope, string> = {
  [GML_SCOPE]: 'Global Master List',
  [OFFBOARDED_SCOPE]: 'Offboarded',
};

export const SCOPE_DESCRIPTIONS: Record<ExternalScope, string> = {
  [GML_SCOPE]: 'The active roster. You choose which columns.',
  [OFFBOARDED_SCOPE]: 'Who left, when, from which department, and the reason category. Fixed fields; no personal contact.',
};

/**
 * The database refused a scope the code knows: `external_api_clients_scopes_known` has not
 * been widened yet (the 2026-10-07 ALTER is not applied). The admin routes answer 503 with
 * this, never a bare 500.
 */
export const SCOPE_MIGRATION_PENDING =
  'The database does not accept the Offboarded dataset yet — run scripts/Apply External API offboarded scope migration.cmd, then try again.';

/** What a new client holds when the admin changes nothing: the roster only. Leavers are opt-in. */
export const DEFAULT_SCOPES: readonly ExternalScope[] = [GML_SCOPE];

export function isExternalScope(v: unknown): v is ExternalScope {
  return typeof v === 'string' && (EXTERNAL_SCOPES as readonly string[]).includes(v);
}

export type ScopesParse = { ok: true; scopes: ExternalScope[] } | { ok: false; error: string };

/**
 * An admin's (or a stored row's) scope list → the canonical list, in `EXTERNAL_SCOPES`
 * order, deduplicated. An unknown name is NAMED in the error, never dropped — a dropped
 * name would make the admin believe a key holds a dataset it does not, or the reverse.
 * An empty list is refused: a key that can read nothing is a mistake, and the SQL CHECK
 * refuses it too.
 */
export function normalizeScopes(input: unknown): ScopesParse {
  if (!Array.isArray(input)) return { ok: false, error: 'scopes must be a list of datasets' };
  const bad: string[] = [];
  const seen = new Set<ExternalScope>();
  for (const raw of input) {
    const s = typeof raw === 'string' ? raw.trim() : raw;
    if (isExternalScope(s)) seen.add(s);
    else bad.push(String(raw));
  }
  if (bad.length) return { ok: false, error: `Not a dataset this API serves: ${bad.join(', ')}` };
  if (seen.size === 0) return { ok: false, error: 'Pick at least one dataset' };
  return { ok: true, scopes: EXTERNAL_SCOPES.filter((s) => seen.has(s)) };
}

/** Does a stored row hold this scope? A non-array is "holds nothing" — never "holds everything". */
export function holdsScope(scopes: unknown, scope: ExternalScope): boolean {
  return Array.isArray(scopes) && scopes.includes(scope);
}
