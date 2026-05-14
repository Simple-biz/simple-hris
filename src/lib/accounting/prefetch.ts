import { getEmployees, type EmployeeRow } from '@/lib/supabase/employees';
import {
  getEmployeeHourlyRatesRows,
  type EmployeeHourlyRateRow,
} from '@/lib/supabase/employee-hourly-rates';
import {
  listHubstaffUploads,
  getUploadedSourceFiles,
} from '@/lib/supabase/hubstaff-hours-db';

export type InitialAccountingData = {
  employees: EmployeeRow[];
  hourlyRates: EmployeeHourlyRateRow[];
  sourceFiles: string[];
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
  const [employeesResult, ratesResult, uploadsResult] = await Promise.all([
    getEmployees().catch(() => ({ employees: [] as EmployeeRow[], error: null })),
    getEmployeeHourlyRatesRows().catch(() => ({ rows: [] as EmployeeHourlyRateRow[], error: null })),
    listHubstaffUploads().catch(() => [] as Awaited<ReturnType<typeof listHubstaffUploads>>),
  ]);

  let sourceFiles: string[];
  if (uploadsResult.length > 0) {
    const seen = new Set<string>();
    sourceFiles = [];
    for (const u of uploadsResult) {
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
  };
}
