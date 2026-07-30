import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { normEmail } from '@/lib/email/norm-email';

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
 */
export function buildHslTransferEffectiveMap(rows: HslTransferRowLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const status = (r.status ?? '').trim().toLowerCase();
    if (status !== 'applied' && status !== 'approved') continue;
    if (normalizeDeptToKey(r.to_department ?? '') !== 'hogan_smith_law') continue;
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

/** Fetch + build the map (paginated — never trust the 1000-row default cap). */
export async function fetchHslTransferEffectiveByEmail(): Promise<Map<string, string>> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return new Map();

  const PAGE = 1000;
  const all: HslTransferRowLike[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('department_transfer_requests')
      .select('employee_email, employee_work_email, to_department, effective_date, status')
      .in('status', ['applied', 'approved'])
      .range(from, from + PAGE - 1);
    if (error || !data) break;
    all.push(...(data as HslTransferRowLike[]));
    if (data.length < PAGE) break;
  }
  return buildHslTransferEffectiveMap(all);
}
