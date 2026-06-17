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
};

const ACCOUNTING_ROLES = new Set([
  'payroll_coordinator',
  'payroll_manager',
  'finance',
  'hr_coordinator',
  'viewer',
  'admin',
]);

export function hasAccountingRole(roles: string[]): boolean {
  return roles.some((r) => ACCOUNTING_ROLES.has(r));
}

export async function prefetchAccountingData(): Promise<InitialAccountingData> {
  const [employeesResult, ratesResult, uploadsResult, systemBonusesResult] = await Promise.all([
    getEmployees().catch(() => ({ employees: [] as EmployeeRow[], error: null })),
    getEmployeeHourlyRatesRows().catch(() => ({ rows: [] as EmployeeHourlyRateRow[], error: null })),
    listHubstaffUploads().catch(() => [] as Awaited<ReturnType<typeof listHubstaffUploads>>),
    listSystemBonuses().catch(() => ({ bonuses: [] as SystemBonus[], error: null })),
  ]);

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
  };
}
