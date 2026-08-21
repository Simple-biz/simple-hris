import { getEmployees, type EmployeeRow } from '@/lib/supabase/employees';
import {
  getEmployeeHourlyRatesRows,
  type EmployeeHourlyRateRow,
} from '@/lib/supabase/employee-hourly-rates';
import {
  listHubstaffUploads,
  getUploadedSourceFiles,
} from '@/lib/supabase/hubstaff-hours-db';
import { listSystemBonuses } from '@/lib/supabase/system-bonuses-db';
import type { SystemBonus } from '@/lib/payment-catalog/system-bonus';
import { getDepartmentRegistry } from '@/lib/departments/registry-db';
import type { DepartmentRegistryEntry } from '@/lib/departments/registry';
import { loadCatalogOffboardedEmails } from '@/lib/payment-catalog/catalog-offboarded-emails';

export type HubstaffUploadMeta = {
  id: string;
  source_file: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
  row_count: number | null;
  is_current: boolean;
};

export type InitialAccountingData = {
  employees: EmployeeRow[];
  hourlyRates: EmployeeHourlyRateRow[];
  sourceFiles: string[];
  /** Rich uploads list. Same shape PayrollWizard consumes via /api/hubstaff-hours?source_files=1. */
  hubstaffUploads: HubstaffUploadMeta[];
  /** Editable PAB + Tech bonus rows (Payment Catalog System Bonuses tab). */
  systemBonuses: SystemBonus[];
  /** In-app Payment Catalog departments. Needed wherever a department label is
   *  turned into a KEY for system-bonus eligibility: `normalizeDeptToKey` knows
   *  only the built-ins, returns null for a custom department, and
   *  `isDeptEligible` fail-opens on null — so without this a custom department
   *  reads as eligible for PAB/Tech that its allowlist deliberately omits.
   *  Carried on the prefetch (rather than fetched client-side) because the
   *  registry endpoint is gated by `requireRateVisibilitySession`. */
  departmentRegistry: DepartmentRegistryEntry[];
  /** Normalized emails of people on `employees` who have LEFT — the Payment
   *  Catalog drops them from its search, pickers, headcounts and spend estimate.
   *  `active_employees` cannot answer this on its own (HR keeps a leaver on the
   *  master sheet through final pay, and the stamp lands on a duplicate row), so
   *  it is resolved server-side from the off-board evidence tables plus the
   *  cycle's timesheet — see `loadCatalogOffboardedEmails`. Empty means "hide
   *  nobody", which is also what every read failure degrades to. Only the
   *  Payment Catalog consumes it; `employees` itself is untouched. */
  catalogOffboardedEmails: string[];
};

// `hr_coordinator` was decoupled from Accounting on 2026-06-22 — HR coordinators
// keep the HR dashboard but no longer prefetch/see the Accounting view.
const ACCOUNTING_ROLES = new Set([
  'accounting',
  'admin',
]);

export function hasAccountingRole(roles: string[]): boolean {
  return roles.some((r) => ACCOUNTING_ROLES.has(r));
}

export async function prefetchAccountingData(): Promise<InitialAccountingData> {
  const [employeesResult, ratesResult, uploadsResult, systemBonusesResult, registryResult] =
    await Promise.all([
      getEmployees().catch(() => ({ employees: [] as EmployeeRow[], error: null })),
      getEmployeeHourlyRatesRows().catch(() => ({ rows: [] as EmployeeHourlyRateRow[], error: null })),
      listHubstaffUploads().catch(() => [] as Awaited<ReturnType<typeof listHubstaffUploads>>),
      listSystemBonuses().catch(() => ({ bonuses: [] as SystemBonus[], error: null })),
      // Best-effort, like every other registry read: a failure degrades to the
      // built-in-only resolution that shipped before this, never to worse.
      getDepartmentRegistry().catch(() => [] as DepartmentRegistryEntry[]),
    ]);

  // Needs the roster, so it runs after the batch above rather than inside it.
  // Best-effort in the same spirit: an empty set hides nobody.
  const catalogOffboarded = await loadCatalogOffboardedEmails(
    employeesResult.employees ?? [],
  ).catch(() => ({ emails: [] as string[], error: null }));

  // Accounting surfaces (Payroll Wizard + Overview) follow the Initialized batch:
  // put the is_current upload first so `sourceFiles[0]` is the active payroll week.
  // (The public endpoint stays newest-first, so employee/manager dashboards are
  // unaffected and always show the latest upload.)
  const orderedUploads = [...uploadsResult].sort(
    (a, b) => Number(b.is_current) - Number(a.is_current),
  );

  let sourceFiles: string[];
  if (orderedUploads.length > 0) {
    const seen = new Set<string>();
    sourceFiles = [];
    for (const u of orderedUploads) {
      const f = (u.source_file ?? '').trim();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      sourceFiles.push(f);
    }
  } else {
    sourceFiles = await getUploadedSourceFiles().catch(() => []);
  }

  return {
    employees: employeesResult.employees ?? [],
    hourlyRates: ratesResult.rows ?? [],
    sourceFiles,
    hubstaffUploads: orderedUploads,
    systemBonuses: systemBonusesResult.bonuses ?? [],
    departmentRegistry: registryResult ?? [],
    catalogOffboardedEmails: catalogOffboarded.emails,
  };
}
