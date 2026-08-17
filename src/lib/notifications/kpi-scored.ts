import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { normEmail } from '@/lib/email/norm-email';
import { formatWeekHuman } from '@/lib/payroll/paystub-view';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { HSL_DEPTS, formatPeso, type HslDeptKey } from '@/lib/hsl-bonus/schema';

// "KPI scored" employee notification (`kpi.scored`).
//
// Fired (best-effort) whenever a change an employee is allowed to SEE lands on
// their KPI bonus for a dept-week:
//   1. The manager submits the week — hsl_bonus_period_status flips into
//      'ready'/'locked' (POST /api/hsl-bonus/period-status).
//   2. A bonus write lands on an ALREADY ready/locked week (POST
//      /api/bonus-catalog-applied, POST /api/hsl-bonus/entries) — e.g. a
//      disputed bonus is re-ordered after publication.
//
// The core rule is CHANGE DETECTION, not call-site discipline: every call
// recomputes each employee's visible total for the week and inserts a
// notification only where that total differs from the amount carried by their
// last kpi.scored notification for the same (department, period_start). That
// makes the helper safe to call from the autosave-backed bonus routes — an
// autosave that changes nothing the employee can see inserts nothing — and it
// makes drafts structurally silent: a week whose status row is missing or
// 'draft' returns before reading a single bonus row, mirroring the visibility
// gate in employee-kpi-results.ts (employees never see half-finished scores).
//
// Kane's ruling (2026-08-17): corrections must RE-notify. A dispute leads to a
// new/changed bonus on a published week and the employee must learn the number
// moved — so the de-dupe key is the AMOUNT, never "already notified once".
//
// Recipient resolution mirrors payroll-available.ts: bonus rows are keyed on
// whatever email the scoring surface used (sometimes a personal/alternate
// address), while GET /api/employee-notifications matches recipient_email
// exactly against the login email — so raw emails are reverse-aliased to the
// canonical Work Email via the Global Master List (paged; the roster passed
// 1,000 people). Totals for two aliases of one person merge by summing, the
// same union employee-kpi-results.ts produces.

const APPLIED = 'bonus_catalog_applied';
const HSL_ENTRIES = 'hsl_bonus_entries';
const STATUS = 'hsl_bonus_period_status';
export const KPI_SCORED_TYPE = 'kpi.scored';

const DEPT_NAME_BY_KEY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const d of DEPARTMENTS) m[d.key] = d.name;
  for (const k of Object.keys(HSL_DEPTS) as HslDeptKey[]) m[k] = HSL_DEPTS[k].name;
  return m;
})();

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Round to cents — totals are compared and stored at cent precision so a
 *  float-noise difference never reads as "the bonus changed". */
function cents(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Per-email totals for one dept-week: catalog bonus amounts plus HSL entry
 * calculated_bonus, keyed by the RAW (normalized) email on the row. Pure.
 */
export function sumKpiTotalsByEmail(
  applied: Array<{ employee_email?: string | null; amount?: number | string | null }>,
  hslEntries: Array<{ employee_email?: string | null; calculated_bonus?: number | string | null }>,
): Map<string, number> {
  const totals = new Map<string, number>();
  const add = (email: string | null | undefined, amount: number) => {
    const e = normEmail(email ?? null);
    if (!e) return;
    totals.set(e, (totals.get(e) ?? 0) + amount);
  };
  for (const r of applied) add(r.employee_email, num(r.amount));
  for (const r of hslEntries) add(r.employee_email, num(r.calculated_bonus));
  for (const [k, v] of totals) totals.set(k, cents(v));
  return totals;
}

export interface KpiScoredPlanItem {
  recipientEmail: string;
  amount: number;
  /** null = first notification for this (person, dept, week). */
  previousAmount: number | null;
}

/**
 * Decide who gets a notification. Pure — this is the whole re-notify policy:
 *   - no prior notification and a zero total → nothing (never announce ₱0)
 *   - prior amount equals the new total     → nothing (autosaved no-op)
 *   - anything else                         → notify, carrying previousAmount
 * A total that DROPS (bonus removed on a published week) still notifies: the
 * employee's KPI Results tab already shows the new number, and a silent drop
 * is exactly the surprise this feature exists to prevent.
 */
export function planKpiScoredInserts(
  totalsByLogin: Map<string, number>,
  lastNotifiedByLogin: Map<string, number>,
): KpiScoredPlanItem[] {
  const out: KpiScoredPlanItem[] = [];
  const seen = new Set<string>();
  for (const [email, rawTotal] of totalsByLogin) {
    seen.add(email);
    const amount = cents(rawTotal);
    const prev = lastNotifiedByLogin.has(email) ? cents(lastNotifiedByLogin.get(email)!) : null;
    if (prev === null && amount === 0) continue;
    if (prev !== null && prev === amount) continue;
    out.push({ recipientEmail: email, amount, previousAmount: prev });
  }
  // Someone previously notified whose rows vanished entirely (set-replace
  // removed every bonus): their new total is 0, not "absent" — tell them.
  for (const [email, prev] of lastNotifiedByLogin) {
    if (seen.has(email)) continue;
    const p = cents(prev);
    if (p === 0) continue;
    out.push({ recipientEmail: email, amount: 0, previousAmount: p });
  }
  return out;
}

/**
 * Recompute the dept-week's visible totals and notify everyone whose amount
 * changed. Throws on DB errors — call sites wrap in try/catch so a notify
 * failure never fails the save that triggered it. Returns zeros without
 * touching bonus tables when the week isn't ready/locked.
 */
export async function notifyKpiScored(opts: {
  department: string;
  periodStart: string;
}): Promise<{ inserted: number; skipped: number }> {
  const zero = { inserted: 0, skipped: 0 };
  const department = opts.department?.trim();
  const periodStart = opts.periodStart?.trim();
  if (!department || !periodStart) return zero;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return zero;

  // ── 1. Visibility gate: drafts (and missing status rows) are silent ────────
  const statusRes = await supabase
    .from(STATUS)
    .select('status, period_end')
    .eq('department', department)
    .eq('period_start', periodStart)
    .maybeSingle();
  if (statusRes.error) throw new Error(statusRes.error.message);
  const status = statusRes.data?.status as string | undefined;
  if (status !== 'ready' && status !== 'locked') return zero;
  const periodEnd = (statusRes.data?.period_end as string | null) ?? null;

  // ── 2. This dept-week's bonus rows (paged — busy weeks pass 1,000 rows) ────
  const [appliedRows, hslRows] = await Promise.all([
    selectAllPaged<{ employee_email: string | null; amount: number | string | null }>((from, to) =>
      supabase
        .from(APPLIED)
        .select('employee_email, amount')
        .eq('department', department)
        .eq('period_start', periodStart)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    selectAllPaged<{ employee_email: string | null; calculated_bonus: number | string | null }>(
      (from, to) =>
        supabase
          .from(HSL_ENTRIES)
          .select('employee_email, calculated_bonus')
          .eq('department', department)
          .eq('period_start', periodStart)
          .order('id', { ascending: true })
          .range(from, to),
    ),
  ]);
  if (appliedRows.error) throw new Error(appliedRows.error);
  if (hslRows.error) throw new Error(hslRows.error);

  const rawTotals = sumKpiTotalsByEmail(appliedRows.rows, hslRows.rows);

  // ── 3. Reverse alias map → canonical login (payroll-available.ts pattern) ──
  const aliasToLogin = new Map<string, string>();
  {
    const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
      supabase
        .from('active_employees')
        .select('"Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2"')
        .order('Work Email', { ascending: true })
        .range(from, to),
    );
    if (error) throw new Error(error);
    for (const raw of rows) {
      const work = normEmail(typeof raw['Work Email'] === 'string' ? (raw['Work Email'] as string) : null);
      const personal = normEmail(
        typeof raw['Personal Email'] === 'string' ? (raw['Personal Email'] as string) : null,
      );
      const login = work ?? personal;
      if (!login) continue;
      const all = [
        raw['Work Email'],
        raw['Personal Email'],
        raw['Alternate Work Email'],
        raw['Alternate Work Email 2'],
      ]
        .map((v) => (typeof v === 'string' ? normEmail(v) : null))
        .filter((v): v is string => !!v);
      for (const e of all) {
        // First writer wins so a shared/duplicate address doesn't flap between people.
        if (!aliasToLogin.has(e)) aliasToLogin.set(e, login);
      }
    }
  }

  let skipped = 0;
  const totalsByLogin = new Map<string, number>();
  for (const [rawEmail, total] of rawTotals) {
    const login = aliasToLogin.get(rawEmail);
    if (!login) {
      skipped += 1; // off-roster row (leaver / agency) — no login to notify
      continue;
    }
    totalsByLogin.set(login, cents((totalsByLogin.get(login) ?? 0) + total));
  }
  if (totalsByLogin.size === 0) return { inserted: 0, skipped };

  // ── 4. Last notified amount per recipient for THIS dept-week ───────────────
  const lastNotified = new Map<string, number>();
  {
    const { rows, error } = await selectAllPaged<{
      recipient_email: string | null;
      created_at: string | null;
      details: { amount?: unknown } | null;
    }>((from, to) =>
      supabase
        .from('employee_notifications')
        .select('recipient_email, created_at, details')
        .eq('type', KPI_SCORED_TYPE)
        .eq('details->>department', department)
        .eq('details->>period_start', periodStart)
        .order('created_at', { ascending: true })
        .range(from, to),
    );
    if (error) throw new Error(error);
    // Ascending order → the map ends up holding each recipient's LATEST amount.
    for (const r of rows) {
      const e = normEmail(r.recipient_email ?? null);
      if (!e) continue;
      lastNotified.set(e, num(r.details?.amount));
    }
  }

  const plan = planKpiScoredInserts(totalsByLogin, lastNotified);
  if (plan.length === 0) return { inserted: 0, skipped };

  // ── 5. Build + bulk-insert ──────────────────────────────────────────────────
  const departmentName = DEPT_NAME_BY_KEY[department] ?? department;
  const weekHuman = formatWeekHuman(periodStart, periodEnd);
  const weekPhrase = weekHuman ? ` for ${weekHuman}` : '';

  const rows = plan.map((p) => ({
    recipient_email: p.recipientEmail,
    type: KPI_SCORED_TYPE,
    tone: 'positive',
    title: p.previousAmount === null ? 'KPI Bonus Scored' : 'KPI Bonus Updated',
    message:
      p.previousAmount === null
        ? `Your ${departmentName} KPI bonus${weekPhrase} has been scored: ${formatPeso(p.amount)} will be added to your pay.`
        : `Your ${departmentName} KPI bonus${weekPhrase} was updated: ${formatPeso(p.previousAmount)} → ${formatPeso(p.amount)}.`,
    details: {
      department,
      department_name: departmentName,
      period_start: periodStart,
      period_end: periodEnd,
      amount: p.amount,
      previous_amount: p.previousAmount,
    },
  }));

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase.from('employee_notifications').insert(batch);
    if (error) throw new Error(error.message);
    inserted += batch.length;
  }

  return { inserted, skipped };
}
