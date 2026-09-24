/**
 * The Payment Catalog's people, as the four fields it actually reads.
 *
 * The catalog used to know its roster ONLY from the server prefetch that ran when
 * `/accounting` first loaded (`initialData.employees`). Its `refetch()` re-read six
 * catalog endpoints and never the roster, so a transfer applied after page load —
 * including one made from the Departments tab's own People step — never moved a
 * headcount until a hard reload. Carla's `hsl:healthcare_specialist` read "0 people"
 * on 2026-09-24 with `aireenp@` already in it (applied 14:18 UTC, `active_employees`
 * correct, not off-board-hidden). `GET /api/payment-catalog/roster` now rides the
 * same refetch.
 *
 * **An explicit projection, never the row.** `EmployeeRow` carries `bankInfo`
 * (account name, number, routing) and `hourlyRate`; passing rows through would put
 * every payee's bank details on the wire and into devtools. Anything the catalog
 * needs must be added here by name — `catalog-roster.test.ts` pins the key set.
 */
import type { EmployeeRow } from '@/lib/supabase/employees';

export type CatalogRosterRow = {
  work_email: string | null;
  personal_email: string | null;
  name: string | null;
  department: string | null;
};

export const CATALOG_ROSTER_FIELDS = ['work_email', 'personal_email', 'name', 'department'] as const;

export function toCatalogRosterRows(rows: readonly EmployeeRow[]): CatalogRosterRow[] {
  return rows.map((r) => ({
    work_email: r.work_email ?? null,
    personal_email: r.personal_email ?? null,
    name: r.name ?? null,
    department: r.department ?? null,
  }));
}

export type CatalogRosterResponse = {
  employees: CatalogRosterRow[];
  /** Same meaning as `InitialAccountingData.catalogOffboardedEmails`: empty hides
   *  nobody, and that is what every degraded evidence read resolves to. */
  catalogOffboardedEmails: string[];
  /** Set only when the ROSTER read failed — the client then keeps what it had. An
   *  off-board evidence failure is NOT an error here: it degrades to "hide nobody",
   *  exactly as the prefetch does, and is reported in `offboardedError`. */
  error: string | null;
  offboardedError: string | null;
};

/**
 * Validate a response body before it replaces the roster on screen. Anything that is
 * not a well-formed success returns null, and the caller KEEPS ITS PRIOR ROSTER —
 * an empty list would read as "everyone left", zeroing every headcount.
 */
export function parseCatalogRosterResponse(
  json: unknown,
): { employees: CatalogRosterRow[]; catalogOffboardedEmails: string[] } | null {
  if (!json || typeof json !== 'object') return null;
  const body = json as Partial<CatalogRosterResponse>;
  if (body.error) return null;
  if (!Array.isArray(body.employees) || !Array.isArray(body.catalogOffboardedEmails)) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const employees: CatalogRosterRow[] = [];
  for (const raw of body.employees) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    employees.push({
      work_email: str(r.work_email),
      personal_email: str(r.personal_email),
      name: str(r.name),
      department: str(r.department),
    });
  }
  // A roster read that succeeded with ZERO people is not a roster — it is a read
  // that lost its rows (anon client, a dropped view). Refuse it, as above.
  if (employees.length === 0) return null;
  const catalogOffboardedEmails = body.catalogOffboardedEmails
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return { employees, catalogOffboardedEmails };
}
