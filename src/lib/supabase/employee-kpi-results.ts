import { createSupabaseServiceRoleClient } from './server';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { HSL_DEPTS, HSL_MANAGERS_BY_EMAIL, type HslDeptKey } from '@/lib/hsl-bonus/schema';

// Employee-facing KPI results.
//
// Surfaces an employee's OWN KPI bonus outcomes once their manager has marked
// the dept-week as ready (or it's been locked/paid). It unifies the two payout
// stores:
//   • bonus_catalog_applied  — non-HSL KPI bonuses (one row per applied bonus)
//   • hsl_bonus_entries      — HSL KPI bonuses (one row per employee per week)
// Both are gated by the same hsl_bonus_period_status table, keyed by
// (department, period_start). A period is shown only when its status row is
// 'ready' or 'locked' — 'draft' (or a missing status row) stays hidden so an
// employee never sees a half-finished score.

const APPLIED = 'bonus_catalog_applied';
const HSL_ENTRIES = 'hsl_bonus_entries';
const STATUS = 'hsl_bonus_period_status';

/** A visible status — drafts are filtered out before this point. */
export type KpiVisibleStatus = 'ready' | 'locked';

/** One contributing line within a period's KPI result. */
export interface KpiResultItem {
  label: string;
  /** PHP payout for this line (catalog bonuses carry an exact per-line amount). */
  amount: number | null;
  /** Metric count behind the line (HSL KPI inputs, e.g. "12 tickets"). */
  value: number | null;
  /** Short hint, e.g. a per-unit rate. */
  detail: string | null;
}

/** One (department, pay-period) KPI result for an employee. */
export interface KpiResultPeriod {
  key: string;
  source: 'catalog' | 'hsl';
  department: string;
  departmentName: string;
  periodType: 'weekly' | 'monthly';
  periodStart: string;
  periodEnd: string;
  status: KpiVisibleStatus;
  /** When the manager last touched the status (ready/locked timestamp). */
  statusAt: string | null;
  statusBy: string | null;
  total: number;
  items: KpiResultItem[];
}

const DEPT_NAME_BY_KEY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const d of DEPARTMENTS) m[d.key] = d.name;
  for (const k of Object.keys(HSL_DEPTS) as HslDeptKey[]) m[k] = HSL_DEPTS[k].name;
  return m;
})();

function deptName(key: string): string {
  return DEPT_NAME_BY_KEY[key] ?? key;
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Humanize a raw kpi_data key (e.g. "five_star_reviews" → "Five Star Reviews"). */
function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Build label + per-unit hint lookups for an HSL department's rules. */
function hslRuleMeta(deptKey: string): Record<string, { label: string; detail: string | null }> {
  const cfg = HSL_DEPTS[deptKey as HslDeptKey];
  const out: Record<string, { label: string; detail: string | null }> = {};
  if (!cfg) return out;
  for (const rule of cfg.rules) {
    if (rule.type === 'per_unit') {
      const cur = rule.currency === 'USD' ? '$' : '₱';
      out[rule.key] = { label: rule.label, detail: `${cur}${rule.rate} each` };
    } else if (rule.type === 'tiered') {
      out[rule.key] = { label: rule.label, detail: 'tiered rate' };
    } else if (rule.type === 'flat') {
      out[rule.key] = { label: rule.label, detail: null };
    } else if (rule.type === 'team_split') {
      out[rule.key] = { label: rule.label, detail: 'team accuracy' };
    }
  }
  return out;
}

type AppliedRow = {
  period_start: string;
  period_end: string;
  department: string;
  bonus_name: string;
  kind: 'flat' | 'formula';
  vars: Record<string, number> | null;
  amount: number | string | null;
};

type HslEntryRow = {
  department: string;
  employee_email: string | null;
  period_type: string | null;
  period_start: string;
  period_end: string | null;
  kpi_data: Record<string, unknown> | null;
  calculated_bonus: number | string | null;
};

type StatusRow = {
  department: string;
  period_type: string | null;
  period_start: string;
  period_end: string | null;
  status: 'draft' | 'ready' | 'locked';
  updated_at: string | null;
  locked_at: string | null;
  locked_by: string | null;
};

/**
 * Fetch every visible (ready/locked) KPI result for the given employee emails.
 * `emails` should already include the work + personal aliases (lowercased).
 * Returns newest period first.
 */
export async function getEmployeeKpiResults(
  emails: string[],
): Promise<{ periods: KpiResultPeriod[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { periods: [], error: 'Supabase client unavailable' };

  const targets = Array.from(
    new Set(emails.map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean)),
  );
  if (targets.length === 0) return { periods: [], error: null };

  const [appliedRes, hslRes] = await Promise.all([
    supabase
      .from(APPLIED)
      .select('period_start, period_end, department, bonus_name, kind, vars, amount')
      .in('employee_email', targets),
    supabase
      .from(HSL_ENTRIES)
      .select('department, employee_email, period_type, period_start, period_end, kpi_data, calculated_bonus')
      .in('employee_email', targets),
  ]);

  if (appliedRes.error) return { periods: [], error: appliedRes.error.message };
  if (hslRes.error) return { periods: [], error: hslRes.error.message };

  const applied = (appliedRes.data ?? []) as AppliedRow[];
  const hsl = (hslRes.data ?? []) as HslEntryRow[];

  if (applied.length === 0 && hsl.length === 0) return { periods: [], error: null };

  // Resolve the status of every (department, period_start) the employee appears in.
  const depts = new Set<string>();
  const starts = new Set<string>();
  for (const r of applied) { depts.add(r.department); starts.add(r.period_start); }
  for (const r of hsl) { depts.add(r.department); starts.add(r.period_start); }

  const statusRes = await supabase
    .from(STATUS)
    .select('department, period_type, period_start, period_end, status, updated_at, locked_at, locked_by')
    .in('department', Array.from(depts))
    .in('period_start', Array.from(starts));
  if (statusRes.error) return { periods: [], error: statusRes.error.message };

  const statusByKey = new Map<string, StatusRow>();
  for (const s of (statusRes.data ?? []) as StatusRow[]) {
    statusByKey.set(`${s.department}::${s.period_start}`, s);
  }

  const visible = (s: StatusRow | undefined): s is StatusRow =>
    !!s && (s.status === 'ready' || s.status === 'locked');

  const periods = new Map<string, KpiResultPeriod>();

  const ensurePeriod = (
    key: string,
    source: 'catalog' | 'hsl',
    department: string,
    periodStart: string,
    periodEnd: string,
    status: StatusRow,
  ): KpiResultPeriod => {
    let p = periods.get(key);
    if (!p) {
      p = {
        key,
        source,
        department,
        departmentName: deptName(department),
        periodType: status.period_type === 'monthly' ? 'monthly' : 'weekly',
        periodStart,
        periodEnd: status.period_end ?? periodEnd,
        status: status.status as KpiVisibleStatus,
        statusAt: status.locked_at ?? status.updated_at ?? null,
        statusBy: status.locked_by ?? null,
        total: 0,
        items: [],
      };
      periods.set(key, p);
    }
    return p;
  };

  // ── Non-HSL catalog bonuses: one exact per-line amount each ─────────────────
  for (const r of applied) {
    const key = `${r.department}::${r.period_start}`;
    const s = statusByKey.get(key);
    if (!visible(s)) continue;
    const p = ensurePeriod(key, 'catalog', r.department, r.period_start, r.period_end, s);
    const amount = num(r.amount);
    p.total += amount;
    const varEntries = r.vars ? Object.entries(r.vars).filter(([, v]) => num(v) !== 0) : [];
    const detail =
      varEntries.length > 0
        ? varEntries.map(([k, v]) => `${humanizeKey(k)}: ${num(v)}`).join(', ')
        : null;
    p.items.push({ label: r.bonus_name, amount, value: null, detail });
  }

  // ── HSL KPI entries: authoritative total + the metrics behind it ────────────
  for (const r of hsl) {
    const key = `${r.department}::${r.period_start}`;
    const s = statusByKey.get(key);
    if (!visible(s)) continue;
    const p = ensurePeriod(key, 'hsl', r.department, r.period_start, r.period_end ?? '', s);
    p.total += num(r.calculated_bonus);
    const data = r.kpi_data ?? {};

    // Managers Weekly (perEmployee): kpi_data holds boolean component ticks and
    // the dept has no uniform rules, so build the breakdown from the manager's
    // own spec — each ticked component is a line carrying its fixed PHP amount.
    if (HSL_DEPTS[r.department as HslDeptKey]?.perEmployee) {
      const spec = HSL_MANAGERS_BY_EMAIL[(r.employee_email ?? '').toLowerCase()];
      for (const c of spec?.components ?? []) {
        if (!data[c.key]) continue;
        p.items.push({
          label: c.label,
          amount: c.amount,
          value: null,
          detail: c.cadence === 'monthly' ? 'monthly' : null,
        });
      }
      continue;
    }

    const meta = hslRuleMeta(r.department);
    for (const [k, raw] of Object.entries(data)) {
      const value = num(raw);
      if (value === 0) continue; // hide untouched metrics
      const m = meta[k];
      p.items.push({
        label: m?.label ?? humanizeKey(k),
        amount: null,
        value,
        detail: m?.detail ?? null,
      });
    }
  }

  const out = Array.from(periods.values());
  // Round each total to cents (sums of numeric(14,2) values stay exact in practice).
  for (const p of out) p.total = Math.round(p.total * 100) / 100;
  out.sort((a, b) =>
    a.periodStart < b.periodStart ? 1 : a.periodStart > b.periodStart ? -1 : a.departmentName.localeCompare(b.departmentName),
  );

  return { periods: out, error: null };
}
