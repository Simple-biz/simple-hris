'use client';

// "Bonuses to score" — the manager Overview's read-only view of what the KPI
// Calculator still owes payroll for the live pay week.
//
// It answers one question per department the manager can score: has this
// dept-period been submitted yet? The states mirror Payroll Readiness exactly
// (payroll-readiness.ts -> buildKpiReadiness) so the manager's Overview and the
// accountant's Readiness tab never disagree about who is still pending:
//
//   locked / submitted  -> done; payroll has it
//   in_progress         -> scores saved but never marked Ready
//   todo                -> nothing scored yet
//   nothing             -> no catalog bonus assigned to the dept this week
//   not_due             -> monthly branch, and this isn't the month's pay week
//
// Period keys are the same ones the calculators write against, per department:
// weekly work keys on the live Hubstaff upload's week start; monthly HSL
// branches key on the 1st of the month (HslBonusCalculator's `periodStart`).
// Reading any other key returns an empty dept-period that looks unscored — the
// same key-drift that stranded whole weeks of scores before (see
// scripts/audit-kpi-key-drift.mts), which is why nothing is computed until the
// live week resolves.

import { useEffect, useMemo, useState } from 'react';
import {
  HSL_DEPTS,
  HSL_DEPT_KEYS,
  canAccessHslDept,
  type BonusStatus,
  type HslDeptKey,
} from '@/lib/hsl-bonus/schema';
import { MANAGER_BONUS_DEPT_KEYS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import { catalogDeptColor, catalogDeptName } from '@/lib/departments/dept-identity';
import { isFinalPayrollWeekOfMonth } from '@/lib/payroll/bonus-cadence';
import { usePayWeeks, weekEndFromStart } from '@/lib/hubstaff/use-pay-weeks';
import type { BonusAssignment, BonusDef } from '@/lib/bonus-catalog/types';

/** Where a department stands on this period's scoring. Ordered by urgency. */
export type ScoringState = 'todo' | 'in_progress' | 'submitted' | 'locked' | 'nothing' | 'not_due';

/** Ranking used to float what still needs the manager to the top. */
const STATE_RANK: Record<ScoringState, number> = {
  todo: 0,
  in_progress: 1,
  submitted: 2,
  locked: 3,
  nothing: 4,
  not_due: 5,
};

/** States that still need the manager to act. */
export function isOutstanding(state: ScoringState): boolean {
  return state === 'todo' || state === 'in_progress';
}

export interface BonusScoringItem {
  kind: 'hsl' | 'catalog';
  /** Department key — the calculators' `initialOpenDept` / `initialFilter`. */
  key: string;
  name: string;
  /** Accent hex, matching the department's card in the calculator. */
  color: string;
  cadence: 'weekly' | 'monthly';
  /** The `period_start` this department's scores are stored under. */
  periodStart: string;
  state: ScoringState;
  /** People with a scored (non-zero) amount so far. */
  scoredCount: number;
  totalBonus: number;
}

export interface BonusScoringQueue {
  loading: boolean;
  /** The live payroll week could not be resolved (or nothing is uploaded yet) —
   *  every state would be a guess, so the caller shows this instead of a list. */
  weekUnresolved: boolean;
  error: string | null;
  weekStart: string | null;
  weekEnd: string | null;
  items: BonusScoringItem[];
  /** How many departments still need scoring or submitting. */
  outstanding: number;
}

interface HslSummaryRow {
  department: string;
  period_start: string;
  status: BonusStatus;
  scored_count: number;
  total_bonus: number;
}

interface AppliedSummary {
  department: string;
  period_start: string;
  employee_count: number;
  total_bonus: number;
}

const EMPTY: BonusScoringItem[] = [];

/** 1st of the month containing `iso` — the monthly HSL branches' period key. */
function monthStartOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * What the manager still owes payroll this pay week, per department.
 *
 * `managedDepts` / `isElevated` are the server-driven gate from
 * `/api/manager/department-members`, resolved the same way the KPI Calculator
 * tab resolves them — including the rule that being elevated alone does NOT
 * unlock the HSL branches (only explicit `hsl:*` assignments do).
 */
export function useBonusScoringQueue({
  managedDepts,
  isElevated,
  ready = true,
}: {
  managedDepts: string[];
  isElevated: boolean;
  /** False while the caller is still resolving whether/what this viewer scores
   *  (feature permissions, the department gate). Nothing is fetched and the
   *  queue reports `loading` — an empty list here would read as "nothing to
   *  score", which is the one wrong answer. */
  ready?: boolean;
}): BonusScoringQueue {
  const { currentWeekStart, loaded: weeksLoaded } = usePayWeeks();

  const hslDepts = useMemo<HslDeptKey[]>(
    // `false`, not `isElevated`: the KPI tab only shows HSL branches a manager
    // was explicitly assigned, so the Overview must not invent extra ones.
    () => HSL_DEPT_KEYS.filter((k) => canAccessHslDept(managedDepts, k, false)),
    [managedDepts],
  );

  const catalogDepts = useMemo<string[]>(() => {
    if (isElevated) return MANAGER_BONUS_DEPT_KEYS;
    const keys = new Set<string>();
    for (const d of managedDepts) {
      if (!d || d.includes(':')) continue; // `hsl:*` are access keys, not depts
      const k = normalizeDeptToKey(d);
      if (k && MANAGER_BONUS_DEPT_KEYS.includes(k)) keys.add(k);
      // In-app (Payment Catalog -> Department) departments key on their slug.
      else if (!k) {
        const slug = slugifyDeptKey(d);
        if (slug) keys.add(slug);
      }
    }
    return Array.from(keys);
  }, [managedDepts, isElevated]);

  const hslKey = hslDepts.join(',');
  const catalogKey = catalogDepts.join(',');
  const hasDepts = hslDepts.length > 0 || catalogDepts.length > 0;

  const [items, setItems] = useState<BonusScoringItem[]>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const weekStart = currentWeekStart;
  const weekEnd = useMemo(() => (weekStart ? weekEndFromStart(weekStart) : null), [weekStart]);

  useEffect(() => {
    if (!ready) {
      setLoading(true);
      return;
    }
    if (!hasDepts) {
      setItems(EMPTY);
      setLoading(false);
      return;
    }
    // Hold the spinner until the live pay week is known — see the header note on
    // key drift. `weeksLoaded` without a week means nothing is uploaded yet.
    if (!weeksLoaded) {
      setLoading(true);
      return;
    }
    if (!weekStart) {
      setItems(EMPTY);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const monthStart = monthStartOf(weekStart);
      const isMonthlyPayWeek = isFinalPayrollWeekOfMonth(weekStart);

      const [hslSummary, weekStatus, applied, catalog] = await Promise.all([
        hslDepts.length > 0
          ? getJson<{ rows?: HslSummaryRow[] }>(
              `/api/hsl-bonus/period-summary?depts=${hslDepts.join(',')}`,
            )
          : Promise.resolve(null),
        catalogDepts.length > 0
          ? getJson<{ rows?: { department: string; status: BonusStatus }[] }>(
              `/api/hsl-bonus/period-status?period_start=${weekStart}`,
            )
          : Promise.resolve(null),
        catalogDepts.length > 0
          ? getJson<{ rows?: AppliedSummary[] }>(
              `/api/bonus-catalog-applied?summary=1&period_start=${weekStart}&depts=${catalogDepts.join(',')}`,
            )
          : Promise.resolve(null),
        catalogDepts.length > 0
          ? getJson<{ bonuses?: BonusDef[]; assignments?: BonusAssignment[] }>('/api/bonus-catalog')
          : Promise.resolve(null),
      ]);
      if (cancelled) return;

      // Departments with at least one catalog bonus a manager could apply THIS
      // week — resolved the way the calculator resolves it (dept key normalized,
      // assignments whose bonus was deleted ignored, monthly bonuses only in the
      // month's final payroll week). A dept with none has nothing to submit, so
      // it reads "Nothing to score" instead of sitting on a false to-do. If the
      // catalog can't be read we assume every dept has bonuses — never auto-clear
      // a department off the list on a failed fetch.
      let deptsWithBonuses: Set<string> | null = null;
      if (catalog) {
        const byId = new Map((catalog.bonuses ?? []).map((b) => [b.id, b]));
        deptsWithBonuses = new Set<string>();
        for (const a of catalog.assignments ?? []) {
          const bonus = byId.get(a.bonusId);
          if (!bonus) continue;
          if (bonus.cadence === 'monthly' && !isMonthlyPayWeek) continue;
          deptsWithBonuses.add(normalizeDeptToKey(a.departmentKey) ?? a.departmentKey);
        }
      }

      const hslByDeptPeriod = new Map<string, HslSummaryRow>();
      for (const r of hslSummary?.rows ?? []) {
        hslByDeptPeriod.set(`${r.department}::${r.period_start}`, r);
      }
      const statusByDept = new Map<string, BonusStatus>();
      for (const r of weekStatus?.rows ?? []) statusByDept.set(r.department, r.status);
      const appliedByDept = new Map<string, AppliedSummary>();
      for (const r of applied?.rows ?? []) {
        if (r.period_start === weekStart) appliedByDept.set(r.department, r);
      }

      const out: BonusScoringItem[] = [];

      for (const key of catalogDepts) {
        const status = statusByDept.get(key) ?? 'draft';
        const row = appliedByDept.get(key);
        const scored = row?.employee_count ?? 0;
        const hasBonuses = deptsWithBonuses === null || deptsWithBonuses.has(key);
        const state: ScoringState =
          status === 'locked'
            ? 'locked'
            : status === 'ready'
              ? 'submitted'
              : scored > 0
                ? 'in_progress'
                : hasBonuses
                  ? 'todo'
                  : 'nothing';
        out.push({
          kind: 'catalog',
          key,
          name: catalogDeptName(key),
          color: catalogDeptColor(key),
          cadence: 'weekly',
          periodStart: weekStart,
          state,
          scoredCount: scored,
          totalBonus: Math.round(row?.total_bonus ?? 0),
        });
      }

      for (const key of hslDepts) {
        const cfg = HSL_DEPTS[key];
        const periodStart = cfg.cadence === 'weekly' ? weekStart : monthStart;
        const row = hslByDeptPeriod.get(`${key}::${periodStart}`);
        const status = row?.status ?? 'draft';
        const scored = row?.scored_count ?? 0;
        // Monthly branches pay once a month, on the month's final payroll week
        // (mirrors PAB and Payroll Readiness) — outside it they aren't owed yet.
        const due = cfg.cadence === 'weekly' || isMonthlyPayWeek;
        const state: ScoringState =
          status === 'locked'
            ? 'locked'
            : status === 'ready'
              ? 'submitted'
              : !due
                ? 'not_due'
                : scored > 0
                  ? 'in_progress'
                  : 'todo';
        out.push({
          kind: 'hsl',
          key,
          name: cfg.name,
          color: cfg.color,
          cadence: cfg.cadence,
          periodStart,
          state,
          scoredCount: scored,
          totalBonus: Math.round(row?.total_bonus ?? 0),
        });
      }

      out.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name));
      setItems(out);
      // Only a total read failure is worth surfacing — a single missing summary
      // just leaves that dept reading unscored, which is the safe direction.
      if (!hslSummary && !weekStatus && !applied && !catalog) {
        setError('Could not load this week’s bonus status.');
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // hslKey / catalogKey stand in for the (stable-content) dept arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hasDepts, weeksLoaded, weekStart, hslKey, catalogKey]);

  const outstanding = useMemo(() => items.filter((i) => isOutstanding(i.state)).length, [items]);

  return {
    loading: !ready || (loading && hasDepts),
    weekUnresolved: ready && weeksLoaded && !weekStart,
    error,
    weekStart,
    weekEnd,
    items,
    outstanding,
  };
}
