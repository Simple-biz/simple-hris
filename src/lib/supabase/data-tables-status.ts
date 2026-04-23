import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export type CoreTableId = 'global_master_list' | 'employee_hourly_rates' | 'hubstaff_hours';

export type CoreTableStatus = {
  id: CoreTableId;
  label: string;
  tableName: string;
  rowCount: number | null;
  error: string | null;
  status: 'ok' | 'warn' | 'error';
  detail: string;
};

function resolvedTableNames() {
  return {
    global_master_list:
      process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || 'global_master_list',
    employee_hourly_rates:
      process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates',
    hubstaff_hours:
      process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || 'hubstaff_hours',
  } as const;
}

async function countRows(
  supabase: SupabaseClient,
  table: string,
): Promise<{ count: number | null; error: string | null }> {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) return { count: null, error: error.message };
  return { count: count ?? 0, error: null };
}

async function countGlobalMasterActiveRows(
  supabase: SupabaseClient,
  _table: string,
): Promise<{ count: number | null; error: string | null }> {
  // `active_employees` view is the source of truth for "active" count (filters
  // global_master_list down to rows from the current master_list_uploads row).
  const { count, error } = await supabase
    .from('active_employees')
    .select('*', { count: 'exact', head: true });
  if (error) return { count: null, error: error.message };
  return { count: count ?? 0, error: null };
}

function baseDetail(id: CoreTableId, n: number): { status: CoreTableStatus['status']; detail: string } {
  const fmt = n.toLocaleString();
  if (id === 'hubstaff_hours' && n === 0) {
    return {
      status: 'warn',
      detail: '0 rows · upload a Hubstaff weekly CSV in Payroll Wizard',
    };
  }
  if (id === 'global_master_list' && n === 0) {
    return {
      status: 'warn',
      detail: '0 rows · upload a Global Master List CSV from Admin → Overview',
    };
  }
  if (id === 'employee_hourly_rates' && n === 0) {
    return { status: 'warn', detail: '0 rows · no hourly rates yet' };
  }
  return { status: 'ok', detail: `${fmt} rows in ${id === 'hubstaff_hours' ? 'timesheet' : 'table'}` };
}

function toRow(
  id: CoreTableId,
  label: string,
  tableName: string,
  r: { count: number | null; error: string | null },
): CoreTableStatus {
  if (r.error) {
    return {
      id,
      label,
      tableName,
      rowCount: null,
      error: r.error,
      status: 'error',
      detail: r.error,
    };
  }
  const n = r.count ?? 0;
  const { status, detail } = baseDetail(id, n);
  return { id, label, tableName, rowCount: n, error: null, status, detail };
}

/**
 * Lightweight row counts for the three core payroll tables (single HEAD count per table).
 * Prefers service role when set so RLS does not hide totals from the admin overview.
 */
export async function getCoreDataTablesStatus(): Promise<{
  tables: CoreTableStatus[];
  hints: string[];
  usedServiceRole: boolean;
}> {
  const names = resolvedTableNames();
  const service = createSupabaseServiceRoleClient();
  const anon = createSupabaseServerClient();
  const supabase = service ?? anon;
  const usedServiceRole = Boolean(service);

  if (!supabase) {
    const missing = 'Supabase client unavailable (check NEXT_PUBLIC_SUPABASE_URL and keys).';
    return {
      tables: [
        {
          id: 'global_master_list',
          label: 'Global Master List',
          tableName: names.global_master_list,
          rowCount: null,
          error: missing,
          status: 'error',
          detail: missing,
        },
        {
          id: 'employee_hourly_rates',
          label: 'Employee Hourly Rates',
          tableName: names.employee_hourly_rates,
          rowCount: null,
          error: missing,
          status: 'error',
          detail: missing,
        },
        {
          id: 'hubstaff_hours',
          label: 'Hubstaff Hours',
          tableName: names.hubstaff_hours,
          rowCount: null,
          error: missing,
          status: 'error',
          detail: missing,
        },
      ],
      hints: [missing],
      usedServiceRole: false,
    };
  }

  const [gmlR, ratesR, hubR] = await Promise.all([
    countGlobalMasterActiveRows(supabase, names.global_master_list),
    countRows(supabase, names.employee_hourly_rates),
    countRows(supabase, names.hubstaff_hours),
  ]);

  const tables: CoreTableStatus[] = [
    toRow('global_master_list', 'Global Master List', names.global_master_list, gmlR),
    toRow('employee_hourly_rates', 'Employee Hourly Rates', names.employee_hourly_rates, ratesR),
    toRow('hubstaff_hours', 'Hubstaff Hours', names.hubstaff_hours, hubR),
  ];

  const gmlN = tables[0].rowCount;
  const ratesN = tables[1].rowCount;
  if (
    tables[0].status !== 'error' &&
    tables[1].status !== 'error' &&
    gmlN != null &&
    ratesN != null &&
    ratesN < gmlN
  ) {
    tables[1] = {
      ...tables[1],
      status: 'warn',
      detail: `${ratesN.toLocaleString()} rows · ${(gmlN - ratesN).toLocaleString()} fewer than directory`,
    };
  }

  const hints: string[] = [];
  if (
    tables[0].status !== 'error' &&
    tables[1].status !== 'error' &&
    gmlN != null &&
    ratesN != null &&
    ratesN < gmlN
  ) {
    hints.push(
      'Employee hourly rates has fewer rows than Global Master List — add or sync rates for every employee.',
    );
  }
  if (tables[2].rowCount === 0 && tables[2].status !== 'error') {
    hints.push('Hubstaff hours is empty — import a weekly report before running payroll.');
  }
  if (!usedServiceRole) {
    hints.push(
      'Using the anon key for counts; if any table shows an error, set SUPABASE_SERVICE_ROLE_KEY for full visibility under RLS.',
    );
  }

  return { tables, hints, usedServiceRole };
}
