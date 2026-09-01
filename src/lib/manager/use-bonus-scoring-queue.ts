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
import { MANAGER_BONUS_DEPT_KEYS, isKpiCalculatorDeptKey } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import { catalogDeptColor, catalogDeptName } from '@/lib/departments/dept-identity';
import { isFinalPayrollWeekOfMonth } from '@/lib/payroll/bonus-cadence';
import { usePayWeeks, weekEndFromStart } from '@/lib/hubstaff/use-pay-weeks';
import type { BonusAssignment, BonusDef } from '@/lib/bonus-catalog/types';
import { MANAGER_CACHE_KEYS } from '@/lib/manager/tab-cache';
import { useManagerCachedState } from '@/hooks/useManagerCachedState';

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

/** The `/api/bonus-catalog` payload, exactly as the route answers it. */
export interface BonusCatalogPayload {
  bonuses?: BonusDef[];
  assignments?: BonusAssignment[];
}

/**
 * The three per-week summaries this panel reads, plus the week they describe.
 *
 * This is the RAW shape that goes in the tab cache — never the derived
 * `BonusScoringItem[]`. The week travels inside the value so a cached copy can
 * paint before `usePayWeeks` has resolved the live week; see
 * `MANAGER_CACHE_KEYS.scoringSummaries`.
 */
export interface BonusScoringSummaries {
  weekStart: string;
  hslSummary: { rows?: HslSummaryRow[] } | null;
  weekStatus: { rows?: { department: string; status: BonusStatus }[] } | null;
  applied: { rows?: AppliedSummary[] } | null;
}


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
 * Turn the raw summaries + catalog into the rows the panel renders.
 *
 * Module-scope and pure on purpose: it is called once by the live fetch and once
 * by the cache-seeded render, and if those two produced different states the
 * cached paint would be a quiet lie rather than a head start. It is also the
 * only place the Payroll Readiness state machine is mirrored, so there is one
 * implementation to keep in step with `buildKpiReadiness`.
 */
export function buildBonusScoringItems({
  hslDepts,
  catalogDepts,
  summaries,
  catalog,
}: {
  hslDepts: HslDeptKey[];
  catalogDepts: string[];
  summaries: BonusScoringSummaries;
  catalog: BonusCatalogPayload | null;
}): BonusScoringItem[] {
  const { weekStart, hslSummary, weekStatus, applied } = summaries;
  const monthStart = monthStartOf(weekStart);
  const isMonthlyPayWeek = isFinalPayrollWeekOfMonth(weekStart);
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
  return out;
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
      // Retired departments have no calculator card, so the tile must not count
      // them — otherwise "Bonuses to score" outstanding never reaches zero.
      else if (!k) {
        const slug = slugifyDeptKey(d);
        if (slug && isKpiCalculatorDeptKey(slug)) keys.add(slug);
      }
    }
    return Array.from(keys);
  }, [managedDepts, isElevated]);

  const hslKey = hslDepts.join(',');
  const catalogKey = catalogDepts.join(',');
  const hasDepts = hslDepts.length > 0 || catalogDepts.length > 0;

  // RAW payloads are the cached unit; `items` below is derived from them by the
  // one pure builder both this fetch and a cache-seeded render call.
  const [summaries, setSummaries] = useManagerCachedState<BonusScoringSummaries | null>(
    MANAGER_CACHE_KEYS.scoringSummaries,
    null,
  );
  const [catalog, setCatalog] = useManagerCachedState<BonusCatalogPayload | null>(
    MANAGER_CACHE_KEYS.bonusCatalog,
    null,
  );
  /** Whether the fetch below has answered at least once in this page load. */
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(() => {
    if (!hasDepts || summaries === null) return EMPTY;
    return buildBonusScoringItems({ hslDepts, catalogDepts, summaries, catalog });
    // hslKey / catalogKey stand in for the (stable-content) dept arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDepts, hslKey, catalogKey, summaries, catalog]);

  /** The LIVE week — the only one a fetch may be built from. */
  const liveWeekStart = currentWeekStart;
  /**
   * The week actually on screen: the live one once it resolves, otherwise the
   * one the cached summaries describe. Paint only — see
   * `MANAGER_CACHE_KEYS.scoringSummaries`. The panel labels it, so a cached week
   * is self-declaring rather than silently passing as this week.
   */
  const weekStart = liveWeekStart ?? summaries?.weekStart ?? null;
  const weekEnd = useMemo(() => (weekStart ? weekEndFromStart(weekStart) : null), [weekStart]);

  useEffect(() => {
    if (!ready) return;
    if (!hasDepts) {
      setSettled(true);
      return;
    }
    // Wait for the live pay week before fetching anything — see the header note
    // on key drift. `weeksLoaded` without a week means nothing is uploaded yet.
    if (!weeksLoaded) return;
    if (!liveWeekStart) {
      setSettled(true);
      return;
    }
    const weekStart = liveWeekStart;

    let cancelled = false;
    setError(null);

    (async () => {
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
          ? getJson<BonusCatalogPayload>('/api/bonus-catalog')
          : Promise.resolve(null),
      ]);
      if (cancelled) return;

      // RAW in, RAW cached. `buildBonusScoringItems` below turns these into the
      // rendered rows on both the seeded and the fetched path, so the two cannot
      // disagree about what a department's state is.
      setSummaries({ weekStart, hslSummary, weekStatus, applied });
      // The catalog is not per-week and the Departments calculator reads the
      // same URL, so it keeps its own key rather than riding along with a week.
      // A failed catalog read leaves the previous one in place — never null it,
      // or every dept silently reads "Nothing to score".
      if (catalog) setCatalog(catalog);
      setSettled(true);
      // Only a total read failure is worth surfacing — a single missing summary
      // just leaves that dept reading unscored, which is the safe direction.
      setError(
        !hslSummary && !weekStatus && !applied && !catalog
          ? 'Could not load this week’s bonus status.'
          : null,
      );
    })();

    return () => {
      cancelled = true;
    };
    // hslKey / catalogKey stand in for the (stable-content) dept arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hasDepts, weeksLoaded, liveWeekStart, hslKey, catalogKey]);

  const outstanding = useMemo(() => items.filter((i) => isOutstanding(i.state)).length, [items]);

  return {
    // A cached paint counts as loaded: the skeleton is for having nothing to
    // show, not for having an in-flight request.
    loading: !ready || (hasDepts && !settled && items.length === 0),
    weekUnresolved: ready && weeksLoaded && !liveWeekStart,
    error,
    weekStart,
    weekEnd,
    items,
    outstanding,
  };
}
