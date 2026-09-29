/**
 * The Payroll Wizard's two KPI reads — manager submissions ("KPI Sub.") and HSL
 * KPI entries — as plain async functions, so the week-switch loader and the
 * same-week live refresh (`kpi-bonus-sync`) run ONE computation and cannot
 * disagree about what a week pays.
 *
 * Both THROW on any failed read. A route answering non-OK (or with `error` set)
 * is an unknown, never "no submissions": the wizard's loaders keep their
 * `*Loaded` marker null on a throw, which holds the final-pay publisher. Before
 * this module the manager loader parsed a 500's `{ error }` body as zero rows,
 * marked the week loaded, and let the publisher write a KPI-less total — the
 * silent underpay its own catch block said it refused.
 */
import { WIZARD_PAYABLE_KPI_DEPT_KEYS } from '@/lib/payroll/department-bonus';
import { isFinalPayrollWeekOfMonth } from '@/lib/payroll/bonus-cadence';
import { managerWeekAmount } from '@/lib/hsl-bonus/manager-week-amount';
import { hslDeptAutoDispatches, type DeptConfig } from '@/lib/hsl-bonus/schema';
import type { AppliedKpiRow } from '@/lib/payroll/manager-bonus-attribution';

/** The HSL branches that auto-dispatch: every weekly branch (code teams AND DATA
 *  sub-teams) plus a `monthlyAutoPay` one (SSD Medical Records). */
export function hslPayableSet(
  keys: readonly string[],
  cfgs: Readonly<Record<string, DeptConfig | undefined>>,
): Set<string> {
  return new Set(keys.filter((k) => {
    const cfg = cfgs[k];
    return !!cfg && hslDeptAutoDispatches(cfg);
  }));
}

/** Branches paid per employee from the stored figure (Managers Weekly). */
export function hslPerEmployeeDepts(
  keys: readonly string[],
  cfgs: Readonly<Record<string, DeptConfig | undefined>>,
): Set<string> {
  return new Set(keys.filter((k) => !!cfgs[k]?.perEmployee));
}

function sortedEntries<V>(m: Map<string, V>): Array<[string, V]> {
  return Array.from(m.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Structural equality for the loaders' plain-JSON outputs (built in a
 *  deterministic key order, see the fold comments). */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type KpiFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface StatusRow {
  department: string;
  period_start: string;
  period_end: string;
  status: string;
}

async function readOk<T>(res: Response, what: string): Promise<T> {
  const json = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!res.ok || !json) throw new Error(`${what} failed (${res.status})`);
  if (json.error) throw new Error(`${what} failed: ${String(json.error)}`);
  return json;
}

/** Status rows — narrowed to the week when it is known, so the read never
 *  approaches PostgREST's 1000-row cap (the route does not page). */
async function readStatusRows(week: string | null, fetchImpl: KpiFetch): Promise<StatusRow[]> {
  const qs = week ? `?period_start=${encodeURIComponent(week)}` : '';
  const res = await fetchImpl(`/api/hsl-bonus/period-status${qs}`, { cache: 'no-store' });
  const json = await readOk<{ rows?: StatusRow[] }>(res, 'KPI period status');
  return json.rows ?? [];
}

export interface ManagerKpiLoad {
  meta: Record<string, { period_start: string; status: string }>;
  raw: Record<string, number>;
  rowsByEmail: Record<string, AppliedKpiRow[]>;
  byDept: Record<string, Record<string, number>>;
}

/**
 * Manager KPI submissions for `week` (the Hubstaff week), or — with no week —
 * the latest ready/locked week per department. Locked beats ready. Monthly
 * bonuses count only in the month's final payroll week.
 */
export async function fetchManagerKpi(week: string | null, fetchImpl: KpiFetch = fetch): Promise<ManagerKpiLoad> {
  const statusRows = await readStatusRows(week, fetchImpl);
  // Paying a week is not the same question as offering a card for it, so this
  // reads the payment-side set — every current card PLUS every retired one.
  const managerKeys = WIZARD_PAYABLE_KPI_DEPT_KEYS;
  const chosen = new Map<string, { period_start: string; status: string }>();
  for (const row of statusRows) {
    if (!managerKeys.has(row.department)) continue;
    if (row.status !== 'ready' && row.status !== 'locked') continue;
    if (week) {
      if (row.period_start !== week) continue;
      const cur = chosen.get(row.department);
      if (!cur || (cur.status !== 'locked' && row.status === 'locked')) {
        chosen.set(row.department, { period_start: row.period_start, status: row.status });
      }
    } else {
      const cur = chosen.get(row.department);
      if (
        !cur ||
        row.period_start > cur.period_start ||
        (row.period_start === cur.period_start && row.status === 'locked')
      ) {
        chosen.set(row.department, { period_start: row.period_start, status: row.status });
      }
    }
  }

  const meta: ManagerKpiLoad['meta'] = {};
  const raw: ManagerKpiLoad['raw'] = {};
  const byDept: ManagerKpiLoad['byDept'] = {};
  const rowsByEmail: ManagerKpiLoad['rowsByEmail'] = {};
  // Fetched in parallel, FOLDED in sorted dept order: the maps come out with the
  // same key order for the same data, which is what lets the live refresh tell
  // "unchanged" from "changed" (`sameJson`) and skip a pointless re-publish.
  const fetched = await Promise.all(
    sortedEntries(chosen).map(async ([dept, info]) => {
      const res = await fetchImpl(
        `/api/bonus-catalog-applied?dept=${encodeURIComponent(dept)}&period_start=${encodeURIComponent(info.period_start)}`,
        { cache: 'no-store' },
      );
      const json = await readOk<{
        rows?: {
          employee_email: string;
          employee_name?: string | null;
          amount: number | string | null;
          cadence?: 'weekly' | 'monthly' | null;
        }[];
      }>(res, `KPI submissions for ${dept}`);
      return { dept, info, rows: json.rows ?? [] };
    }),
  );
  for (const { dept, info, rows } of fetched) {
    meta[dept] = info;
    // Monthly bonuses pay once per month, on the LAST payroll week of the
    // month (mirrors PAB) — a backstop; the KPI Calculator already prevents it.
    const isFinalWeekOfMonth = isFinalPayrollWeekOfMonth(info.period_start);
    for (const r of rows) {
      const em = (r.employee_email ?? '').toLowerCase();
      if (!em) continue;
      if (r.cadence === 'monthly' && !isFinalWeekOfMonth) continue;
      const amt = r.amount == null ? 0 : Number(r.amount);
      raw[em] = Math.round((raw[em] ?? 0) + amt);
      const bucket = (byDept[em] ??= {});
      bucket[dept] = Math.round((bucket[dept] ?? 0) + amt);
      (rowsByEmail[em] ??= []).push({
        dept,
        name: (r.employee_name ?? '').trim() || null,
        amount: amt,
      });
    }
  }
  return { meta, raw, rowsByEmail, byDept };
}

export interface HslKpiLoad {
  amounts: Record<string, number>;
  /** null = genuinely nothing ready/locked for the week (a KNOWN empty). */
  period: { period_start: string; period_end: string; status: 'ready' | 'locked' } | null;
}

/**
 * HSL KPI amounts for the pinned week across `payableSet` (every auto-dispatch
 * branch). Locked beats ready. `perEmployeeDepts` (Managers Weekly) start from
 * the stored figure and withhold only the monthly components the week cannot pay.
 */
export async function fetchHslKpi(args: {
  week: string;
  payableSet: ReadonlySet<string>;
  perEmployeeDepts: ReadonlySet<string>;
  fetchImpl?: KpiFetch;
}): Promise<HslKpiLoad> {
  const { week, payableSet, perEmployeeDepts } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const isFinalWeek = isFinalPayrollWeekOfMonth(week);
  const statusRows = await readStatusRows(week, fetchImpl);

  const chosen = new Map<string, { period_start: string; period_end: string; status: 'ready' | 'locked' }>();
  for (const row of statusRows) {
    if (!payableSet.has(row.department)) continue;
    if (row.status !== 'ready' && row.status !== 'locked') continue;
    if (row.period_start !== week) continue;
    const cur = chosen.get(row.department);
    if (!cur || (cur.status !== 'locked' && row.status === 'locked')) {
      chosen.set(row.department, { period_start: row.period_start, period_end: row.period_end, status: row.status });
    }
  }
  if (chosen.size === 0) return { amounts: {}, period: null };

  const amounts: Record<string, number> = {};
  const fetched = await Promise.all(
    sortedEntries(chosen).map(async ([dept, info]) => {
      const res = await fetchImpl(
        `/api/hsl-bonus/entries?dept=${encodeURIComponent(dept)}&period_start=${encodeURIComponent(info.period_start)}`,
        { cache: 'no-store' },
      );
      const json = await readOk<{
        rows?: { employee_email: string; calculated_bonus: number; kpi_data?: Record<string, unknown> }[];
      }>(res, `HSL KPI entries for ${dept}`);
      return { dept, info, rows: json.rows ?? [] };
    }),
  );
  for (const { dept, info, rows } of fetched) {
    const perEmployee = perEmployeeDepts.has(dept);
    for (const e of rows) {
      const em = (e.employee_email ?? '').toLowerCase();
      if (!em || em === '__dept_meta__') continue;
      let amt: number;
      if (perEmployee) {
        const r = managerWeekAmount({
          storedBonus: e.calculated_bonus,
          email: em,
          kpiData: (e.kpi_data ?? {}) as Record<string, number | boolean>,
          periodStart: info.period_start,
          isFinalWeek,
        });
        if (r.inconsistent) {
          console.error(
            `[hslKpi] ${dept}/${em}: stored bonus ₱${e.calculated_bonus} is below its own monthly components (₱${r.monthlyWithheld}) — paying ₱0 rather than a negative`,
          );
        }
        amt = r.amount;
      } else {
        amt = Math.round(e.calculated_bonus ?? 0);
      }
      amounts[em] = Math.round((amounts[em] ?? 0) + amt);
    }
  }

  const picks = Array.from(chosen.values());
  return {
    amounts,
    period: {
      period_start: week,
      period_end: picks.find((p) => p.period_end)?.period_end ?? '',
      status: picks.every((p) => p.status === 'locked') ? 'locked' : 'ready',
    },
  };
}

/**
 * May the wizard pull a same-week KPI change in live right now? Never in a
 * replayed week (view-only), never while Start Processing holds the payroll
 * lock, and never once the cycle's values are LOCKED for Payment Dispatch —
 * the rule `pullNotesAdjustments` already follows: "nothing may drift in
 * silently mid-payout". An unknown lock (still loading) is treated as locked.
 */
export function wizardKpiLiveAllowed(s: {
  isReplay: boolean;
  processingLocked: boolean;
  valuesLockLoading: boolean;
  valuesLocked: boolean;
}): boolean {
  return !s.isReplay && !s.processingLocked && !s.valuesLockLoading && !s.valuesLocked;
}
