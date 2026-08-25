import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { isHslFamilyLabel } from '@/lib/departments/hsl-subdept';
import { normEmail } from '@/lib/email/norm-email';
import {
  buildTransferLegsByEmail,
  type DepartmentTransferLegRaw,
} from '@/lib/payroll/department-transfer-legs';

/**
 * Effective dates of department transfers INTO HSL, keyed by employee email —
 * the data behind the day-scoped Weekend Hours rule (`resolveHslWeekScope`):
 * a transfer applies its dept label immediately on release, but the +₱15/h
 * Sat/Sun premium + weekend itemization follow the transfer's EFFECTIVE date.
 *
 * Consumed by BOTH engines: `computeCurrentPay` (server) fetches directly via
 * {@link fetchHslTransferEffectiveByEmail}; the Payroll Wizard loads the same
 * map through GET /api/payroll/hsl-transfers-bulk.
 */

/** The subset of a `department_transfer_requests` row the map needs. */
export interface HslTransferRowLike {
  employee_email: string | null;
  employee_work_email: string | null;
  from_department: string | null;
  to_department: string | null;
  effective_date: string | null;
  status: string | null;
}

/**
 * PURE builder: rows → Map<lowercased email, latest into-HSL effective date
 * (YYYY-MM-DD)>. Only `applied`/`approved` rows whose target normalizes to
 * hogan_smith_law count (covers 'HSL', 'hsl:intake_specialist', 'Hogan Smith
 * Law', …). When a person has several, the LATEST effective date wins — that
 * is the transfer their current HSL label came from.
 *
 * Moves that STARTED inside the HSL family are skipped entirely: a sub-team
 * reshuffle or a plain-HSL → `hsl:<sub>` relabel is not an entry into HSL, and
 * counting one reset a long-tenured person's weekend-premium day-scoping to the
 * relabel date. (Five people were relabeled HSL → hsl:case_managers in July
 * 2026; the map read them as brand-new HSL arrivals that week.)
 */
export function buildHslTransferEffectiveMap(rows: HslTransferRowLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const status = (r.status ?? '').trim().toLowerCase();
    if (status !== 'applied' && status !== 'approved') continue;
    if (normalizeDeptToKey(r.to_department ?? '') !== 'hogan_smith_law') continue;
    if (isHslFamilyLabel(r.from_department)) continue;
    const eff = (r.effective_date ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) continue;
    for (const raw of [r.employee_email, r.employee_work_email]) {
      const em = raw ? normEmail(raw) : null;
      if (!em) continue;
      const prev = out.get(em);
      if (!prev || eff > prev) out.set(em, eff);
    }
  }
  return out;
}

/**
 * The ONE paginated read of `department_transfer_requests` both transfer maps
 * derive from — the into-HSL effective dates (which day-scope the weekend
 * premium) and the paystub's mid-week transfer disclosure
 * ({@link buildTransferLegsByEmail}). Sharing the read means the two can never
 * be built from different snapshots of the table.
 *
 * Paginated — never trust the 1000-row default cap (PostgREST truncates even
 * with `.range()`).
 */
export async function fetchDepartmentTransferRows(): Promise<HslTransferRowLike[]> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return [];

  const PAGE = 1000;
  const all: HslTransferRowLike[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('department_transfer_requests')
      .select('employee_email, employee_work_email, from_department, to_department, effective_date, status')
      .in('status', ['applied', 'approved'])
      .range(from, from + PAGE - 1);
    if (error || !data) break;
    all.push(...(data as HslTransferRowLike[]));
    if (data.length < PAGE) break;
  }
  return all;
}

/** Fetch + build the map (paginated — never trust the 1000-row default cap). */
export async function fetchHslTransferEffectiveByEmail(): Promise<Map<string, string>> {
  return buildHslTransferEffectiveMap(await fetchDepartmentTransferRows());
}

/**
 * Fetch + build the paystub disclosure map: every applied/approved move a
 * person has, keyed by email. The caller narrows it to the pay week
 * (`transferLegsInWeek`) — a full-history map is what lets a REPLAY of an old
 * week disclose the transfer that week actually carried.
 */
export async function fetchTransferLegsByEmail(): Promise<Map<string, DepartmentTransferLegRaw[]>> {
  return buildTransferLegsByEmail(await fetchDepartmentTransferRows());
}
