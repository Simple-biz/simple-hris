'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle, AppWindow, CalendarDays, Check, CheckCircle2, ChevronLeft, ChevronRight,
  Download, Eye, Loader2, Lock, Maximize2, Minus, PanelRight, Plus,
  RefreshCw, RotateCcw, Search, Trash2, UserPlus, Users, X, Zap,
} from 'lucide-react';

const COLLAPSE_EASE = [0.22, 1, 0.36, 1] as const;
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { StatusChip } from './kpi-status-chip';
import { KpiReadinessChip } from './kpi-readiness-chip';
import PayrollLockBanner from '@/components/employee/PayrollLockBanner';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import {
  BonusStatus, DeptConfig, HslDeptKey, HSL_DEPTS, HSL_DEPT_KEYS,
  KpiData, ManagerComponent, bandValue, landedBand, managerCohortFor, managerSpecFor,
  TieredRule,
  calcBonus, calcManagerBonus, canAccessHslDept, formatPeso,
} from '@/lib/hsl-bonus/schema';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import {
  pickCurrentSourceFile,
  type HubstaffSourceFilesResponse,
} from '@/lib/hubstaff/current-upload';
import { nextPayWeek, upcomingWeekFor, weekEndFromStart, type PayWeek } from '@/lib/hubstaff/use-pay-weeks';
import HslBonusReadyPreview from './HslBonusReadyPreview';
import KpiCalculatorLoading from './KpiCalculatorLoading';
import KpiInsightCards from './KpiInsightCards';
import { isSundayIso } from '@/lib/manager/kpi-insights';
import { kpiCalculatorRevealed } from '@/lib/manager/kpi-calculator-reveal';
import {
  KPI_CACHE_KEYS,
  getKpiCache,
  readKpiCacheStamp,
  setKpiCache,
} from '@/lib/manager/kpi-cache';
import { useKpiCacheIdentity } from '@/hooks/useKpiCacheIdentity';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import type { PayrollDispatchLockState } from '@/lib/supabase/payroll-dispatch-lock';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useKpiLive } from '@/hooks/useKpiLive';
import { trackRead, useTableRefresh, type RefreshTracker } from '@/components/common/RefreshProgressDialog';
import { countOf } from '@/lib/refresh-progress/refresh-progress';
import { slugifyDeptKey } from '@/lib/departments/registry';
import {
  OffboardedStrip,
  useOffboardedPeople,
  offboardedAddEmail,
  offboardedLeftLabel,
  matchesOffboardedQuery,
  type OffboardedCandidate,
} from './OffboardedSuggestions';
import { offboardedRelevantToWeek } from '@/lib/roster/offboarded-week-relevance';
import {
  KPI_AUTOSAVE_DEBOUNCE_MS,
  kpiAutosaveGate,
  shouldRearmAutosave,
} from '@/lib/manager/kpi-autosave';

import { formatDeptLabel, hslSubDeptLabel } from '@/lib/departments/hsl-subdept';
import type { BonusAssignment, BonusDef } from '@/lib/bonus-catalog/types';
import { bonusProvenance } from '@/lib/bonus-catalog/history';
import { useBuiltinSubs } from '@/lib/departments/use-builtin-subs';
import { builtinSubsFor } from '@/lib/departments/builtin-subs';
import { hslBranchConfigs, hslBranchKeys } from '@/lib/hsl-bonus/data-branch';
import {
  calcHslCatalogBonus,
  calcHslCatalogTotal,
  catalogBonusVariables,
  catalogOnKey,
  catalogVarKey,
  hslCatalogBonusesFor,
  hslCatalogBonusesHeldThisWeek,
  type HslCatalogBonus,
} from '@/lib/hsl-bonus/catalog-bonus';
import { isFinalPayrollWeekOfMonth } from '@/lib/payroll/bonus-cadence';
// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntryRow {
  id?: string;
  employee_email: string;
  employee_name: string;
  is_manager: boolean;
  kpi_data: KpiData;
  calculated_bonus: number;
}

interface DeptState {
  entries: EntryRow[];
  status: BonusStatus;
  dirty: boolean;
  saving: boolean;
  /** Emails belonging to the dept's true roster (hsl_team_members, or HSL_MANAGERS
   *  for the Managers dept). Any entry whose email is NOT here was added manually
   *  as an external member and can be removed. */
  rosterEmails: Set<string>;
}

type AllDeptState = Record<HslDeptKey, DeptState>;

// ── Branch overlay presentation ───────────────────────────────────────────────

/** The three ways a branch can open away from the stack. Deliberately the same
 *  set the Departments calculator offers (`DeptBonusCalculator`'s `OpenMode`) so
 *  a manager who scores in both learns one control, not two. */
export type HslOpenMode = 'window' | 'half' | 'full';

const HSL_VIEW_MODES: { mode: HslOpenMode; label: string; Icon: typeof PanelRight }[] = [
  { mode: 'window', label: 'Windowed', Icon: AppWindow },
  { mode: 'half', label: 'Half window', Icon: PanelRight },
  { mode: 'full', label: 'Full screen', Icon: Maximize2 },
];

/** Overlay entrance easing. Matches the collapse curve already used elsewhere in
 *  the calculator, so every motion in this surface reads as one system. */
const OVERLAY_EASE = [0.22, 1, 0.36, 1] as const;

/** How each presentation arrives and leaves. `flat` is the reduced-motion exit:
 *  a plain fade with no travel. Driven by variant NAME rather than by inline
 *  objects so the panel keeps one key across mode switches and never remounts. */
const PANEL_VARIANTS: Record<HslOpenMode, Record<string, Record<string, number | string>>> = {
  // A window appears in place.
  window: { hidden: { opacity: 0, scale: 0.97 }, shown: { opacity: 1, scale: 1 }, flat: { opacity: 0 } },
  // A side panel comes in from the edge it is docked to.
  half: { hidden: { x: '100%' }, shown: { x: 0, opacity: 1 }, flat: { opacity: 0 } },
  // Full screen settles rather than travels — there is nowhere for it to come from.
  full: { hidden: { opacity: 0, scale: 1.012 }, shown: { opacity: 1, scale: 1 }, flat: { opacity: 0 } },
};

/** Segmented control for Windowed / Half window / Full screen. `compact` drops
 *  the labels for the tight in-overlay header. */
function ViewSwitch({
  mode, onChange, compact,
}: {
  mode: HslOpenMode;
  onChange: (m: HslOpenMode) => void;
  compact?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="How the branch opens"
      className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      {HSL_VIEW_MODES.map(({ mode: m, label, Icon }) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={active}
            aria-label={label}
            title={label}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium outline-none',
              'transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-blue-500',
              active
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {!compact && <span className="hidden sm:inline">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A local calendar date as YYYY-MM-DD. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Monday-of-week containing `d`, formatted as YYYY-MM-DD in *local* time.
 *  HSL departments work Mon–Sun, so weeks pivot on Monday. We avoid
 *  `toISOString()` here because it converts to UTC and can shift the date
 *  back a day for late-evening UTC+ users. */
function isoWeekStart(d: Date): string {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = day.getDay(); // 0=Sun … 6=Sat
  const daysBack = dow === 0 ? 6 : dow - 1; // Sunday is 6 back, otherwise dow-1
  day.setDate(day.getDate() - daysBack);
  const yyyy = day.getFullYear();
  const mm = String(day.getMonth() + 1).padStart(2, '0');
  const dd = String(day.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isoWeekEnd(start: string): string {
  const d = new Date(start);
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

/** Both cadences now key off the same Hubstaff-resolved payroll week (see
 *  `periodStart`) — a monthly dept's period_end is just that week's Saturday,
 *  same as weekly. */
function periodEnd(_dept: DeptConfig, start: string): string {
  return isoWeekEnd(start);
}

/**
 * Per-employee bonus recompute for the Managers Weekly dept (perEmployee).
 * Each manager's `calculated_bonus` is the sum of their ticked incentive
 * components (calcManagerBonus). `calcBonus` returns 0 for this dept because it
 * has no uniform rules, so this keeps the persisted amount canonical.
 * Pass-through for any other dept.
 */
export function recomputeManagerEntries(
  deptKey: HslDeptKey,
  entries: EntryRow[],
  periodStart: string,
): EntryRow[] {
  // A DATA branch has no config in HSL_DEPTS and is never `perEmployee`.
  if (!HSL_DEPTS[deptKey]?.perEmployee) return entries;
  return entries.map((e) => {
    const bonus = calcManagerBonus(e.employee_email, e.kpi_data, { periodStart });
    return e.calculated_bonus === bonus ? e : { ...e, calculated_bonus: bonus };
  });
}

function periodLabel(dept: DeptConfig, start: string): string {
  if (dept.cadence === 'weekly') {
    const s = new Date(start + 'T00:00:00');
    const e = new Date(isoWeekEnd(start) + 'T00:00:00');
    return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }
  const [y, m] = start.split('-').map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Canonical HSL roster row from `hsl_team_members` table.
// NOTE: hourly_rate/ot_rate are intentionally NOT part of this shape — the
// /api/hsl-bonus/team-members endpoint no longer ships pay rates to the client
// (Accounting/CEO only) and the calculator never used them.
interface HslMember {
  email: string;
  full_name: string | null;
  hsl_name: string | null;
  is_manager: boolean;
  /** The old SSD colour team, still on the roster rows. Not read: SSD stopped
   *  scoring by colour team on 2026-10-06 (Kane). */
  sub_team: string | null;
}

// ── One branch's raw server payload, and the single way it becomes state ──────

/**
 * The three routes a branch loads, exactly as they answered.
 *
 * This is what goes in the tab cache — never the derived `DeptState`. `DeptState`
 * holds a `Set` (`rosterEmails`), which `JSON.stringify` turns into `{}`: an
 * empty roster reads as "everyone here is an external member", which paints a
 * removable ✕ against every real member of the branch. Caching the raw rows and
 * re-deriving through {@link mergeHslBranchPayload} means the seeded path and the
 * fetched path cannot diverge — the same rule
 * `docs/features/employee-dashboard-cache.md` sets out under *Shapes that do not
 * survive JSON.stringify*.
 */
export interface HslBranchPayload {
  entries: {
    id: string;
    employee_email: string;
    employee_name: string | null;
    is_manager: boolean;
    kpi_data: KpiData;
    calculated_bonus: number;
  }[];
  status: { status: BonusStatus }[];
  members: HslMember[];
}

/**
 * Merge a branch's saved entries with its roster into the rows the tables render.
 *
 * Pure and module-scope on purpose: it is called once by the live load and once
 * by the cache seed, and if those two ever produced different shapes the cached
 * paint would be a quiet lie rather than a head start.
 */
export function mergeHslBranchPayload(
  key: HslDeptKey,
  payload: HslBranchPayload,
  periodStart: string,
  /** The branch config. Passed rather than looked up: a DATA sub-team
   *  (2026-09-22) has no `HSL_DEPTS` entry. */
  cfg?: DeptConfig,
): { entries: EntryRow[]; status: BonusStatus; rosterEmails: Set<string> } {
  const dept = cfg ?? HSL_DEPTS[key];

  // DB entries (existing scored data) — these win over roster defaults.
  const byEmail = new Map<string, EntryRow>();
  (payload.entries ?? []).forEach((r) => {
    byEmail.set(r.employee_email.toLowerCase(), {
      id: r.id,
      employee_email: r.employee_email.toLowerCase(),
      employee_name: r.employee_name ?? r.employee_email,
      is_manager: r.is_manager,
      kpi_data: r.kpi_data ?? {},
      calculated_bonus: r.calculated_bonus ?? 0,
    });
  });

  // Seed any roster members from hsl_team_members who aren't in entries yet.
  // rosterEmails tracks the true roster so manually-added external members
  // (email not in the roster) can be tagged + removed. SSD's colour team is no
  // longer copied into `kpi_data.sub_team`: nothing scores by it since
  // 2026-10-06, and a seeded key nobody reads would ride into every saved row.
  const rosterEmails = new Set<string>();
  (payload.members ?? []).forEach((m) => {
    const email = m.email.toLowerCase();
    if (!email) return;
    rosterEmails.add(email);
    if (byEmail.has(email)) return;
    byEmail.set(email, {
      employee_email: email,
      employee_name: m.full_name ?? m.hsl_name ?? email,
      is_manager: m.is_manager,
      kpi_data: {},
      calculated_bonus: 0,
    });
  });

  // Managers Weekly dept: the roster is the hardcoded HSL_MANAGERS cohort FOR THIS
  // WEEK (specs are dated — Sherwin, AR and Jazmine only exist from 2026-08-30),
  // not hsl_team_members. Seed any manager not already present so the dept always
  // shows its full lineup even before anything has been scored.
  if (dept.perEmployee) {
    managerCohortFor(periodStart).forEach((mgr) => {
      const email = mgr.email.toLowerCase();
      rosterEmails.add(email);
      if (byEmail.has(email)) return;
      byEmail.set(email, {
        employee_email: email,
        employee_name: mgr.name,
        is_manager: true,
        kpi_data: {},
        calculated_bonus: 0,
      });
    });
  }

  const sorted = Array.from(byEmail.values()).sort((a, b) =>
    a.employee_name.localeCompare(b.employee_name),
  );
  // Recompute Managers Weekly component sums so the dept total + table read the
  // right values (the DB persists 0 for legacy/unscored entries). Every other
  // branch shows its SAVED amount until a row is edited.
  const entries = recomputeManagerEntries(key, sorted, periodStart);

  return {
    entries,
    status: payload.status?.[0]?.status ?? 'draft',
    rosterEmails,
  };
}

// ── Shared entry primitives ───────────────────────────────────────────────────

/** Peso amount that gives a quick "counted" pop whenever it changes, so the
 *  operator sees their entry land. CSS-only; self-disables under reduced motion. */
export function AnimatedPeso({
  amount,
  currency = 'PHP',
  className,
}: {
  amount: number;
  currency?: 'PHP' | 'USD';
  className?: string;
}) {
  const [pulse, setPulse] = useState(0);
  const prev = React.useRef(amount);
  useEffect(() => {
    if (prev.current !== amount) {
      prev.current = amount;
      setPulse((p) => p + 1);
    }
  }, [amount]);
  return (
    <span
      key={pulse}
      className={cn('inline-block tabular-nums', pulse > 0 && 'kpi-value-pop', className)}
    >
      {formatPeso(amount, currency)}
    </span>
  );
}

/** Compact number stepper for KPI counts: type a value or nudge with −/+.
 *  Focus selects the field so typing replaces; values never drop below 0. The
 *  native spinners are hidden in favour of larger, touch-friendly buttons. */
function StepperInput({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const set = (n: number) => onChange(Math.max(0, Number.isFinite(n) ? n : 0));
  const btn =
    'flex h-7 w-6 items-center justify-center border-zinc-300 bg-zinc-50 text-zinc-500 transition-all hover:bg-zinc-100 hover:text-zinc-900 active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-50 disabled:hover:text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100';
  return (
    <div className="inline-flex items-center">
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Decrease ${ariaLabel ?? ''}`.trim()}
        disabled={disabled || value <= 0}
        onClick={() => set(value - 1)}
        className={cn(btn, 'rounded-l-md border border-r-0')}
      >
        <Minus className="h-3 w-3" aria-hidden />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        aria-label={ariaLabel}
        className="h-7 w-12 border-y border-zinc-300 bg-white px-1 text-center font-mono text-xs font-medium tabular-nums text-zinc-900 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-200 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-700 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={value === 0 ? '' : String(value)}
        placeholder="0"
        disabled={disabled}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => set(parseInt(e.target.value.replace(/[^\d]/g, ''), 10) || 0)}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Increase ${ariaLabel ?? ''}`.trim()}
        disabled={disabled}
        onClick={() => set(value + 1)}
        className={cn(btn, 'rounded-r-md border border-l-0')}
      >
        <Plus className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

/** A raw peso-amount field for `manual` rules: the manager types the exact
 *  amount to add (no rate, no multiplication). Accepts decimals; blank = 0. */
function PesoAmountInput({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-zinc-300 bg-white focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-500 dark:focus-within:ring-zinc-700">
      <span className="pl-1.5 font-mono text-xs text-zinc-400 dark:text-zinc-500" aria-hidden>₱</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        aria-label={ariaLabel}
        className="h-7 w-20 bg-transparent px-1 text-right font-mono text-xs font-medium tabular-nums text-zinc-900 outline-none disabled:opacity-40 dark:text-zinc-100 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={value === 0 ? '' : String(value)}
        placeholder="0"
        disabled={disabled}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          onChange(Math.max(0, Number.isFinite(n) ? n : 0));
        }}
      />
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface HslBonusCalculatorProps {
  viewerEmail: string | null;
  managedDepts: string[];
  isElevated: boolean;
  /**
   * The HSL-Branches / Departments navigation, rendered into this calculator's
   * own toolbar beside the people search rather than in a bar of its own above
   * it (Kane, 2026-09-02). A NODE rather than a mode + callback: ManagerApp owns
   * which calculator is showing, and both render the identical control, so
   * passing the rendered switch down keeps one definition instead of two that
   * can drift. Absent when the manager has only one calculator.
   */
  calculatorSwitch?: React.ReactNode;
  /**
   * Payroll's dispatch-lock state, from the SHELL that mounts this calculator.
   *
   * `useDispatchLock` is meant to be mounted once per shell and passed down —
   * its own doc says so — and both calculators were calling it themselves. A
   * fresh hook instance starts UNLOCKED and only flips after its first fetch, so
   * every tab switch remounted the calculator, the "payroll is being processed"
   * banner vanished, and it came back a round-trip later (Kane, 2026-09-02:
   * *"it disappears like it doesn't know that payroll is processing"*). With
   * the shell's already-resolved state handed in, the banner is on screen in
   * the first frame of the mount.
   *
   * Optional only for mount points that have no shell instance (the Payroll
   * Wizard's Readiness modal); there the calculator falls back to its own hook.
   */
  dispatchLock?: PayrollDispatchLockState;
  /** Start focused on this HSL sub-department (filter pre-selected, block
   *  expanded). Used by the Payroll Readiness "fix it from here" modal, which
   *  also scopes `managedDepts` to the same key so only that sub-dept renders. */
  initialFilter?: HslDeptKey;
  /** Where a Mark-Ready/Lock submission originates, recorded in the audit log.
   *  Omit for the manager's own KPI tab (defaults to "manager_kpi" server-side);
   *  the Payroll Wizard Readiness modal passes its own source. */
  submissionSource?: string;
  /**
   * Offer the ONE week after the live batch, so a manager can score it before its
   * Hubstaff file exists (Kane, 2026-09-10 — `hsl-kpi-calculator-2026-07.md`
   * §Scoring the upcoming week). Only the manager's own KPI tab passes it; the
   * Readiness "fix it from here" modal is about the live week and stays pinned.
   */
  offerUpcomingWeek?: boolean;
  /**
   * Top the branch grid with the three insight cards the Departments calculator
   * has (branch spotlight, top earner, Sent to Accounting trend —
   * `kpi-calculator-insights.md` § HSL Branches). Only the manager's own KPI tab
   * passes it; the Readiness modal is a fix-it surface and stays bare.
   */
  showInsights?: boolean;
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Which week the calculator scores: the live batch, or the one after it.
 *
 * The choice lives OUT HERE and the calculator is remounted on it (`key`), rather
 * than `weekStart` being switched in place. Every piece of branch state — entries,
 * `dirty`, the autosave timers, the failed-write hold, the tab-cache seed — belongs
 * to ONE (department, period_start) address, and a debounced write armed on the
 * live week must never fire against the upcoming one. A remount makes that
 * structural: the old instance flushes its own pending edits to its own week on
 * unmount (the existing flush), and the new one starts from nothing.
 */
export default function HslBonusCalculator(props: HslBonusCalculatorProps) {
  const [ahead, setAhead] = useState(false);
  return (
    <HslBonusCalculatorForWeek
      key={ahead ? 'upcoming' : 'live'}
      {...props}
      ahead={props.offerUpcomingWeek ? ahead : false}
      onAheadChange={props.offerUpcomingWeek ? setAhead : undefined}
    />
  );
}

function HslBonusCalculatorForWeek({
  viewerEmail,
  managedDepts,
  isElevated,
  calculatorSwitch,
  dispatchLock: dispatchLockFromShell,
  initialFilter,
  submissionSource,
  ahead,
  onAheadChange,
  showInsights = false,
}: HslBonusCalculatorProps & {
  /** Score the week AFTER the live batch. Fixed for this instance's life. */
  ahead: boolean;
  /** Present only when the upcoming week may be offered. */
  onAheadChange?: (ahead: boolean) => void;
}) {
  // Bind the tab cache to this manager BEFORE any seeding below reads it. Two
  // managers on one machine must never paint each other's branches, and the
  // cache is inert until this runs.
  useKpiCacheIdentity(viewerEmail);

  /**
   * The payroll week the last live resolve produced in this tab, if any.
   *
   * **Paint only.** It picks WHICH cached week to show while the Hubstaff resolve
   * below is in flight; it does not make the week resolved, so nothing becomes
   * writable on the strength of it (see `weekResolved`). If the live answer turns
   * out to be a different week, that is simply a different cache key and the
   * seeded paint is replaced by that week's load.
   *
   * Seeding `weekStart` from it is strictly better than the local-clock guess it
   * replaces: this value is a real Sunday-anchored upload week, and the guess is
   * Monday-anchored — the exact mismatch that stranded rows before.
   */
  const [cachedWeek] = useState<string | null>(() => {
    // The presumed-week cache always holds the LIVE week. Scoring ahead paints
    // the week after it — still paint only; nothing is writable until the live
    // resolve below confirms both.
    const live = getKpiCache<string>(KPI_CACHE_KEYS.presumedWeek('hsl')) ?? null;
    return live && ahead ? nextPayWeek(live).start : live;
  });
  const today = new Date();
  const [weekStart, setWeekStart] = useState(() => cachedWeek ?? isoWeekStart(today));

  /**
   * Bonus Library definitions + assignments (2026-09-22). A bonus assigned to
   * this branch's `hsl:<key>` is scored here as an extra rule and folds into
   * `calculated_bonus` — see `src/lib/hsl-bonus/catalog-bonus.ts` for why that,
   * and not a `bonus_catalog_applied` row.
   *
   * Best-effort: a failed read leaves both empty, so the card scores exactly the
   * schema rules it always has rather than showing columns it cannot price.
   */
  const [catalogBonuses, setCatalogBonuses] = useState<BonusDef[]>([]);
  const [catalogAssignments, setCatalogAssignments] = useState<BonusAssignment[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/bonus-catalog', { cache: 'no-store' });
        const json = (await res.json()) as { bonuses?: BonusDef[]; assignments?: BonusAssignment[] };
        if (cancelled) return;
        setCatalogBonuses(json.bonuses ?? []);
        setCatalogAssignments(json.assignments ?? []);
      } catch {
        /* keep the schema-only card */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Branch configs: the 14 CODE teams plus every DATA sub-team created from
   * Payment Catalog -> Departments -> Edit (2026-09-22). Before this the branch
   * list was `HSL_DEPT_KEYS` alone, so a data sub-team had no card at all — no
   * way to score it, no `hsl_bonus_period_status` row, and nothing for Payroll
   * Readiness to list. See `src/lib/hsl-bonus/data-branch.ts`.
   */
  const builtinSubs = useBuiltinSubs();
  const hslDataSubs = useMemo(() => builtinSubsFor(builtinSubs, 'hogan_smith_law'), [builtinSubs]);
  const branchConfigs = useMemo(() => hslBranchConfigs(hslDataSubs), [hslDataSubs]);
  /** The config for any branch key — code or data. Never index `HSL_DEPTS`
   *  directly in this component: it is undefined for a data branch. */
  const cfgOf = useCallback(
    (key: string): DeptConfig => branchConfigs[key] ?? cfgOf(key as HslDeptKey),
    [branchConfigs],
  );

  /**
   * The catalog bonuses that apply to one person on one branch. Resolved per
   * call rather than memoised across branches: a branch's period_start decides
   * whether a monthly bonus is even offered this week.
   */
  const catalogFor = useCallback(
    (deptKey: HslDeptKey, email: string): HslCatalogBonus[] =>
      hslCatalogBonusesFor({
        subLabel: hslSubDeptLabel(deptKey),
        employeeEmail: email,
        assignments: catalogAssignments,
        bonuses: catalogBonuses,
        periodStart: periodStart(cfgOf(deptKey)),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- periodStart is stable per week
    [catalogAssignments, catalogBonuses, weekStart],
  );

  /** Monthly Library bonuses assigned to a branch that this week does not offer
   *  (`hslCatalogBonusesFor` drops them), so the card can say why they are absent. */
  const catalogHeldFor = useCallback(
    (deptKey: HslDeptKey): BonusDef[] =>
      hslCatalogBonusesHeldThisWeek({
        subLabel: hslSubDeptLabel(deptKey),
        assignments: catalogAssignments,
        bonuses: catalogBonuses,
        periodStart: periodStart(cfgOf(deptKey)),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- periodStart is stable per week
    [catalogAssignments, catalogBonuses, weekStart],
  );

  /**
   * `calcBonus` + the catalog side. EVERY place that recomputes a person's
   * `calculated_bonus` must go through this, or a catalog bonus would be
   * scored on screen and dropped on save (or the reverse).
   */
  const scoreEntry = useCallback(
    (deptKey: HslDeptKey, email: string, kpi: KpiData, isManager: boolean): number => {
      const cfg = cfgOf(deptKey);
      const base = cfg.perEmployee
        ? calcManagerBonus(email, kpi, { periodStart: periodStart(cfg) })
        : calcBonus(kpi, cfg, isManager, { periodStart: periodStart(cfg) });
      return base + calcHslCatalogTotal(kpi, catalogFor(deptKey, email));
    },
    [catalogFor],
  );
  /**
   * Whether `weekStart` is the REAL payroll week (the Hubstaff upload's Sun–Sat
   * range start) rather than the local-clock guess it's seeded with.
   *
   * This matters because (department, period_start) is the only address KPI rows
   * have. The seed above is MONDAY-anchored while every stored key is the
   * upload's SUNDAY, so scoring against an unresolved week reads an empty
   * dept-week and writes rows nobody — no other manager, not Payroll Readiness,
   * not payroll — will ever read back. That has already happened: see
   * `npx tsx scripts/audit-kpi-key-drift.mts` for the stranded Monday-keyed
   * weeks. Both cadences stay gated until this flips true (monthly branches used
   * to key off the calendar month's 1st instead, which never matched what
   * Payroll Readiness reads and left Mark-Ready invisible there forever — see
   * `periodStart` below).
   */
  const [weekResolved, setWeekResolved] = useState(false);
  /** The live batch's Sunday, and the one week after it while no file covers it
   *  (`upcomingWeekFor`). Both null until the resolve below lands. */
  const [liveWeekStart, setLiveWeekStart] = useState<string | null>(null);
  const [upcomingWeekStart, setUpcomingWeekStart] = useState<string | null>(null);
  /** Resolution failed outright (after retries) — say so instead of silently
   *  scoring the wrong week. */
  const [weekError, setWeekError] = useState(false);

  // Alphabetical by display name (Kane, 2026-09-02). Sorted HERE, at the
  // source, so the grid, the overlay's branch rail, the filter dropdown and the
  // load order all agree — `HSL_DEPT_KEYS` is declaration order in `schema.ts`,
  // which is history, not something a manager can predict.
  const visibleDepts = useMemo<HslDeptKey[]>(
    () =>
      (hslBranchKeys(hslDataSubs) as HslDeptKey[])
        // A data branch's grant is `hsl:<key>` exactly like a code team's, so
        // one access rule covers both.
        .filter((k) => canAccessHslDept(managedDepts, k, isElevated))
        .sort((a, b) =>
          (branchConfigs[a]?.name ?? a).localeCompare(branchConfigs[b]?.name ?? b, 'en', { sensitivity: 'base' }),
        ),
    [managedDepts, isElevated, hslDataSubs, branchConfigs],
  );

  /** True when at least one branch painted from the tab cache on this mount. */
  const seededFromCache = useRef(false);

  const [deptState, setDeptState] = useState<AllDeptState>(() => {
    const init = {} as AllDeptState;
    for (const k of hslBranchKeys(hslDataSubs) as HslDeptKey[]) {
      // Seeded from the last visit's raw payload for THIS branch and THIS week,
      // so the numbers are on screen before the three fetches below have even
      // been sent. Two things this deliberately does not do:
      //   - it never sets `dirty`: this payload came out of the database, and a
      //     dirty seed would let merely opening the tab autosave it;
      //   - it never touches `weekResolved`, so nothing here unlocks a write.
      const cached = cachedWeek
        ? getKpiCache<HslBranchPayload>(KPI_CACHE_KEYS.hslBranch(k, cachedWeek))
        : undefined;
      const seeded = cached && cachedWeek
        ? mergeHslBranchPayload(k, cached, cachedWeek)
        : null;
      if (seeded) seededFromCache.current = true;
      init[k] = {
        entries: seeded?.entries ?? [],
        status: seeded?.status ?? 'draft',
        dirty: false,
        saving: false,
        rosterEmails: seeded?.rosterEmails ?? new Set(),
      };
    }
    return init;
  });

  /**
   * When the seeded paint was fetched, for the "as of" line — cleared the moment
   * the live loads settle, so the label is only ever on screen while what is
   * being shown really is the previous visit's data.
   */
  const [cacheAsOf, setCacheAsOf] = useState<number | null>(() => {
    if (!cachedWeek) return null;
    let newest: number | null = null;
    for (const k of hslBranchKeys(hslDataSubs) as HslDeptKey[]) {
      const at = readKpiCacheStamp(KPI_CACHE_KEYS.hslBranch(k, cachedWeek));
      if (at !== undefined && (newest === null || at > newest)) newest = at;
    }
    return newest;
  });

  // Autosave bookkeeping. Scoring persists as the manager types (no Save
  // button), so three things have to be tracked outside render state:
  //  - `deptStateRef` because a debounced write fires from a timer and must send
  //    what is on screen NOW, not what was in the closure when the timer was set;
  //  - `autosaveTimers` so each dept debounces independently;
  //  - `autosaveFailedRef` so a failed write is not re-sent until the manager
  //    changes something (a failure leaves the dept dirty, which would otherwise
  //    re-arm the debounce forever). Identity of the entries object is
  //    the token — every mutation replaces them, so `!==` means "edited since".
  const deptStateRef = useRef<AllDeptState>(deptState);
  deptStateRef.current = deptState;
  const autosaveTimers = useRef<Partial<Record<HslDeptKey, ReturnType<typeof setTimeout>>>>({});
  /** The dept state each pending timer was armed for, so the debounce resets only
   *  when THAT dept changed — not whenever any other dept does. */
  const autosaveArmedRef = useRef<Partial<Record<HslDeptKey, DeptState>>>({});
  const autosaveFailedRef = useRef<Partial<Record<HslDeptKey, { entries: EntryRow[] }>>>({});
  /** Last successful autosave per dept, for the inline "Saved HH:MM" status. */
  const [savedAt, setSavedAt] = useState<Partial<Record<HslDeptKey, number>>>({});
  /** Depts whose last autosave failed — the footer says so instead of a toast
   *  per keystroke, and Mark Ready stays blocked because `dirty` is still set. */
  const [autosaveError, setAutosaveError] = useState<Partial<Record<HslDeptKey, string>>>({});

  const [loadingDepts, setLoadingDepts] = useState<Set<HslDeptKey>>(new Set());
  /**
   * Branches whose load has finished at least once on this mount — success or
   * failure. Grows only; a branch never leaves it.
   *
   * This is the difference between "there is nothing on screen yet" and "the
   * figures you are looking at are being re-checked", and only the first of
   * those is worth telling the manager about. `useLiveRefresh` falls back to a
   * **30-second poll** when Realtime isn't available for these tables, so
   * without this every branch flashed "loading…" twice a minute over figures
   * that were already right there, and the page read as permanently busy
   * (Kane, 2026-09-02: *"I think its polling time to time"* — it is).
   *
   * The fetch itself is untouched. The tab cache is PAINT-only by ruling and
   * carries no skip-fetch flag (pinned by a test in `kpi-cache.ts`), so the way
   * to stop showing a spinner is to stop showing it, never to stop asking the
   * database. Freshness still has a voice: the top bar's "as of HH:MM" chip
   * while cached rows are up, and the Refresh button, which does spin.
   */
  const [settledDepts, setSettledDepts] = useState<Set<HslDeptKey>>(new Set());
  /** Which dept's preview modal is open (null = closed). Mounted at the parent so
   *  it overlays the page rather than nesting inside a single dept block. */
  const [viewingDept, setViewingDept] = useState<HslDeptKey | null>(null);
  const [reopenSubmitting, setReopenSubmitting] = useState(false);
  // Hooks cannot be conditional, so the fallback instance always exists; the
  // shell's state wins whenever it is provided (see the prop's doc).
  const { state: dispatchLockFallback } = useDispatchLock();
  const dispatchLock = dispatchLockFromShell ?? dispatchLockFallback;
  const payrollLocked = dispatchLock.locked;

  // Department navigation: which dept's block is expanded, and the active filter
  // pill. With many HSL branches visible at once a flat stack is unreadable, so
  // "All" shows a collapsed overview and a single dept can be focused.
  const [activeFilter, setActiveFilter] = useState<HslDeptKey | 'all'>(initialFilter ?? 'all');
  /** Cross-branch people search: type a work email (or a name) and only the
   *  branches that score that person stay on screen, expanded and pre-filtered. */
  const [personSearch, setPersonSearch] = useState('');
  /** Which dept's "add external member" modal is open (null = closed). */
  const [addingMemberDept, setAddingMemberDept] = useState<HslDeptKey | null>(null);

  // ── Overlay: open one branch away from the stack ──────────────────────────
  // Same three presentations the Departments calculator offers, so a manager who
  // scores in both surfaces learns the control once.
  const [overlayDept, setOverlayDept] = useState<HslDeptKey | null>(null);
  const [openMode, setOpenMode] = useState<HslOpenMode>('window');
  // The fixed overlay is portalled to <body> to escape any transformed ancestor,
  // which means it can only render after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const reduceMotion = useReducedMotion();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Where focus came from, so closing puts it back rather than dumping the user
  // at the top of the document.
  const overlayOpenerRef = useRef<HTMLElement | null>(null);

  const openOverlay = useCallback((key: HslDeptKey) => {
    overlayOpenerRef.current = document.activeElement as HTMLElement | null;
    setOverlayDept(key);
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlayDept(null);
    // The opener can be gone if the roster re-rendered underneath us.
    if (overlayOpenerRef.current?.isConnected) overlayOpenerRef.current.focus();
    overlayOpenerRef.current = null;
  }, []);

  // Escape closes, and the page behind must not scroll while it's open.
  useEffect(() => {
    if (!overlayDept) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeOverlay();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    overlayRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [overlayDept, closeOverlay]);
  // Recently offboarded people (final bonuses may still be owed) — fetched once
  // and shared by the per-dept Offboarded strips and the add-member modal.
  const { people: offboardedPeople } = useOffboardedPeople(true);
  // Only the ones whose FINAL pay cycle is the week in view — Carla, 2026-09-14:
  // "If I was offboarded today, I should be on the list next week, but then
  // after that I am gone." Bounded at BOTH ends now: a stamp inside
  // [weekStart, weekEnd + one payroll cycle], or hours in the scored week
  // itself. (Monthly branches use the same weekly rule: once the final check is
  // out, nothing can pay a late-scored bonus anyway.) Until the week resolves to
  // a real payroll Sunday, the Monday local-clock seed would filter against the
  // WRONG week — skip scoping until then. See offboarded-week-relevance.ts.
  const offboardedForWeek = useMemo(
    () =>
      offboardedPeople.filter((p) =>
        offboardedRelevantToWeek(p, weekResolved ? weekStart : ''),
      ),
    [offboardedPeople, weekStart, weekResolved],
  );
  // Identity emails of the week-relevant offboarded people, so table rows can
  // tag an added offboarded person ("Offboarded — Last Pay") apart from a
  // plain external member — including entries reloaded from saved rows, where
  // nothing about the original add survives.
  const offboardedEmails = useMemo(() => {
    const s = new Set<string>();
    for (const p of offboardedForWeek) {
      for (const e of [p.hubstaff_email, p.work_email, p.personal_email]) {
        const ce = normEmail(e ?? '');
        if (ce) s.add(ce);
      }
    }
    return s;
  }, [offboardedForWeek]);
  /** Offboarded people attributed to a specific HSL branch: the master list
   *  labels branch members either with the raw `hsl:<key>` slug or with the
   *  branch's display name (e.g. "Callback Team" for the Simple-side branches
   *  this schema hosts). Plain "HSL"/Hogan labels can't be attributed to one
   *  branch — those people stay findable via the Add member search instead. */
  const offboardedByDept = useMemo(() => {
    const m = new Map<HslDeptKey, OffboardedCandidate[]>();
    for (const p of offboardedForWeek) {
      const label = (p.department ?? '').trim().toLowerCase();
      if (!label) continue;
      for (const key of hslBranchKeys(hslDataSubs) as HslDeptKey[]) {
        if (label === `hsl:${key}` || slugifyDeptKey(label) === key) {
          const list = m.get(key) ?? [];
          list.push(p);
          m.set(key, list);
          break;
        }
      }
    }
    return m;
  }, [offboardedForWeek]);

  /** Both cadences key on the SAME Hubstaff-resolved payroll week — the exact
   *  key Payroll Readiness's `hsl_bonus_period_status` / `hsl_bonus_entries`
   *  reads (`weekKeyFromSourceFile` in payroll-readiness.ts). Monthly-cadence
   *  depts used to key on the calendar month's 1st (`isoMonthStart(today)`)
   *  instead — a different, never-matching address space, so Mark Ready on
   *  Collections / Healthcare Team Lead / SSD Medical Records could never clear
   *  in Readiness no matter how many times a manager submitted. `isMonthly` /
   *  `isFinalPayrollWeekOfMonth` already scope monthly depts to the one week a
   *  month, so a single shared key per cadence is correct here, not a
   *  regression. */
  function periodStart(_dept: DeptConfig): string {
    return weekStart;
  }

  function setDept(key: HslDeptKey, patch: Partial<DeptState>) {
    setDeptState((prev) => ({ ...prev, [key]: { ...prev[key]!, ...patch } }));
  }

  // ── External members ───────────────────────────────────────────────────────
  // "Add external member" appends an off-roster person to a dept's calculator.
  // No employee/roster record is created — the saved hsl_bonus_entries row is the
  // single source of truth, so they flow to payroll through the normal
  // autosave → Mark Ready path exactly like a roster member.

  /** Add an off-roster person to `key`. Returns an error to surface, or null. */
  function addMember(key: HslDeptKey, name: string, emailRaw: string): string | null {
    const email = normEmail(emailRaw) ?? '';
    if (!email) return 'A valid email is required.';
    const d = deptState[key];
    if (!d) return 'This department has not finished loading yet.';
    // Render-time gating isn't enough: live refresh can flip the period out of
    // draft while the add modal sits open — an add landing then would never be
    // saved into the entries Accounting reads.
    if (d.status !== 'draft') return 'This period has already been marked — reopen it to make changes.';
    if (d.entries.some((e) => e.employee_email === email)) {
      return 'Someone with this email is already on this calculator.';
    }
    const entry: EntryRow = {
      employee_email: email,
      employee_name: name.trim() || email,
      is_manager: false,
      kpi_data: {},
      calculated_bonus: 0,
    };
    setDeptState((prev) => {
      const cur = prev[key]!;
      const entries = [...cur.entries, entry].sort((a, b) =>
        a.employee_name.localeCompare(b.employee_name),
      );
      return { ...prev, [key]: { ...cur, entries, dirty: true } };
    });
    return null;
  }

  /** Remove a manually-added external member. Always fire the DELETE (it's keyed
   *  by dept+period_start+email and is idempotent): a member added and saved in
   *  the same session has no local `id` yet, so gating on `id` would leave the
   *  saved row behind and it would reappear — still paid — on the next reload. */
  async function removeMember(key: HslDeptKey, email: string) {
    setDeptState((prev) => {
      const cur = prev[key]!;
      return {
        ...prev,
        [key]: { ...cur, dirty: true, entries: cur.entries.filter((e) => e.employee_email !== email) },
      };
    });
    const start = periodStart(cfgOf(key));
    try {
      await fetch(
        `/api/hsl-bonus/entries?dept=${key}&period_start=${start}&email=${encodeURIComponent(email)}`,
        { method: 'DELETE' },
      );
    } catch {
      // best-effort — the local removal is already applied; a DELETE for a row
      // that was never persisted is a harmless no-op.
    }
  }

  // ── Load entries from DB and merge with roster auto-population ─────────────

  /** True when the branch's reads answered (the refresh modal's line); false when they failed. */
  const loadDept = useCallback(async (key: HslDeptKey): Promise<boolean> => {
    const dept = cfgOf(key);
    // A branch's period key is the Hubstaff upload's week — reading before that
    // resolves queries a key nothing was ever saved under, which is what made
    // one manager's scores look empty on another account. Applies to monthly
    // branches too now (see `periodStart`).
    if (!weekResolved) return false;
    const start = periodStart(dept);
    setLoadingDepts((prev) => new Set([...prev, key]));
    try {
      const [entriesRes, statusRes, membersRes] = await Promise.all([
        fetch(`/api/hsl-bonus/entries?dept=${key}&period_start=${start}`, { cache: 'no-store' }),
        fetch(`/api/hsl-bonus/period-status?dept=${key}&period_start=${start}`, { cache: 'no-store' }),
        fetch(`/api/hsl-bonus/team-members?dept=${key}`, { cache: 'no-store' }),
      ]);
      const entriesJson = (await entriesRes.json()) as { rows?: HslBranchPayload['entries'] };
      const statusJson = (await statusRes.json()) as { rows?: { status: BonusStatus }[] };
      const membersJson = (await membersRes.json()) as { rows?: HslMember[] };

      const payload: HslBranchPayload = {
        entries: entriesJson.rows ?? [],
        status: statusJson.rows ?? [],
        members: membersJson.rows ?? [],
      };
      // Cache the RAW payload, keyed on this branch AND this resolved week, so
      // the next mount paints it instantly. Never the derived state: that holds
      // a Set. Written before the state update so a branch whose local work
      // blocks the paint below is still cached for next time.
      setKpiCache(KPI_CACHE_KEYS.hslBranch(key, start), payload);

      setDeptState((prev) => {
        const cur = prev[key]!;
        // Never clobber in-flight local work: refreshAll checks `dirty` when it
        // DISPATCHES, but this fetch can land after the user has since edited or
        // added a member (parent re-renders also re-run the boot effect). Guard
        // at write time so unsaved entries survive any reload path.
        if (cur.dirty || cur.saving) return prev;
        // Same merge the cache seed runs — one derivation, so a seeded branch and
        // a fetched branch can never disagree about what a row is worth.
        const merged = mergeHslBranchPayload(key, payload, start);
        return {
          ...prev,
          [key]: {
            ...cur,
            entries: merged.entries,
            status: merged.status,
            dirty: false,
            rosterEmails: merged.rosterEmails,
          },
        };
      });
      return true;
    } catch {
      // silent — table may be empty on first use
      return false;
    } finally {
      setLoadingDepts((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      // Every later load of this branch is a background re-check over figures
      // already on screen, and says nothing.
      setSettledDepts((prev) => (prev.has(key) ? prev : new Set([...prev, key])));
    }
  }, [weekStart, weekResolved]); // eslint-disable-line react-hooks/exhaustive-deps

  // First-load gate: show a loading screen until every visible dept's initial
  // fetch has settled, so switching to the tab doesn't flash an empty calculator.
  const [loadsSettled, setLoadsSettled] = useState(false);

  /** Branches that are loading for the FIRST time — the only ones with nothing
   *  to show while they wait. Everything else re-checks in silence. */
  const pendingFirstLoad = useMemo(
    () => new Set([...loadingDepts].filter((k) => !settledDepts.has(k))),
    [loadingDepts, settledDepts],
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all(visibleDepts.map((k) => loadDept(k)));
      // Stay on the loading screen until the payroll week is known either way —
      // weekly branches skip their fetch while it's unresolved, so flipping this
      // first would flash an empty calculator that looks like "no scores".
      if (!cancelled && weekResolved) {
        setLoadsSettled(true);
        // Live data is on screen now, so the "as of" line has nothing left to
        // disclose. Clearing it here rather than on the first response keeps it
        // honest for a branch whose own load failed.
        setCacheAsOf(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visibleDepts, loadDept]);

  // `weekError` is handled OUTSIDE that effect, on purpose. It used to be the
  // `|| weekError` half of the condition above, where it could never fire: the
  // resolver sets it only after its three attempts have failed, by which time
  // the effect has already awaited its loads and settled — and it is neither one
  // of that effect's deps nor part of `loadDept`'s identity
  // (`[weekStart, weekResolved]`), so the effect never re-ran to observe it.
  // `booted` stayed false forever and the loading screen became terminal,
  // hiding the very alert that explains it.
  //
  // Derived every render rather than latched from another effect, so it cannot
  // be re-broken by a dependency list. Revealing on the error is safe by
  // construction, not by care: every branch is held on `weekResolved` (still
  // false) at each read and write site, and `kpiAutosaveGate` refuses on the
  // same flag. What appears is the chrome plus the rose alert below.
  // A branch painted from the tab cache already has everything the cards need to
  // mean something, so it reveals without waiting for the round trip — the same
  // question `loadsSettled` answers, answered earlier. It unlocks nothing: the
  // week is still unresolved, so every read and write stays held exactly where
  // it was, and the inputs stay read-only until the live resolve lands
  // (`weekPending` below).
  const booted = kpiCalculatorRevealed({
    dataSettled: loadsSettled || seededFromCache.current,
    weekError,
  });

  // ── Live refresh ───────────────────────────────────────────────────────────
  // Reload every visible dept, but skip any with unsaved local edits (`dirty`)
  // or an in-flight save so another scorer's change can't clobber work in
  // progress. Used by both the manual Refresh button and the live subscription.
  const [refreshing, setRefreshing] = useState(false);
  // `tracker` comes only from the toolbar Refresh (docs/features/table-refresh-progress.md):
  // the branches are one line in the refresh modal, failed when any could not be read.
  const refreshAll = useCallback(async (tracker?: RefreshTracker) => {
    const keys = visibleDepts.filter((k) => {
      const d = deptState[k];
      return !(d?.dirty || d?.saving);
    });
    const held = visibleDepts.length - keys.length;
    await trackRead(
      tracker,
      'branches',
      async () => {
        if (tracker && !weekResolved) throw new Error('The payroll week is not confirmed yet, so no scores were read.');
        const loaded = await Promise.all(keys.map((k) => loadDept(k)));
        const failed = keys.filter((_, i) => !loaded[i]);
        if (tracker && failed.length > 0) throw new Error(`Couldn't read the scores for ${failed.map((k) => cfgOf(k).name).join(', ')}.`);
        return keys.length;
      },
      (n) => `Read this week's scores for ${countOf(n, 'branch', 'branches')}${held > 0 ? ` · ${countOf(held, 'branch', 'branches')} with unsaved work left as it is` : ''}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDepts, deptState, loadDept, weekResolved]);

  const manualRefresh = useCallback(async (tracker?: RefreshTracker) => {
    setRefreshing(true);
    try {
      await refreshAll(tracker);
    } finally {
      setRefreshing(false);
    }
  }, [refreshAll]);
  const toolbarRefresh = useTableRefresh({
    subject: 'HSL scores',
    steps: [{ id: 'branches', label: `Reading this week's scores for ${countOf(visibleDepts.length, 'branch', 'branches')}` }],
  });

  // See teammates' scoring as it lands: watch the entry + status tables and
  // re-pull (debounced). Falls back to a 30s poll + tab-focus refresh when
  // Realtime isn't available for these tables.
  useLiveRefresh({
    tables: ['hsl_bonus_entries', 'hsl_bonus_period_status'],
    onRefresh: refreshAll,
    channel: 'hsl-bonus-calc-live',
    enabled: visibleDepts.length > 0,
  });
  // The binding above never fires for the anon browser; the route that wrote
  // the status / published entry broadcasts instead. Same `refreshAll`, so a
  // dirty or saving branch is still skipped.
  useKpiLive({ onChange: () => void refreshAll(), enabled: visibleDepts.length > 0 });

  // Pin the KPI week to the Hubstaff batch accounting is dispatching — the
  // Initialized (is_current) upload, NOT merely the newest file. The public
  // endpoint returns newest-first, so we resolve the current batch the same way
  // the Payroll Wizard does (pickCurrentSourceFile) to keep the manager's KPI
  // week in lock-step with the week accounting processes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Retry before giving up: a cold start or a blip here used to leave the
      // week silently wrong for the whole session.
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          const res = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
          const json = (await res.json()) as HubstaffSourceFilesResponse;
          const latest = pickCurrentSourceFile(json.uploads, json.files);
          const range = latest ? parseDateRangeFromFilename(latest) : null;
          if (range) {
            const iso = isoDate(range.start);
            // Every uploaded week, so the upcoming one is offered only while no
            // file covers it — the same list `usePayWeeks` builds.
            const uploaded: PayWeek[] = [];
            for (const f of [...(json.uploads?.map((u) => u.source_file ?? '') ?? []), ...(json.files ?? [])]) {
              const r = f ? parseDateRangeFromFilename(f) : null;
              if (r) uploaded.push({ start: isoDate(r.start), end: weekEndFromStart(isoDate(r.start)) });
            }
            // Live Sunday + 7 — never the clock (`use-pay-weeks.ts`).
            const next = upcomingWeekFor(iso, uploaded);
            if (cancelled) return;
            setLiveWeekStart(iso);
            setUpcomingWeekStart(next?.start ?? null);
            // Remember the LIVE week, so the next mount knows which week's
            // cached branches it may paint while this resolve re-runs.
            setKpiCache(KPI_CACHE_KEYS.presumedWeek('hsl'), iso);
            if (ahead) {
              // Its file landed since the choice was made: it is the live week
              // now (or already past). Go back to live rather than score a week
              // this picker no longer offers.
              if (!next) {
                onAheadChange?.(false);
                return;
              }
              setWeekStart(next.start);
            } else {
              setWeekStart(iso);
            }
            setWeekResolved(true);
            setWeekError(false);
            return;
          }
        } catch {
          /* fall through to the retry / error below */
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
      // Out of attempts: NEVER fall back to the local-clock week — that writes
      // rows under a key nothing reads. Weekly branches stay blocked and the
      // banner tells the scorer to reload.
      if (!cancelled) setWeekError(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save entries to DB ─────────────────────────────────────────────────────

  /**
   * Persist a dept's entries. Called by the autosave debounce (`silent`) and by
   * the flush on unmount / page-hide; there is no Save button any more.
   *
   * Reads from `deptStateRef` rather than the render closure because a debounced
   * call must send what is on screen when it fires. Returns whether it wrote.
   */
  async function saveDept(key: HslDeptKey, opts?: { silent?: boolean }): Promise<boolean> {
    const d = deptStateRef.current[key]!;
    const dept = cfgOf(key);
    // Refuse rather than strand the work: an unresolved week would write this
    // dept-week under a key no reader asks for (invisible scores, and a duplicate
    // if it's re-scored later under the right key).
    if (!weekResolved) {
      toast.error('Payroll week not confirmed', {
        description: 'Reload the page before saving — scores saved now would not be visible to anyone else.',
      });
      return false;
    }
    // The route rejects an empty array (400). Nothing to write is not an error.
    if (d.entries.length === 0) return false;
    const start = periodStart(dept);
    const end = periodEnd(dept, start);
    // Token for the retry hold: whatever we are about to send.
    const attempted = { entries: d.entries };

    setDept(key, { saving: true });
    let wrote = false;
    try {
      const entries = d.entries.map((e) => ({
        department: key,
        period_type: dept.cadence,
        period_start: start,
        period_end: end,
        employee_email: e.employee_email,
        employee_name: e.employee_name,
        is_manager: e.is_manager,
        kpi_data: e.kpi_data,
        calculated_bonus: e.calculated_bonus,
        created_by: viewerEmail ?? undefined,
      }));

      const res = await fetch('/api/hsl-bonus/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const json = (await res.json()) as { error?: string; saved?: number };
      if (!res.ok) throw new Error(json.error ?? 'Save failed');

      // Only clear `dirty` when nothing was edited while the write was in
      // flight — otherwise the newer keystrokes would look persisted and both
      // the Mark Ready gate and the next autosave would skip them.
      const latest = deptStateRef.current[key]!;
      const superseded = latest.entries !== attempted.entries;
      if (!superseded) setDept(key, { dirty: false });
      delete autosaveFailedRef.current[key];
      setAutosaveError((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setSavedAt((prev) => ({ ...prev, [key]: Date.now() }));
      wrote = true;
      if (!opts?.silent) {
        toast.success(`${dept.name} saved`, { description: `${json.saved ?? 0} entries updated` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      // Hold this exact state back from the debounce so a failure can't turn
      // into a retry storm; any further edit replaces the token and re-arms it.
      autosaveFailedRef.current[key] = attempted;
      setAutosaveError((prev) => ({ ...prev, [key]: msg }));
      // One toast per failed attempt — not per keystroke, since the hold above
      // means the next attempt only happens after the manager edits again.
      toast.error(`${dept.name} — not saved`, { description: msg });
    } finally {
      setDept(key, { saving: false });
    }
    return wrote;
  }

  // ── Autosave ───────────────────────────────────────────────────────────────
  // Every field a manager enters persists on its own, ~1s after they stop
  // typing. `kpiAutosaveGate` carries every refusal the old Save button had
  // (draft-only, week-resolved, not mid-payroll-run, no double-write, no retry
  // storm) — see src/lib/manager/kpi-autosave.ts. Submission is untouched:
  // Mark Ready is still a deliberate act, because the period-status row is what
  // actually tells Accounting the week is done.
  useEffect(() => {
    const timers = autosaveTimers.current;
    for (const key of visibleDepts) {
      const d = deptState[key];
      if (!d) continue;
      const failed = autosaveFailedRef.current[key];
      const gate = kpiAutosaveGate({
        loaded: booted && !loadingDepts.has(key),
        weekResolved,
        editable: d.status === 'draft',
        payrollLocked,
        saving: d.saving,
        dirty: d.dirty,
        // HSL never seeds `dirty` on load — `loadDept` always writes
        // `dirty: false`, so anything dirty here was entered by a person.
        seededOnly: false,
        failedUnchanged:
          !!failed && failed.entries === d.entries,
      });
      if (!gate.save) {
        const existing = timers[key];
        if (existing) clearTimeout(existing);
        delete timers[key];
        delete autosaveArmedRef.current[key];
        continue;
      }
      // The debounce is PER DEPT. `deptState` is one object, so editing dept A
      // re-runs this loop for dept B too — blindly re-arming here would let a
      // manager working in A starve B's pending write for as long as they keep
      // typing. Only re-arm when THIS dept's own state changed.
      if (!shouldRearmAutosave(autosaveArmedRef.current[key], d, !!timers[key])) continue;
      const existing = timers[key];
      if (existing) clearTimeout(existing);
      autosaveArmedRef.current[key] = d;
      timers[key] = setTimeout(() => {
        delete timers[key];
        void saveDept(key, { silent: true });
      }, KPI_AUTOSAVE_DEBOUNCE_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deptState, visibleDepts, booted, loadingDepts, weekResolved, payrollLocked]);

  /** Write out anything still pending. Held in a ref so the unmount cleanup runs
   *  the LATEST closure — an empty-dep effect would capture `weekResolved` from
   *  the first render, when it is still false, and refuse to save. */
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    const timers = autosaveTimers.current;
    for (const k of Object.keys(timers) as HslDeptKey[]) {
      const t = timers[k];
      if (t) clearTimeout(t);
      delete timers[k];
      delete autosaveArmedRef.current[k];
    }
    const st = deptStateRef.current;
    for (const key of Object.keys(st) as HslDeptKey[]) {
      const d = st[key];
      if (!d || !d.dirty || d.saving || d.status !== 'draft') continue;
      if (payrollLocked || !weekResolved || d.entries.length === 0) continue;
      void saveDept(key, { silent: true });
    }
  };

  // Losing the last keystroke would be worse than no autosave at all: ManagerApp
  // UNMOUNTS this calculator when the manager leaves the tab, taking the pending
  // debounce with it. Flush when the tab is hidden and on unmount.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushRef.current();
    };
    const onPageHide = () => flushRef.current();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      flushRef.current();
    };
  }, []);

  /**
   * Switch between the live week and the upcoming one. The parent remounts this
   * calculator on the choice, so everything on screen belongs to the week it was
   * typed into — which is why pending edits are written HERE, awaited, before the
   * switch: the unmount flush is fire-and-forget, and a failed write would vanish
   * with the instance. Any edit that cannot be written keeps the manager on this
   * week instead (the per-card Refresh precedent in DeptBonusCalculator).
   */
  const [switchingWeek, setSwitchingWeek] = useState(false);
  async function switchWeek(nextAhead: boolean) {
    if (!onAheadChange || nextAhead === ahead || switchingWeek) return;
    const st = deptStateRef.current;
    if (visibleDepts.some((k) => st[k]?.saving)) {
      toast.info('Saving your edits — switch weeks again in a moment.');
      return;
    }
    const pending = visibleDepts.filter((k) => {
      const d = st[k];
      return !!d && d.dirty && d.status === 'draft' && d.entries.length > 0;
    });
    setSwitchingWeek(true);
    try {
      const timers = autosaveTimers.current;
      for (const k of pending) {
        const t = timers[k];
        if (t) clearTimeout(t);
        delete timers[k];
        delete autosaveArmedRef.current[k];
      }
      const results = pending.length === 0 || payrollLocked || !weekResolved
        ? pending.map(() => pending.length === 0)
        : await Promise.all(pending.map((k) => saveDept(k, { silent: true })));
      if (results.some((ok) => !ok)) {
        toast.error('Week not switched', {
          description: 'Your latest edits on this week could not be saved yet, so you were left on it. Check your connection and try again.',
        });
        return;
      }
      onAheadChange(nextAhead);
    } finally {
      setSwitchingWeek(false);
    }
  }

  async function setStatus(key: HslDeptKey, next: BonusStatus): Promise<boolean> {
    const dept = cfgOf(key);
    // Same reason as saveDept: a status row on an unresolved week is a dept-week
    // Readiness will never see, so the branch would read "Pending" forever.
    if (!weekResolved) {
      toast.error('Payroll week not confirmed', {
        description: 'Reload the page and try again — this submission would not reach Accounting.',
      });
      return false;
    }
    const start = periodStart(dept);
    try {
      const res = await fetch('/api/hsl-bonus/period-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department: key,
          period_type: dept.cadence,
          period_start: start,
          period_end: periodEnd(dept, start),
          status: next,
          locked_by: viewerEmail ?? undefined,
          source: submissionSource,
          // Wording only, on Accounting's kpi.published card. No gate reads it.
          ahead_of_hubstaff: ahead,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Status update failed');
      setDept(key, { status: next });
      return true;
    } catch (e) {
      toast.error('Status update failed', {
        description: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  async function markReady(key: HslDeptKey) {
    // The guard stays — a period must never go Ready carrying unwritten numbers.
    // With autosave there is no button to point at, so flush instead of scolding:
    // this only ever runs when Mark Ready is hit inside the debounce window or
    // after a failed write.
    if (deptStateRef.current[key]!.dirty) {
      const saved = await saveDept(key, { silent: true });
      if (!saved || deptStateRef.current[key]!.dirty) {
        toast.error('Changes not saved yet', {
          description: 'Your latest edits could not be written, so the period was left in draft. Check your connection and try again.',
        });
        return;
      }
    }
    const ok = await setStatus(key, 'ready');
    if (ok) {
      toast.success(`${cfgOf(key).name} marked ready`, {
        description: 'Visible to Accounting · PayrollWizard.',
      });
      setViewingDept(key);
    }
  }

  async function reopenToDraft(key: HslDeptKey) {
    setReopenSubmitting(true);
    const ok = await setStatus(key, 'draft');
    setReopenSubmitting(false);
    if (ok) {
      toast.success(`${cfgOf(key).name} reopened`, {
        description: 'Back to draft — make edits and Mark Ready when done.',
      });
      setViewingDept(null);
    }
  }

  function exportCsv() {
    const headers = ['Department', 'Period', 'Employee', 'Email', 'Bonus (PHP)', 'Status'];
    const rows: string[] = [];
    for (const key of visibleDepts) {
      const dept = cfgOf(key);
      const d = deptState[key]!;
      const period = periodLabel(dept, periodStart(dept));
      for (const e of d.entries) {
        rows.push([
          dept.name,
          period,
          e.employee_name,
          e.employee_email,
          e.calculated_bonus.toFixed(2),
          d.status,
        ].map((v) => `"${v.replace(/"/g, '""')}"`).join(','));
      }
    }
    const csv = '﻿' + [headers.map((h) => `"${h}"`).join(','), ...rows].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `hsl-bonus-${isoWeekStart(new Date())}.csv`;
    a.click();
  }

  const grandTotal = useMemo(
    () => visibleDepts.reduce((sum, k) => sum + deptState[k]!.entries.reduce((s, e) => s + e.calculated_bonus, 0), 0),
    [deptState, visibleDepts],
  );

  /** Branches signed off for the week — `ready` or already `locked`. */
  const readyBranches = useMemo(
    () => visibleDepts.filter((k) => {
      const st = deptState[k]?.status;
      return st === 'ready' || st === 'locked';
    }).length,
    [visibleDepts, deptState],
  );

  const totalPeople = useMemo(
    () => visibleDepts.reduce((sum, k) => sum + deptState[k]!.entries.length, 0),
    [deptState, visibleDepts],
  );

  /** The branches the insight cards cover: every visible branch that scores. A
   *  roster-only `noKpi` team has no bonus to average, and the server refuses it
   *  anyway (`scopeHslInsightBranchKeys`). */
  const insightBranches = useMemo(() => visibleDepts.filter((k) => !cfgOf(k).noKpi), [visibleDepts, cfgOf]);
  const insightLabel = useCallback((k: string) => cfgOf(k).name, [cfgOf]);
  const insightColor = useCallback((k: string) => cfgOf(k).color, [cfgOf]);

  const multiDept = visibleDepts.length > 1;

  // If the active filter points at a dept that's no longer visible, fall back.
  useEffect(() => {
    if (activeFilter !== 'all' && !visibleDepts.includes(activeFilter)) {
      setActiveFilter('all');
    }
  }, [activeFilter, visibleDepts]);

  // Branches that contain someone matching the people search. Entries are keyed
  // on the work email, so pasting a work address finds the person directly; the
  // display name matches too.
  const personQuery = personSearch.trim().toLowerCase();
  const personHitDepts = useMemo<HslDeptKey[]>(() => {
    if (!personQuery) return [];
    return visibleDepts.filter((k) =>
      (deptState[k]?.entries ?? []).some(
        (e) =>
          e.employee_name.toLowerCase().includes(personQuery) ||
          e.employee_email.toLowerCase().includes(personQuery),
      ),
    );
  }, [personQuery, visibleDepts, deptState]);

  /** Options for the branch filter dropdown. Each branch carries its scored
   *  headcount, which is what the old pill rail's count badge showed. */
  const branchFilterOptions = useMemo(
    () => [
      { value: 'all' as const, label: `All branches · ${visibleDepts.length}` },
      ...visibleDepts.map((k) => ({
        value: k,
        label: `${cfgOf(k).name} · ${deptState[k]?.entries.length ?? 0}`,
      })),
    ],
    [visibleDepts, deptState],
  );

  const filteredDepts = useMemo<HslDeptKey[]>(() => {
    // A people search spans every branch — it outranks the focus pill, otherwise
    // you'd have to already know which branch the person sits in.
    if (personQuery) return personHitDepts;
    return activeFilter === 'all' ? visibleDepts : visibleDepts.filter((k) => k === activeFilter);
  }, [personQuery, personHitDepts, activeFilter, visibleDepts]);

  /** One department block. Rendered inline in the stack and again inside the
   *  overlay; `surface` keeps the two mounts from sharing React state (an
   *  overlay with the same key would inherit the inline block's scroll, page
   *  and open team) and decides which chrome the block wears. */
  function renderDeptBlock(key: HslDeptKey, surface: 'inline' | 'overlay') {
    const inline = surface === 'inline';
    return (
          <DeptBlock
            key={`${surface}-${key}`}
            chromeless={!inline}
            onOpen={inline ? () => openOverlay(key) : undefined}
            deptKey={key}
            state={deptState[key]!}
            loading={pendingFirstLoad.has(key)}
            searchSeed={personSearch}
            periodStartStr={periodStart(cfgOf(key))}
            catalogFor={(email) => catalogFor(key, email)}
            catalogHeld={catalogHeldFor(key)}
            cfgOf={cfgOf}
            onKpiChange={(email, kpiKey, val) => {
              setDeptState((prev) => {
                const d = prev[key]!;
                const next = d.entries.map((e) => {
                  if (e.employee_email !== email) return e;
                  const newKpi = { ...e.kpi_data, [kpiKey]: val };
                  return {
                    ...e,
                    kpi_data: newKpi,
                    // Managers dept sums per-manager components; others use the
                    // uniform rule engine. `scoreEntry` adds the catalog side.
                    calculated_bonus: scoreEntry(key, email, newKpi, e.is_manager),
                  };
                });
                return { ...prev, [key]: { ...d, entries: next, dirty: true } };
              });
            }}
            rosterEmails={deptState[key]!.rosterEmails}
            offboardedEmails={offboardedEmails}
            onAddMember={() => setAddingMemberDept(key)}
            offboardedSuggestions={(offboardedByDept.get(key) ?? []).filter((p) => {
              const emailTaken = [p.hubstaff_email, p.work_email, p.personal_email].some((e) => {
                const ce = normEmail(e ?? '');
                return !!ce && deptState[key]!.entries.some((en) => en.employee_email === ce);
              });
              // Name check too: an earlier add may be keyed under a bridged
              // email the server no longer reports (the Hubstaff window slides
              // weekly) — without it the same person re-surfaces as addable.
              const pName = p.name.trim().toLowerCase();
              const nameTaken = deptState[key]!.entries.some(
                (en) => en.employee_name.trim().toLowerCase() === pName,
              );
              return !emailTaken && !nameTaken;
            })}
            onQuickAddOffboarded={(c) => {
              // HSL keys strictly on work email (see HslAddMemberModal's
              // candidateEmail) — the Hubstaff login IS the work email here,
              // and it's the only key payroll can resolve for an off-roster
              // person, so hubstaff-first with no personal fallback.
              const email = offboardedAddEmail(c, false);
              if (!email) return 'No work email on file — HSL scoring keys on work email.';
              return addMember(key, c.name, email);
            }}
            onRemoveMember={(email) => void removeMember(key, email)}
            savedAtMs={savedAt[key]}
            autosaveError={autosaveError[key]}
            onMarkReady={() => void markReady(key)}
            onMarkUnready={() => void reopenToDraft(key)}
            onView={() => setViewingDept(key)}
            payrollLocked={payrollLocked}
            weekPending={!weekResolved && !weekError}
            markUnreadySubmitting={reopenSubmitting}
          />
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (visibleDepts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
        <Users className="h-10 w-10 text-zinc-300 dark:text-zinc-700" aria-hidden />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          No HSL bonus departments assigned to you.
        </p>
        <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
          Ask an admin to assign you to one or more HSL sub-departments under
          Roles &amp; permissions.
        </p>
      </div>
    );
  }

  if (!booted) {
    return (
      <KpiCalculatorLoading
        variant="hsl"
        calculatorSwitch={calculatorSwitch}
        title={
          isElevated
            ? 'All Departments'
            : visibleDepts.length === 1
              ? cfgOf(visibleDepts[0]!).name
              : 'My Departments'
        }
        cards={visibleDepts.length}
        // The insight row's own gate, minus the Sunday check: before the week
        // resolves `weekStart` is the Monday-anchored seed, and `booted` waits
        // on the resolved week anyway.
        insights={showInsights && insightBranches.length > 0}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-col bg-gradient-to-b from-white via-blue-50/20 to-white text-zinc-900 dark:from-black dark:via-blue-950/15 dark:to-black dark:text-zinc-100">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex flex-col gap-2.5 border-b border-zinc-200/80 bg-white/90 px-5 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              KPI Calculator · HSL
            </p>
            <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {isElevated ? 'All Departments' : visibleDepts.length === 1 ? cfgOf(visibleDepts[0]!).name : 'My Departments'}
              <span className="ml-2 font-mono text-xs font-normal text-zinc-500">
                week of {weekStart}
              </span>
              {ahead && (
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 align-middle font-mono text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  upcoming
                </span>
              )}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {/* How many branches are signed off. First in the cluster on both
                calculators — it is the thing a manager opens this tab to check. */}
            <KpiReadinessChip ready={readyBranches} total={visibleDepts.length} />
            {onAheadChange && liveWeekStart && (ahead || upcomingWeekStart) && (
              <HslWeekSwitch
                ahead={ahead}
                liveWeekStart={liveWeekStart}
                upcomingWeekStart={ahead ? weekStart : upcomingWeekStart}
                busy={switchingWeek}
                onChange={(next) => void switchWeek(next)}
              />
            )}
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">Total</span>
              <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                <AnimatedPeso amount={grandTotal} />
              </span>
              <span className="font-mono text-[10px] text-zinc-500">{totalPeople} ppl</span>
            </div>
            {/* Sets how the next "Open" presents; also switchable from inside
                the overlay, so the choice is never a dead end. */}
            <ViewSwitch mode={openMode} onChange={setOpenMode} />
            {/* What is on screen right now is the previous visit's data, still
                being re-pulled. Say when it was fetched rather than let a figure
                that another scorer has since changed pass for live. Neutral, not
                amber — amber is reserved for warnings. No spinner either: the
                timestamp is the whole message, and an icon turning forever beside
                it made a finished page look like it was polling (Kane,
                2026-09-02). The Refresh button still spins, because that one is
                answering a click. */}
            {cacheAsOf !== null && (
              <span
                className="hidden items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-[10px] text-zinc-500 shadow-sm sm:flex dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400"
                title="Showing the scores this tab already had. Reloading from the database now."
              >
                as of{' '}
                {new Date(cacheAsOf).toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => toolbarRefresh.run((t) => manualRefresh(t))}
              disabled={refreshing || toolbarRefresh.running}
              title="Reload scores (also updates live as teammates edit)"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            {toolbarRefresh.dialog}
            {isElevated && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={exportCsv}
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
            )}
          </div>
        </div>

        {/* The payroll week couldn't be confirmed from the Hubstaff upload, so
            every branch is held back rather than scored against a guessed
            week key (which is invisible to everyone else — see `weekResolved`). */}
        {weekError && (
          <div
            role="alert"
            className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-200"
          >
            <span className="font-semibold">Couldn&apos;t confirm the payroll week.</span> All
            branches are paused — anything scored now would be saved under the wrong week and
            wouldn&apos;t be visible to Accounting or the other managers. Reload the page to try
            again.
          </div>
        )}

        {/* Scoring ahead of the Hubstaff report. Wording only — no gate reads
            `ahead` (hsl-kpi-calculator-2026-07.md §Scoring the upcoming week). */}
        {ahead && weekResolved && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
            <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
            <span className="font-semibold">Scoring ahead: week of {fmtWeekRange(weekStart)}.</span>
            <span className="opacity-80">
              No Hubstaff report for this week yet{liveWeekStart ? ` (the live week is ${fmtWeekRange(liveWeekStart)})` : ''}.
              Bonuses you enter are saved under this week and will be paid with it once its report is
              uploaded. Mark Ready or Lock when you are done — Accounting is notified.
            </span>
            <button
              type="button"
              onClick={() => void switchWeek(false)}
              disabled={switchingWeek}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-900/40"
            >
              <Zap className="h-3 w-3" /> Back to live
            </button>
          </div>
        )}

        {/* Branch filter + the cross-branch people search (find someone by work
            email). The filter was a rail of one pill per branch; it wrapped to
            three rows for a manager with a dozen of them and pushed the branches
            themselves below the fold, so it collapses to a single dropdown
            (Kane, 2026-09-02). The rail's headcounts survive as the option
            labels, and the menu is portalled so the sticky, blurred top bar
            can't clip it. */}
        {(multiDept || calculatorSwitch) && (
          <div className="flex flex-wrap items-center gap-2">
            {calculatorSwitch}
            {multiDept && (
            <div className="relative w-full max-w-[260px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                type="search"
                value={personSearch}
                onChange={(e) => setPersonSearch(e.target.value)}
                placeholder="Find a person by work email…"
                aria-label="Find a person across branches by name or work email"
                title="Type a work email or name — only the branches scoring that person stay on screen"
                className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs text-zinc-900 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-200 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100"
              />
            </div>
            )}
            {multiDept && (
            <SmoothSelect
              value={personQuery ? 'all' : activeFilter}
              options={branchFilterOptions}
              // Picking a branch ends the cross-branch search — the two filters
              // would otherwise fight over what's on screen.
              onChange={(v) => {
                setPersonSearch('');
                setActiveFilter(v as HslDeptKey | 'all');
              }}
              aria-label="Filter branches"
              searchable={visibleDepts.length > 8}
              searchPlaceholder="Find a branch…"
              portal
              className="w-full max-w-[260px] sm:w-auto sm:min-w-[15rem]"
              triggerClassName="h-8 rounded-md"
            />
            )}
          </div>
        )}

        {personQuery && (
          <p className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            {personHitDepts.length === 0
              ? `No one matches “${personSearch.trim()}” in your branches.`
              : `Matched in ${personHitDepts.length} ${personHitDepts.length === 1 ? 'branch' : 'branches'}: ${personHitDepts.map((k) => cfgOf(k).name).join(', ')}`}
          </p>
        )}
      </div>

      {/* Payroll processing banner — the employee dashboard's, with its sweep
          line, so "payroll is running" looks the same on every surface in the
          app (Kane, 2026-09-02). Not dismissible here: on this calculator the
          lock changes what the manager can do. */}
      <PayrollLockBanner
        state={dispatchLock}
        detail="Mark ready and unready are paused until processing is complete."
        dismissible={false}
      />

      {/* Insight cards — the Departments calculator's three, in the same slot:
          read-only, below the banner, above the grid. Held until the week is a
          real Sunday (the local-clock seed is Monday-anchored and no row is filed
          under it). `liveKey` moves when a figure on the grid does, and the cards
          refetch once the burst settles. */}
      {showInsights && isSundayIso(weekStart) && insightBranches.length > 0 && (
        <KpiInsightCards
          calculator="hsl"
          depts={insightBranches}
          week={weekStart}
          labelFor={insightLabel}
          colorFor={insightColor}
          liveKey={`${readyBranches}:${Math.round(grandTotal)}`}
          refreshing={refreshing}
        />
      )}

      {/* Branches. A manager with one branch gets the scoring surface directly —
          a one-row list you have to click through would be pure ceremony. Anyone
          with several gets the list, and picks one to open. */}
      <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
        {multiDept ? (
          <HslBranchList
            cfgOf={cfgOf}
            deptKeys={filteredDepts}
            state={deptState}
            pendingFirstLoad={pendingFirstLoad}
            periodStart={periodStart}
            matchedBySearch={personQuery ? new Set(personHitDepts) : undefined}
            onOpen={openOverlay}
          />
        ) : (
          filteredDepts.map((key) => renderDeptBlock(key, 'inline'))
        )}
      </div>

      {/* Read-only preview modal — opens on View button click. Reopen flips the
          period back to draft so the manager can edit again. */}
      <HslBonusReadyPreview
        open={viewingDept !== null}
        dept={viewingDept ? cfgOf(viewingDept) : null}
        status={
          viewingDept && deptState[viewingDept]!.status !== 'draft'
            ? (deptState[viewingDept]!.status as 'ready' | 'locked')
            : 'ready'
        }
        periodLabel={
          viewingDept
            ? periodLabel(cfgOf(viewingDept), periodStart(cfgOf(viewingDept)))
            : ''
        }
        entries={viewingDept ? deptState[viewingDept]!.entries : []}
        reopenSubmitting={reopenSubmitting}
        onReopen={() => viewingDept && void reopenToDraft(viewingDept)}
        onClose={() => setViewingDept(null)}
      />

      {/* Add-external-member modal — search the Global Master List and pick. */}
      <AnimatePresence>
        {addingMemberDept && (
          <HslAddMemberModal
            deptName={cfgOf(addingMemberDept).name}
            color={cfgOf(addingMemberDept).color}
            offboarded={offboardedForWeek}
            onAdd={(name, email) => addMember(addingMemberDept, name, email)}
            onClose={() => setAddingMemberDept(null)}
          />
        )}
      </AnimatePresence>

      {/* Branch overlay — portalled to <body> so a transformed ancestor (the
          Payroll Readiness modal mounts this component inside one) can't clip
          or re-anchor a `fixed` panel. */}
      {mounted &&
        createPortal(
          <AnimatePresence>
            {overlayDept && (
              <motion.button
                key="hsl-scrim"
                type="button"
                aria-label="Close branch"
                onClick={closeOverlay}
                className="fixed inset-0 z-[60] cursor-default bg-zinc-950/55 backdrop-blur-[2px] dark:bg-black/70"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.28, ease: OVERLAY_EASE }}
              />
            )}
            {overlayDept && (
              <motion.div
                key="hsl-panel"
                // A layer, not the panel. Centring lives here as flexbox so the
                // panel's own transform is free for the entrance — the earlier
                // version centred with translate(-50%,-50%) and had to bake that
                // offset into every keyframe, which forced a per-mode key and
                // remounted the whole branch on every mode switch (losing the
                // open team, the page and the roster selection).
                className={cn(
                  'pointer-events-none fixed z-[61] flex',
                  openMode === 'full' && 'inset-0',
                  openMode === 'window' && 'inset-0 items-center justify-center p-4 sm:p-6',
                  openMode === 'half' && 'inset-y-0 right-0',
                )}
                initial={reduceMotion ? false : 'hidden'}
                animate="shown"
                exit={reduceMotion ? 'flat' : 'hidden'}
              >
                <motion.div
                  ref={overlayRef}
                  tabIndex={-1}
                  role="dialog"
                  aria-modal="true"
                  aria-label={`${cfgOf(overlayDept).name} KPI calculator`}
                  variants={PANEL_VARIANTS[openMode]}
                  transition={{ duration: openMode === 'half' ? 0.42 : 0.36, ease: OVERLAY_EASE }}
                  className={cn(
                    'pointer-events-auto flex flex-col overflow-hidden bg-white outline-none dark:bg-zinc-950',
                    openMode === 'full' && 'h-full w-full',
                    openMode === 'window' &&
                      'h-full max-h-[900px] w-full max-w-[1180px] rounded-2xl border border-zinc-200 shadow-2xl dark:border-zinc-800',
                    openMode === 'half' &&
                      'h-full w-[min(920px,92vw)] border-l border-zinc-200 shadow-2xl dark:border-zinc-800',
                  )}
                  style={{ borderTop: `3px solid ${cfgOf(overlayDept).color}` }}
                >
                <div className="flex flex-none flex-wrap items-center gap-3 border-b border-zinc-200 bg-zinc-50/80 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
                  <p className="min-w-0 truncate font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
                    KPI Calculator · HSL · week of {weekStart}
                  </p>
                  <div className="ml-auto flex items-center gap-2">
                    <ViewSwitch mode={openMode} onChange={setOpenMode} compact />
                    <button
                      type="button"
                      onClick={closeOverlay}
                      aria-label="Close branch"
                      title="Close (Esc)"
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>

                <div className="flex min-h-0 flex-1">
                  {/* Branch rail. Full screen has the width to spare, and jumping
                      between branches without closing is the whole point of it. */}
                  {openMode === 'full' && multiDept && (
                    <aside className="hidden w-56 flex-none flex-col overflow-y-auto border-r border-zinc-200 bg-zinc-50/60 p-2 dark:border-zinc-800 dark:bg-zinc-900/30 md:flex">
                      {visibleDepts.map((k) => {
                        const on = k === overlayDept;
                        const st = deptState[k]!;
                        return (
                          <button
                            key={k}
                            type="button"
                            onClick={() => setOverlayDept(k)}
                            aria-current={on ? 'true' : undefined}
                            className={cn(
                              'mb-1 flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500',
                              on
                                ? 'border-zinc-300 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900'
                                : 'border-transparent hover:bg-white/70 dark:hover:bg-zinc-900/50',
                            )}
                          >
                            <span
                              aria-hidden
                              className="h-2 w-2 flex-none rounded-full"
                              style={{ backgroundColor: cfgOf(k).color }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12.5px] font-medium text-zinc-800 dark:text-zinc-100">
                                {cfgOf(k).name}
                              </span>
                              <span className="block font-mono text-[10px] text-zinc-500">
                                {formatPeso(st.entries.reduce((s, e) => s + e.calculated_bonus, 0))}
                              </span>
                            </span>
                            {(st.status === 'ready' || st.status === 'locked') && (
                              <CheckCircle2 className="h-3.5 w-3.5 flex-none text-emerald-500" aria-hidden />
                            )}
                          </button>
                        );
                      })}
                    </aside>
                  )}

                  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {renderDeptBlock(overlayDept, 'overlay')}
                  </div>
                </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}

// ── Branch list ───────────────────────────────────────────────────────────────

interface HslBranchListProps {
  /** Branch config resolver — code teams AND data sub-teams (2026-09-22).
   *  Passed rather than indexing `HSL_DEPTS`, which is undefined for a data one. */
  cfgOf: (key: string) => DeptConfig;
  deptKeys: HslDeptKey[];
  state: AllDeptState;
  /** Only branches with nothing on screen yet. A background re-pull over rows
   *  the manager can already read must not announce itself. */
  pendingFirstLoad: Set<HslDeptKey>;
  periodStart: (dept: DeptConfig) => string;
  /** Branches containing a cross-branch people-search hit, flagged on the row. */
  matchedBySearch?: Set<HslDeptKey>;
  onOpen: (key: HslDeptKey) => void;
}

/** Every branch as one row: colour, name, cadence, period, status, headcount,
 *  total. Picking one opens it in the overlay.
 *
 *  This replaced a stack of collapsible cards (Kane, 2026-09-01). Accordions
 *  made the page's height depend on what was open, so two branches could never
 *  be compared without scrolling past a full roster, and the scoring surface was
 *  always squeezed into whatever width the stack left it. A row compares in one
 *  glance and hands the whole overlay to the branch you actually picked.
 *
 *  **Two rows per line, not one** (Kane, 2026-09-02). The single stacked column
 *  left two thirds of a desktop viewport empty beside it and pushed a manager
 *  with a dozen branches well past the fold. Two columns from `lg` and one below
 *  it: the row was always built to wrap (that is what `basis-40` is for), so the
 *  narrow case degrades by dropping the figures to a second line rather than
 *  crushing them. A card treatment was tried in between and reverted — the row
 *  is the presentation, the column count was the only problem with it.
 *
 *  Rows are separate bordered boxes rather than one divided container, because a
 *  shared container with an odd branch count leaves the bottom-right cell empty
 *  and its border half-drawn. `h-full` keeps the pair on a line the same height
 *  when one branch name wraps. */
export function HslBranchList({
  deptKeys, state, pendingFirstLoad, periodStart, matchedBySearch, onOpen, cfgOf,
}: HslBranchListProps) {
  if (deptKeys.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-10 text-center text-xs text-zinc-500 dark:border-zinc-800">
        No branches match the current filter.
      </p>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {deptKeys.map((key) => {
        const dept = cfgOf(key);
        const st = state[key]!;
        const total = st.entries.reduce((s, e) => s + e.calculated_bonus, 0);
        const loading = pendingFirstLoad.has(key);
        const matched = !!matchedBySearch?.has(key);
        return (
          <li key={key} className="min-w-0">
            <button
              type="button"
              onClick={() => onOpen(key)}
              title={`Open ${dept.name}`}
              className={cn(
                'group flex h-full w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-white px-4 py-3 text-left',
                'outline-none transition-[border-color,box-shadow] duration-150',
                'hover:border-zinc-300 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-blue-500',
                'dark:bg-zinc-950/50 dark:hover:border-zinc-700',
                // A cross-branch search hit is the one reason a row leaves the
                // default border. The chip alone was easy to miss once the
                // branches stopped being a single column read top to bottom.
                matched
                  ? 'border-blue-400 ring-1 ring-blue-400/50 dark:border-blue-500/70'
                  : 'border-zinc-200 dark:border-zinc-800',
              )}
            >
              <span
                aria-hidden
                className="h-8 w-1 flex-none rounded-full"
                style={{ backgroundColor: dept.color }}
              />

              {/* `basis-40` is the load-bearing bit: the name keeps a readable
                  minimum and the figures wrap to their own line rather than
                  squeezing "SSD Medical Records" into "SSD …". It matters more
                  at two columns than it did at one. */}
              <span className="flex min-w-0 flex-[2] basis-40 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                    {dept.name}
                  </span>
                  {matched && (
                    <span className="flex-none rounded bg-blue-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
                      match
                    </span>
                  )}
                </span>
                <span className="truncate font-mono text-[10px] text-zinc-500">
                  {dept.cadence} · {periodLabel(dept, periodStart(dept))}
                </span>
              </span>

              {/* Fixed widths on the figures so the two columns each scan
                  straight down. Narrower than the one-column version was — half
                  the width has to carry the same four marks. */}
              <span className="ml-auto flex flex-none items-center gap-3">
                <StatusChip status={st.status} />

                <span className="text-right font-mono text-[10px] text-zinc-500 sm:w-14">
                  {loading ? 'loading…' : `${st.entries.length} ppl`}
                </span>

                <span
                  className="text-right font-mono text-sm font-bold tabular-nums sm:w-28"
                  style={{ color: dept.color }}
                >
                  <AnimatedPeso amount={total} />
                </span>

                <ChevronRight
                  aria-hidden
                  className="h-4 w-4 flex-none text-zinc-400 transition-colors group-hover:text-zinc-700 dark:text-zinc-600 dark:group-hover:text-zinc-300"
                />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── DeptBlock ─────────────────────────────────────────────────────────────────

interface DeptBlockProps {
  deptKey: HslDeptKey;
  state: DeptState;
  loading: boolean;
  /** Query pushed down from the top bar's cross-branch people search. Whenever
   *  it changes it takes over this block's own search box, so a branch that
   *  surfaced from a work-email search opens already filtered to that person. */
  searchSeed?: string;
  sectionClassName?: string;
  /** Drops the block's own card frame so it can fill an overlay panel edge to
   *  edge. The coloured left rule survives — it is how the branch is identified. */
  chromeless?: boolean;
  /** Opens this branch in the overlay. Absent when the block already IS the
   *  overlay, which is what keeps the header from offering to reopen itself. */
  onOpen?: () => void;
  periodStartStr: string;
  /** Bonus Library bonuses assigned to THIS branch, per person (2026-09-22).
   *  Threaded from the calculator so the table and the scorer read one source. */
  catalogFor?: (email: string) => HslCatalogBonus[];
  /** Monthly Library bonuses assigned here that this week does not offer (not
   *  the month's final payroll week) — said on the card, never silently absent. */
  catalogHeld?: readonly BonusDef[];
  /** Branch config resolver — code teams AND data sub-teams. */
  cfgOf: (key: string) => DeptConfig;
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  /** Epoch ms of the last successful autosave for this dept, for the inline
   *  "Saved HH:MM" status. Absent until the first write of the session. */
  savedAtMs?: number;
  /** Message from the last failed autosave, if it has not since succeeded. */
  autosaveError?: string;
  onMarkReady: () => void;
  onMarkUnready: () => void;
  onView: () => void;
  payrollLocked: boolean;
  /**
   * The payroll week has not been confirmed live yet on this mount.
   *
   * Only ever true while cached scores are on screen ahead of the Hubstaff
   * resolve. Scoring is held for those few hundred milliseconds because a KPI
   * row's only address is `(department, period_start)`: if the live answer is a
   * different week, this branch's rows are about to be replaced, and an edit
   * typed against the old ones would survive that replacement
   * (`loadDept` refuses to overwrite a dirty branch) and then save last week's
   * numbers under this week's key.
   *
   * Nothing is loosened by this: before the cache existed, this window showed a
   * loading skeleton, which was not editable either.
   */
  weekPending: boolean;
  markUnreadySubmitting: boolean;
  rosterEmails: Set<string>;
  /** Identity emails of week-relevant offboarded people — tags their table
   *  rows "Offboarded — Last Pay" instead of the generic ext chip. */
  offboardedEmails?: Set<string>;
  onAddMember: () => void;
  /** Recently offboarded members of this branch (already de-duped against the
   *  current entries) — rendered as a one-click "Offboarded" strip so their
   *  final bonuses can still be scored. */
  offboardedSuggestions: OffboardedCandidate[];
  /** Attempt the quick-add; returns an error message to surface, or null. */
  onQuickAddOffboarded: (c: OffboardedCandidate) => string | null;
  onRemoveMember: (email: string) => void;
}

const DEPT_PAGE_SIZE = 10;

function DeptBlock({
  catalogFor,
  catalogHeld,
  cfgOf,
  deptKey, state, loading, searchSeed, sectionClassName,
  chromeless, onOpen, periodStartStr,
  onKpiChange,
  savedAtMs, autosaveError, onMarkReady, onMarkUnready, onView,
  payrollLocked, weekPending, markUnreadySubmitting,
  rosterEmails, offboardedEmails, onAddMember, offboardedSuggestions, onQuickAddOffboarded, onRemoveMember,
}: DeptBlockProps) {
  const dept = cfgOf(deptKey);
  const deptTotal = state.entries.reduce((s, e) => s + e.calculated_bonus, 0);
  const tieredRule = dept.rules.find((r): r is TieredRule => r.type === 'tiered');
  const isLocked = state.status === 'locked';
  // Scoring is editable only in draft. Once a period is 'ready' (sent to
  // Accounting) or 'locked', inputs go read-only until it's reopened — this stops
  // silent edits that never get saved to the DB Accounting actually reads.
  // Also held while the payroll week is still being confirmed — see `weekPending`.
  const readOnly = state.status !== 'draft' || payrollLocked || weekPending;

  // Per-dept search + pagination
  const [search, setSearch] = useState(searchSeed ?? '');
  const [page, setPage] = useState(1);

  // The top bar's cross-branch search drives this box; the manager can still
  // retype here afterwards (the effect only fires when the seed itself changes).
  useEffect(() => {
    if (searchSeed !== undefined) setSearch(searchSeed);
  }, [searchSeed]);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return state.entries;
    return state.entries.filter((e) =>
      e.employee_name.toLowerCase().includes(q) || e.employee_email.toLowerCase().includes(q),
    );
  }, [state.entries, search]);

  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / DEPT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * DEPT_PAGE_SIZE;
  const pagedEntries = filteredEntries.slice(pageStart, pageStart + DEPT_PAGE_SIZE);

  // Reset to page 1 whenever the search changes
  useEffect(() => { setPage(1); }, [search]);

  /** Page stepper, rendered in the toolbar. */
  const pagerControls = (
    <div
      data-readonly-allow
      className="flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <button
        type="button"
        className="rounded p-1 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
        disabled={currentPage <= 1}
        onClick={() => setPage((p) => Math.max(1, p - 1))}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span className="min-w-[3rem] text-center font-mono text-[10px] tabular-nums text-zinc-600 dark:text-zinc-400">
        {currentPage} / {totalPages}
      </span>
      <button
        type="button"
        className="rounded p-1 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
        disabled={currentPage >= totalPages}
        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        aria-label="Next page"
      >
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );

  return (
    <section
      className={cn(
        'bg-white dark:bg-zinc-950/60',
        chromeless
          ? 'flex min-h-0 flex-1 flex-col overflow-y-auto'
          : 'overflow-hidden rounded-xl border border-zinc-200 shadow-sm dark:border-zinc-800',
        sectionClassName,
      )}
      style={chromeless ? undefined : { borderLeft: `3px solid ${dept.color}` }}
    >
      {/* Header. Identity and totals only — picking a branch happens in the list
          above (or the overlay rail); this no longer expands or collapses. */}
      <header className="flex flex-none flex-wrap items-center gap-3 border-b border-zinc-200 bg-zinc-50/70 px-5 py-3.5 dark:border-zinc-800/80 dark:bg-zinc-900/40">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {dept.name}
          </h3>
          <span className={cn(
            'rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em]',
            'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
          )}>
            {dept.cadence}
          </span>
          <StatusChip status={state.status} />
          {dept.monthlyMax && (
            // `monthlyMax` is applied per saved ROW, and a weekly dept saves one row a
            // week — so on a weekly dept it is a per-WEEK cap, which is what the docs
            // say (hsl-kpi-calculator-2026-07.md: "₱3,500/wk cap"). This read "/mo"
            // until 2026-09-08, which contradicted both the docs and the arithmetic.
            <span className="font-mono text-[9px] text-zinc-500 dark:text-zinc-500">
              max {formatPeso(dept.monthlyMax)}/{dept.cadence === 'weekly' ? 'wk' : 'mo'}
            </span>
          )}
          <span className="font-mono text-[10px] text-zinc-500">· {periodLabel(dept, periodStartStr)}</span>
          {/* Static, not a spinner. A background reload is not something the
              manager started or has to wait for, and a permanently turning icon
              on a screen that re-pulls on its own reads as a stuck request. */}
          {loading && (
            <span className="font-mono text-[10px] text-zinc-500">loading…</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="font-mono text-[10px] text-zinc-500">{state.entries.length} ppl</span>
          <span className="font-mono text-base font-bold tabular-nums" style={{ color: dept.color }}>
            <AnimatedPeso amount={deptTotal} />
          </span>
          {onOpen && (
            // The header itself toggles the collapse, so this must not bubble.
            <button
              type="button"
              onClick={(ev) => { ev.stopPropagation(); onOpen(); }}
              onKeyDown={(ev) => ev.stopPropagation()}
              title={`Open ${dept.name} on its own`}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-600 outline-none transition-colors hover:bg-zinc-50 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Open</span>
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="space-y-4 px-5 py-5">
        {/* Action row. Add member (any dept, even empty) is a draft-only edit:
            in 'ready'/'locked' the row instead shows why scoring is read-only, so
            nobody makes changes that never reach Accounting. */}
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
            {state.entries.length} {state.entries.length === 1 ? 'person' : 'people'}
          </span>
          {state.status === 'draft' ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              disabled={payrollLocked}
              onClick={onAddMember}
              title={payrollLocked ? 'Locked while payroll is processing' : 'Add someone who is not on the HSL roster'}
            >
              <UserPlus className="h-3.5 w-3.5" /> Add member
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
              <Lock className="h-3 w-3" />
              {isLocked ? 'Locked for the period' : 'Read-only — Mark as Unready to edit'}
            </span>
          )}
        </div>

        {/* Recently offboarded members of this branch — one click to add them
            so their final bonuses can be scored (draft weeks only). */}
        {state.status === 'draft' && (
          <OffboardedStrip
            people={offboardedSuggestions}
            disabled={payrollLocked}
            allowPersonal={false}
            onAdd={onQuickAddOffboarded}
          />
        )}

        {/* Search + pagination toolbar */}
        {state.entries.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                placeholder="Search name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs text-zinc-900 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-200 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100 dark:focus:border-zinc-600 dark:focus:ring-zinc-700"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              <span className="font-mono text-[10px] text-zinc-500">
                {filteredEntries.length === 0
                  ? '0 of 0'
                  : `${pageStart + 1}–${Math.min(pageStart + DEPT_PAGE_SIZE, filteredEntries.length)} of ${filteredEntries.length}`}
                {search.trim() && state.entries.length !== filteredEntries.length && (
                  <span className="text-zinc-400"> · filtered from {state.entries.length}</span>
                )}
              </span>
              {pagerControls}
            </div>
          </div>
        )}

        {dept.noKpi && (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
              Roster only — no KPI inputs
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {state.entries.length === 0 ? (
                <span className="font-mono text-[10px] text-zinc-400">No employees in this department.</span>
              ) : pagedEntries.length === 0 ? (
                <span className="font-mono text-[10px] text-zinc-400">No matches for &quot;{search}&quot;.</span>
              ) : (
                pagedEntries.map((e) => (
                  <span
                    key={e.employee_email}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 text-[11px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    {e.employee_name}
                  </span>
                ))
              )}
            </div>
          </div>
        )}

        {tieredRule && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/30">
            <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
              {tieredRule.label} tiers
            </span>
            {tieredRule.tiers.map((t, i) => (
              <span
                key={i}
                className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[9px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
              >
                {t.min}–{t.max ?? '∞'} → {t.rate === 0 ? '₱0' : `₱${t.rate}/case`}
              </span>
            ))}
          </div>
        )}

        {!dept.noKpi && !dept.perEmployee && (
          <KpiTable
            dept={dept}
            entries={pagedEntries}
            subtotal={deptTotal}
            isLocked={readOnly}
            periodStart={periodStartStr}
            catalogFor={catalogFor}
            catalogHeld={catalogHeld}
            onKpiChange={onKpiChange}
            rosterEmails={rosterEmails}
            offboardedEmails={offboardedEmails}
            onRemoveMember={onRemoveMember}
          />
        )}

        {/* Managers Weekly — each manager has a bespoke incentive checklist. */}
        {dept.perEmployee && (
          <HslManagersTable
            entries={pagedEntries}
            periodStart={periodStartStr}
            subtotal={deptTotal}
            isLocked={readOnly}
            onKpiChange={onKpiChange}
            rosterEmails={rosterEmails}
            offboardedEmails={offboardedEmails}
            onRemoveMember={onRemoveMember}
          />
        )}

        {/* Action bar — autosave status + Mark Ready (draft) → Mark as Unready +
            View (ready/locked). There is no Save button: entries persist on their
            own ~1s after the last keystroke (see the autosave effect). */}
        <div className="flex items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <span className="font-mono text-[10px] text-zinc-500">
            {state.status === 'draft' && !payrollLocked && autosaveError && (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                <AlertTriangle className="h-3 w-3" /> Not saved — retries on your next edit
              </span>
            )}
            {state.status === 'draft' && !payrollLocked && !autosaveError && (state.dirty || state.saving) && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Loader2 className="h-3 w-3 animate-spin" /> Saving…
              </span>
            )}
            {state.status === 'draft' && !payrollLocked && !autosaveError && !state.dirty && !state.saving && state.entries.length > 0 && (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <Check className="h-3 w-3" />
                {savedAtMs
                  ? `Saved ${new Date(savedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'Saved · ready to mark'}
              </span>
            )}
            {(state.status === 'draft' || state.status === 'ready') && payrollLocked && (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                <Lock className="h-3 w-3" /> Payroll processing — locked
              </span>
            )}
            {state.status === 'ready' && !payrollLocked && (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                <CheckCircle2 className="h-3 w-3" /> Sent to Accounting
              </span>
            )}
            {state.status === 'locked' && (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <Lock className="h-3 w-3" /> Locked for the period
              </span>
            )}
          </span>
          <div className="ml-auto flex gap-2">
            {state.status === 'draft' && (
              <Button
                size="sm"
                className="h-7 gap-1.5 bg-amber-600 text-xs text-white hover:bg-amber-500 disabled:opacity-50"
                // `dirty` no longer disables this: the numbers save themselves, so
                // blocking during the debounce window would just look broken. The
                // guard did not go away — `markReady` writes any pending edit
                // FIRST and refuses to change status if that write fails.
                disabled={state.saving || state.entries.length === 0 || payrollLocked}
                title={
                  payrollLocked
                    ? 'KPI Calculator is locked while payroll is processing'
                    : state.entries.length === 0
                      ? 'No employees to mark ready'
                      : 'Send these scores to Accounting · PayrollWizard'
                }
                onClick={onMarkReady}
              >
                <CheckCircle2 className="h-3 w-3" />
                Mark Ready
              </Button>
            )}
            {state.status === 'ready' && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 border-red-200 text-xs text-red-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
                disabled={markUnreadySubmitting || payrollLocked}
                title={payrollLocked ? 'KPI Calculator is locked while payroll is processing' : 'Remove from Accounting — revert to draft'}
                onClick={onMarkUnready}
              >
                <RotateCcw className="h-3 w-3" />
                {markUnreadySubmitting ? 'Reverting…' : 'Mark as Unready'}
              </Button>
            )}
            {(state.status === 'ready' || state.status === 'locked') && (
              <Button
                size="sm"
                className={cn(
                  'h-7 gap-1.5 text-xs text-white',
                  state.status === 'ready'
                    ? 'bg-amber-600 hover:bg-amber-500'
                    : 'bg-emerald-600 hover:bg-emerald-500',
                )}
                onClick={onView}
              >
                <Eye className="h-3 w-3" />
                View
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── KPI Table ─────────────────────────────────────────────────────────────────

interface KpiTableProps {
  dept: DeptConfig;
  entries: EntryRow[];
  subtotal: number;
  isLocked: boolean;
  /** Bonus Library bonuses assigned to THIS branch, per person (2026-09-22).
   *  Rendered as extra columns after the schema rules; a non-PHP one is shown
   *  but not priced, because this card has no FX. */
  catalogFor?: (email: string) => HslCatalogBonus[];
  /** Monthly Library bonuses assigned here that this week does not offer. */
  catalogHeld?: readonly BonusDef[];
  /** ISO period_start of the week on screen — a `cadence: 'monthly'` flat rule
   *  is only tickable in the final payroll week of its month. */
  periodStart: string;
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  rosterEmails?: Set<string>;
  offboardedEmails?: Set<string>;
  onRemoveMember?: (email: string) => void;
}

/** The off-roster tag on a table row: a week-relevant offboarded person reads
 *  "Offboarded — Last Pay" (their final check is this pay cycle), anyone else
 *  the generic "ext". */
function ExtChip({ email, offboardedEmails }: { email: string; offboardedEmails?: Set<string> }) {
  const lastPay = !!offboardedEmails?.has(email);
  return (
    <span
      className="shrink-0 rounded bg-amber-100 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
      title={
        lastPay
          ? 'Offboarded — scoring the final bonuses owed on their last check'
          : 'External member — not on this branch roster'
      }
    >
      {lastPay ? 'Offboarded — Last Pay' : 'ext'}
    </span>
  );
}

/** What a Bonus Library bonus PAYS, in one line.
 *
 *  The column head used to read "formula" — which names a KIND where every
 *  neighbouring column names a RULE (₱100.00, ₱250.00 flat). A manager reading
 *  the row learned nothing from it. This returns the accountant's own
 *  expression instead, so the rule is stated in the same place, and in the same
 *  shape, as the code rules beside it.
 */
function catalogRuleText(bonus: BonusDef, scoreable: boolean): string {
  if (!scoreable) return `${bonus.currency} — pays ₱0 here`;
  const monthly = bonus.cadence === 'monthly' ? ' · monthly' : '';
  if (bonus.kind === 'flat') return `${formatPeso(bonus.amount ?? 0)} flat${monthly}`;
  const f = (bonus.formula ?? '').replace(/\s+/g, ' ').trim();
  return `${f || 'formula'}${monthly}`;
}

/** `flat` / `ƒ(x)` tag on a Library column.
 *
 *  Sky-on-zinc was the ONLY thing separating an accountant-assigned Library
 *  bonus from a coded KPI rule — a distinction carried by hue alone, which is
 *  no distinction at all for anyone who cannot separate those two hues. The
 *  general KPI calculator already states the kind in text (`KindDot`); this is
 *  the same chip, so the two calculators read the same way.
 */
function CatalogKindChip({ kind }: { kind: BonusDef['kind'] }) {
  return (
    <span
      className="shrink-0 rounded bg-sky-100 px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-950/70 dark:text-sky-300"
      title={kind === 'flat' ? 'Flat amount — no inputs' : 'Formula bonus — computed from the inputs below'}
    >
      {kind === 'flat' ? 'flat' : 'ƒ(x)'}
    </span>
  );
}

/** The inputs a Library formula bonus asks for, each under its own name.
 *
 *  Kane, 2026-09-22, pointing at four identical boxes on the Filing Specialist
 *  card: *"There are no name on the bonus I just assigned, it's confusing."*
 *  They carried a `title` tooltip and nothing else, so the only way to tell
 *  which box was which was to hover them one at a time — and a tooltip is
 *  unreachable by touch and by keyboard. The name now sits above the box, the
 *  treatment the general KPI calculator has shipped all along (`VarFields`).
 *
 *  Zero renders as the placeholder rather than a typed "0", matching
 *  `StepperInput` in the same row: an untouched field should not look like a
 *  deliberate zero. That is display only — the stored value is unchanged.
 */
function CatalogVarFields({
  bonus,
  vars,
  kpiData,
  employeeName,
  disabled,
  onChange,
}: {
  bonus: BonusDef;
  vars: string[];
  kpiData: KpiData;
  employeeName: string;
  disabled?: boolean;
  onChange: (key: string, val: number) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="flex max-w-[176px] flex-wrap justify-end gap-x-1.5 gap-y-1"
      initial={reduce ? false : { opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: COLLAPSE_EASE }}
    >
      {vars.map((v) => {
        const raw = Number(kpiData[catalogVarKey(bonus.id, v)] ?? 0) || 0;
        return (
          <label key={v} className="group/varfield flex flex-col items-stretch gap-0.5">
            <span
              className="max-w-[80px] truncate pl-0.5 text-left font-mono text-[8.5px] font-semibold uppercase tracking-wider text-zinc-500 transition-colors group-focus-within/varfield:text-sky-700 dark:text-zinc-400 dark:group-focus-within/varfield:text-sky-300"
              title={v}
            >
              {v}
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              disabled={disabled}
              aria-label={`${v} — ${bonus.name} for ${employeeName}`}
              value={raw === 0 ? '' : String(raw)}
              placeholder="0"
              onFocus={(ev) => ev.currentTarget.select()}
              onChange={(ev) => onChange(catalogVarKey(bonus.id, v), Number(ev.target.value) || 0)}
              className="h-7 w-[80px] rounded-md border border-zinc-300 bg-white px-1 text-center font-mono text-[11px] font-medium tabular-nums text-zinc-900 outline-none transition-colors focus:border-sky-400 focus:ring-1 focus:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-sky-500 dark:focus:ring-sky-900 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </label>
        );
      })}
    </motion.div>
  );
}

/** The Library bonuses on this branch, named once above the grid.
 *
 *  A column head is nine pixels of uppercase mono and scrolls out of view; it
 *  can carry a name and a clipped rule and nothing else. This strip carries the
 *  rest — where the bonus came from (the Bonus Library, not the HSL programme),
 *  the whole formula, the inputs it asks for, and the accountant's own
 *  description in its tooltip. It sits and reads like the tiered-rate strip
 *  above it, because it is doing the same job for a different kind of rule.
 */
/** "Sep 23, 2026, 2:02 PM" — local time, the way every other "saved" stamp in
 *  the app reads. Null for a missing or unparseable timestamp; never "Invalid Date". */
function fmtSavedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** `aliviah@simple.biz` → `aliviah`: the chip has room for a handle, not an address.
 *  The full address is in the `title`. */
function whoShort(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

function BonusLibraryLegend({
  cols,
  held = [],
}: {
  cols: readonly HslCatalogBonus[];
  /** Monthly bonuses assigned to the branch that this week does not offer. On a
   *  Library-only branch (SSD Medical Records is MONTHLY) they are the whole
   *  programme, so their absence must read as "not this week", never as an
   *  empty card. Kane, 2026-10-06: the final-payroll-week gate stands. */
  held?: readonly BonusDef[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-sky-200/80 bg-sky-50/60 px-3 py-2 dark:border-sky-900/50 dark:bg-sky-950/20">
      <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-sky-700 dark:text-sky-400">
        Bonus Library
      </span>
      {held.map((bonus) => (
        <span
          key={`held-${bonus.id}`}
          title={`${bonus.name} is a MONTHLY Library bonus. It is offered only in the month's final payroll week, and this week is not one, so it pays ₱0 here. Score it in the final payroll week, or ask Accounting to make it weekly.`}
          className="inline-flex flex-wrap items-center gap-1.5 rounded border border-amber-300/80 bg-amber-50 px-1.5 py-0.5 dark:border-amber-800/60 dark:bg-amber-950/40"
        >
          <AlertTriangle className="h-3 w-3 flex-none text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="text-[11px] font-medium text-zinc-800 dark:text-zinc-100">{bonus.name}</span>
          <span className="font-mono text-[9px] text-amber-800 dark:text-amber-300">
            monthly · final payroll week only — not offered this week
          </span>
        </span>
      ))}
      {cols.map(({ bonus, scoreable, individual }) => {
        const vars = catalogBonusVariables(bonus);
        // Kane, 2026-09-28: once a branch's pay lives in the Library, the card
        // must say which version it is scoring with and who last saved it,
        // because an accountant's edit reprices the team with nothing else
        // on screen to show it happened.
        const prov = bonusProvenance(bonus);
        const savedAt = fmtSavedAt(prov.savedAt);
        const createdAt = fmtSavedAt(prov.createdAt);
        return (
          <span
            key={bonus.id}
            title={[
              `${bonus.name} — assigned from the Bonus Library`,
              bonus.description?.trim() || null,
              bonus.kind === 'formula' ? `Formula: ${bonus.formula ?? ''}` : catalogRuleText(bonus, scoreable),
              vars.length > 0 ? `Inputs: ${vars.join(', ')}` : null,
              individual ? 'Assigned to one person on this branch, not the whole team.' : null,
              scoreable ? null : `This card scores in pesos only, so a ${bonus.currency} bonus pays ₱0 here.`,
              `Version ${prov.version}${prov.effectiveFrom ? `, effective from ${prov.effectiveFrom}` : ''}. This card scores the CURRENT version, whichever week is open.`,
              savedAt ? `Last saved ${savedAt}${prov.savedBy ? ` by ${prov.savedBy}` : ''}` : prov.savedBy ? `Last saved by ${prov.savedBy}` : null,
              createdAt && createdAt !== savedAt ? `Created ${createdAt}${prov.createdBy ? ` by ${prov.createdBy}` : ''}` : null,
            ]
              .filter(Boolean)
              .join('\n')}
            className="inline-flex flex-wrap items-center gap-1.5 rounded border border-sky-200 bg-white px-1.5 py-0.5 dark:border-sky-900/60 dark:bg-zinc-900"
          >
            <CatalogKindChip kind={bonus.kind} />
            <span className="text-[11px] font-medium text-zinc-800 dark:text-zinc-100">{bonus.name}</span>
            <span
              className={cn(
                'font-mono text-[9px]',
                scoreable ? 'text-zinc-500 dark:text-zinc-400' : 'text-amber-700 dark:text-amber-400',
              )}
            >
              {catalogRuleText(bonus, scoreable)}
            </span>
            {vars.length > 0 && (
              <span className="font-mono text-[9px] text-zinc-500 dark:text-zinc-400">inputs: {vars.join(' · ')}</span>
            )}
            {individual && (
              <span className="rounded bg-zinc-100 px-1 py-px font-mono text-[8px] uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                1 person
              </span>
            )}
            <span className="inline-flex items-center gap-1 font-mono text-[9px] tabular-nums text-zinc-500 dark:text-zinc-400">
              <span className="rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-px font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                v{prov.version}
              </span>
              {prov.effectiveFrom && <span>from {prov.effectiveFrom}</span>}
              {(savedAt || prov.savedBy) && (
                <span>
                  {`· saved${savedAt ? ` ${savedAt}` : ''}${prov.savedBy ? ` by ${whoShort(prov.savedBy)}` : ''}`}
                </span>
              )}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function KpiTable({ dept, entries, subtotal, isLocked, periodStart, catalogFor, catalogHeld = [], onKpiChange, rosterEmails, offboardedEmails, onRemoveMember }: KpiTableProps) {
  const rules = dept.rules.filter((r) => r.type !== 'team_split');
  // The catalog columns are the UNION across everyone on the page: a bonus
  // assigned per-employee reaches one person, and the column still has to exist
  // for their cell to render. Non-applicable cells read "n/a", exactly as a
  // managerOnly rule does.
  const catalogCols: HslCatalogBonus[] = (() => {
    const seen = new Map<string, HslCatalogBonus>();
    if (catalogFor) {
      for (const e of entries) for (const c of catalogFor(e.employee_email)) if (!seen.has(c.bonus.id)) seen.set(c.bonus.id, c);
    }
    return [...seen.values()];
  })();
  // Monthly flat rules (Pre/Post-Hearing's ₱2,500) open only in the month's final
  // payroll week — the same calendar rule the wizard uses for every monthly bonus.
  const finalWeekOfMonth = isFinalPayrollWeekOfMonth(periodStart);

  return (
    <div className="space-y-2">
      {/* What the Library bonuses on this branch ARE, said once and in full —
          the column heads below only have room for a name and a clipped rule. */}
      {(catalogCols.length > 0 || catalogHeld.length > 0) && (
        <BonusLibraryLegend cols={catalogCols} held={catalogHeld} />
      )}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="table-keep w-full min-w-[600px] text-xs">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Employee</th>
              {/* No "Mgr" column (Kane, 2026-09-28: "remove it"). Its only pay
                  effect was unlocking `managerOnly` rules, and the last one
                  (Collections' ₱2,500 flat) was deleted that day. A stored
                  `is_manager` is still loaded and saved as-is. schema.test.ts
                  fails if a managerOnly rule comes back with no toggle to
                  unlock it. */}
              {rules.map((r) => (
                <th key={r.key} className="px-2 py-2 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-500">
                  {r.label}
                  <span className="block font-normal text-zinc-400 dark:text-zinc-600">
                    {r.type === 'per_unit' ? formatPeso(r.rate, r.currency) :
                     r.type === 'flat' ? `${formatPeso(r.amount, r.currency)} flat${r.cadence === 'monthly' ? ' · monthly' : ''}` :
                     r.type === 'manual' ? 'manual ₱' :
                     'tiered'}
                  </span>
                </th>
              ))}
              {catalogCols.map(({ bonus, scoreable }) => {
                const vars = catalogBonusVariables(bonus);
                const rule = catalogRuleText(bonus, scoreable);
                return (
                  <th
                    key={`cat-${bonus.id}`}
                    className={cn(
                      'px-2 py-2 text-right font-mono text-[9px] uppercase tracking-[0.12em]',
                      scoreable ? 'text-sky-700 dark:text-sky-400' : 'text-amber-700 dark:text-amber-400',
                    )}
                    title={[
                      `${bonus.name} — assigned from the Bonus Library`,
                      bonus.description?.trim() || null,
                      bonus.kind === 'formula' ? `Formula: ${bonus.formula ?? ''}` : rule,
                      vars.length > 0 ? `Inputs: ${vars.join(', ')}` : null,
                      scoreable ? null : `This card scores in pesos only, so a ${bonus.currency} bonus pays ₱0 here.`,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  >
                    {/* Name + kind only. The head used to add a second line with
                        the clipped formula. Kane, 2026-09-28, on Pre/Post-Hearing:
                        "what is this still doing in here". The Bonus Library strip
                        above already states the whole formula, and the full text
                        is in this `title`. With no code columns beside it, a wide
                        head also left that line stranded on the far side of the
                        cell. */}
                    <span className="flex items-center justify-end gap-1">
                      <CatalogKindChip kind={bonus.kind} />
                      <span className="max-w-[128px] truncate">{bonus.name}</span>
                    </span>
                  </th>
                );
              })}
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Bonus</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={rules.length + catalogCols.length + 2} className="px-3 py-6 text-center font-mono text-[10px] text-zinc-500">
                  No employees on this page.
                </td>
              </tr>
            )}
            {entries.map((e) => {
              const isExternal = !!rosterEmails && !rosterEmails.has(e.employee_email);
              return (
              <tr key={e.employee_email} className="border-b border-zinc-100 hover:bg-zinc-50/60 dark:border-zinc-800/60 dark:hover:bg-zinc-900/40">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                        <span className="truncate">{e.employee_name}</span>
                        {isExternal && <ExtChip email={e.employee_email} offboardedEmails={offboardedEmails} />}
                      </div>
                      <div className="font-mono text-[10px] text-zinc-500">{e.employee_email}</div>
                    </div>
                    {isExternal && onRemoveMember && !isLocked && (
                      <button
                        type="button"
                        onClick={() => onRemoveMember(e.employee_email)}
                        title="Remove external member"
                        aria-label={`Remove ${e.employee_name}`}
                        className="ml-auto shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </td>
                {rules.map((r) => (
                  <td key={r.key} className="px-2 py-2 text-right">
                    {r.type === 'flat' ? (
                      r.managerOnly && !e.is_manager ? (
                        <span className="text-zinc-500 dark:text-zinc-400">n/a</span>
                      ) : r.cadence === 'monthly' && !finalWeekOfMonth ? (
                        <span
                          className="font-mono text-[9px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
                          title={`${r.label} is a monthly bonus — tick it in the last payroll week of the month`}
                        >
                          final wk
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          className="accent-amber-500"
                          checked={Boolean(e.kpi_data[r.key])}
                          disabled={isLocked}
                          aria-label={`${r.label} for ${e.employee_name}`}
                          onChange={(ev) => onKpiChange(e.employee_email, r.key, ev.target.checked)}
                        />
                      )
                    ) : r.type === 'manual' ? (
                      r.managerOnly && !e.is_manager ? (
                        <span className="text-zinc-500 dark:text-zinc-400">n/a</span>
                      ) : (
                        <PesoAmountInput
                          value={Number(e.kpi_data[r.key] ?? 0)}
                          disabled={isLocked}
                          ariaLabel={`${r.label} amount for ${e.employee_name}`}
                          onChange={(n) => onKpiChange(e.employee_email, r.key, n)}
                        />
                      )
                    ) : (
                      <StepperInput
                        value={Number(e.kpi_data[r.key] ?? 0)}
                        disabled={isLocked}
                        ariaLabel={`${r.label} for ${e.employee_name}`}
                        onChange={(n) => onKpiChange(e.employee_email, r.key, n)}
                      />
                    )}
                  </td>
                ))}
                {catalogCols.map(({ bonus }) => {
                  const mine = catalogFor ? catalogFor(e.employee_email) : [];
                  const hit = mine.find((c) => c.bonus.id === bonus.id);
                  if (!hit) {
                    // Assigned to someone else on this page (a per-employee bonus).
                    return (
                      <td key={`cat-${bonus.id}`} className="px-2 py-2 text-right">
                        <span
                          className="text-zinc-500 dark:text-zinc-400"
                          title={`${bonus.name} is not assigned to ${e.employee_name}`}
                        >
                          n/a
                        </span>
                      </td>
                    );
                  }
                  if (!hit.scoreable) {
                    // Shown, never paid. The chip says the consequence (₱0) rather
                    // than only the currency, so nobody reads "USD" as "pays USD".
                    return (
                      <td key={`cat-${bonus.id}`} className="px-2 py-2 text-right">
                        <span
                          className="inline-flex items-center gap-1 rounded border border-amber-300/80 bg-amber-50 px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300"
                          title={`${bonus.name} is a ${bonus.currency} bonus. This card scores in pesos only, so it pays ₱0 here — assign a PHP bonus, or score it on the department card.`}
                        >
                          {bonus.currency} → ₱0
                        </span>
                      </td>
                    );
                  }
                  const on = !!e.kpi_data[catalogOnKey(bonus.id)];
                  const vars = catalogBonusVariables(bonus);
                  // What this ONE bonus pays this person. A flat bonus already
                  // states its amount in the column head, so repeating it on every
                  // row would be noise; a formula's result is knowable no other
                  // way, and ₱0 from a ticked bonus is the state worth catching.
                  const amount = on ? calcHslCatalogBonus(e.kpi_data, bonus) : 0;
                  return (
                    <td key={`cat-${bonus.id}`} className="px-2 py-2">
                      <div className="flex flex-col items-end gap-1">
                        <input
                          type="checkbox"
                          className="accent-sky-600"
                          checked={on}
                          disabled={isLocked}
                          aria-label={`Apply ${bonus.name} to ${e.employee_name}`}
                          title={
                            on
                              ? `${bonus.name} applies to ${e.employee_name}`
                              : vars.length > 0
                                ? `Apply ${bonus.name} to ${e.employee_name}, then enter ${vars.join(', ')}`
                                : `Apply ${bonus.name} to ${e.employee_name}`
                          }
                          onChange={() => onKpiChange(e.employee_email, catalogOnKey(bonus.id), !on)}
                        />
                        {on && vars.length > 0 && (
                          <>
                            <CatalogVarFields
                              bonus={bonus}
                              vars={vars}
                              kpiData={e.kpi_data}
                              employeeName={e.employee_name}
                              disabled={isLocked}
                              onChange={(key, val) => onKpiChange(e.employee_email, key, val)}
                            />
                            <span
                              className={cn(
                                'font-mono text-[9.5px] font-semibold tabular-nums',
                                amount > 0 ? 'text-sky-700 dark:text-sky-400' : 'text-amber-700 dark:text-amber-400',
                              )}
                              title={
                                amount > 0
                                  ? `${bonus.name} pays ${formatPeso(amount)} of ${e.employee_name}'s bonus`
                                  : `${bonus.name} pays ₱0 with these inputs — it is ticked, so check the numbers above`
                              }
                            >
                              {formatPeso(amount)}
                            </span>
                          </>
                        )}
                      </div>
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                  <AnimatedPeso amount={e.calculated_bonus} />
                </td>
              </tr>
              );
            })}
            <tr className="border-t border-zinc-300 bg-zinc-100/70 dark:border-zinc-700 dark:bg-zinc-900/60">
              <td colSpan={rules.length + catalogCols.length + 1} className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
                Subtotal
              </td>
              <td className="px-3 py-2 text-right font-mono font-bold text-zinc-900 dark:text-zinc-100">
                <AnimatedPeso amount={subtotal} />
              </td>
            </tr>
            </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Managers Weekly Table ─────────────────────────────────────────────────────

interface HslManagersTableProps {
  entries: EntryRow[];
  subtotal: number;
  isLocked: boolean;
  /** ISO Sunday of the week on screen — manager specs are DATED, so the table
   *  must draw the components this week was (or will be) scored under. */
  periodStart: string;
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  rosterEmails?: Set<string>;
  offboardedEmails?: Set<string>;
  onRemoveMember?: (email: string) => void;
}

/** The Managers Weekly dept renders one row per manager, each showing that
 *  person's own hardcoded incentive set for THIS week (`managerSpecFor`). A
 *  'check' component is a tick that adds its fixed amount; a 'banded' component
 *  is one metric whose bands are drawn as a single-pick list — choosing a band
 *  stores that band's value (`bandValue`) and only the landed band pays. The row
 *  total is `calcManagerBonus` for the same week. */
export function HslManagersTable({
  entries, subtotal, isLocked, periodStart, onKpiChange, rosterEmails, offboardedEmails, onRemoveMember,
}: HslManagersTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="table-keep w-full min-w-[600px] text-xs">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
            <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Manager</th>
            <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
              Incentives — tick what was met · pick the band reached
            </th>
            <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Bonus</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={3} className="px-3 py-6 text-center font-mono text-[10px] text-zinc-500">
                No managers on this page.
              </td>
            </tr>
          )}
          {entries.map((e) => {
            const spec = managerSpecFor(e.employee_email, periodStart);
            const components: ManagerComponent[] = spec?.components ?? [];
            const isExternal = !!rosterEmails && !rosterEmails.has(e.employee_email);
            return (
              <tr
                key={e.employee_email}
                className="border-b border-zinc-100 align-top hover:bg-zinc-50/60 dark:border-zinc-800/60 dark:hover:bg-zinc-900/40"
              >
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                        <span className="truncate">{e.employee_name}</span>
                        {isExternal && <ExtChip email={e.employee_email} offboardedEmails={offboardedEmails} />}
                      </div>
                      <div className="font-mono text-[10px] text-zinc-500">{e.employee_email}</div>
                    </div>
                    {isExternal && onRemoveMember && !isLocked && (
                      <button
                        type="button"
                        onClick={() => onRemoveMember(e.employee_email)}
                        title="Remove external member"
                        aria-label={`Remove ${e.employee_name}`}
                        className="ml-auto shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  {components.length === 0 ? (
                    <span className="font-mono text-[10px] text-zinc-400">
                      No incentives configured for this person.
                    </span>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {components.map((c) => {
                        if (c.kind === 'banded') {
                          const raw = e.kpi_data[c.key];
                          const value = typeof raw === 'number' ? raw : undefined;
                          const landed = value === undefined ? undefined : landedBand(c.bands, value);
                          const groupName = `${e.employee_email}:${c.key}`;
                          return (
                            <fieldset key={c.key} className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
                              <legend className="mb-0.5 flex w-full items-center gap-2 px-0.5 text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                                <span className="flex-1">{c.label}</span>
                                <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-400">{c.unit} · one band</span>
                                {landed && !isLocked && (
                                  <button
                                    type="button"
                                    onClick={() => onKpiChange(e.employee_email, c.key, false)}
                                    className="rounded px-1 font-mono text-[9px] uppercase tracking-wider text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                                    aria-label={`Clear ${c.label} for ${e.employee_name}`}
                                  >
                                    clear
                                  </button>
                                )}
                              </legend>
                              {c.bands.map((b) => {
                                const picked = landed === b;
                                return (
                                  <label
                                    key={b.label}
                                    className={cn(
                                      'flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 transition-colors duration-150',
                                      picked
                                        ? 'border-purple-300 bg-purple-50/80 text-purple-700 kpi-row-confirm dark:border-purple-700/70 dark:bg-purple-950/40 dark:text-purple-300'
                                        : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:bg-zinc-900',
                                      isLocked ? 'cursor-default' : 'cursor-pointer',
                                    )}
                                  >
                                    <input
                                      type="radio"
                                      name={groupName}
                                      className="h-4 w-4 shrink-0 accent-purple-600"
                                      checked={picked}
                                      disabled={isLocked}
                                      onChange={() => onKpiChange(e.employee_email, c.key, bandValue(b))}
                                    />
                                    <span className={cn('flex-1 text-[12px] leading-snug', picked && 'font-medium text-zinc-900 dark:text-zinc-100')}>
                                      {b.label}
                                    </span>
                                    <span className={cn('shrink-0 font-mono text-[11px] tabular-nums', picked ? 'font-semibold text-purple-700 dark:text-purple-300' : 'text-zinc-400')}>
                                      {formatPeso(b.amount)}
                                    </span>
                                  </label>
                                );
                              })}
                            </fieldset>
                          );
                        }
                        const checked = Boolean(e.kpi_data[c.key]);
                        return (
                          <label
                            key={c.key}
                            className={cn(
                              'flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 transition-colors duration-150',
                              checked
                                ? 'border-purple-300 bg-purple-50/80 text-purple-700 kpi-row-confirm dark:border-purple-700/70 dark:bg-purple-950/40 dark:text-purple-300'
                                : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:bg-zinc-900',
                              isLocked ? 'cursor-default' : 'cursor-pointer',
                            )}
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 shrink-0 accent-purple-600"
                              checked={checked}
                              disabled={isLocked}
                              onChange={(ev) => onKpiChange(e.employee_email, c.key, ev.target.checked)}
                            />
                            <span className={cn('flex-1 text-[12px] leading-snug', checked && 'font-medium text-zinc-900 dark:text-zinc-100')}>
                              {c.label}
                            </span>
                            {c.cadence === 'monthly' && (
                              <span className="shrink-0 rounded bg-zinc-100 px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                                monthly
                              </span>
                            )}
                            <span className={cn('shrink-0 font-mono text-[11px] tabular-nums', checked ? 'font-semibold text-purple-700 dark:text-purple-300' : 'text-zinc-400')}>
                              {formatPeso(c.amount)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                  <AnimatedPeso amount={e.calculated_bonus} />
                </td>
              </tr>
            );
          })}
          <tr className="border-t border-zinc-300 bg-zinc-100/70 dark:border-zinc-700 dark:bg-zinc-900/60">
            <td colSpan={2} className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
              Subtotal
            </td>
            <td className="px-3 py-2 text-right font-mono font-bold text-zinc-900 dark:text-zinc-100">
              <AnimatedPeso amount={subtotal} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="border-t border-zinc-200 bg-zinc-50/60 px-3 py-1.5 font-mono text-[9px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40">
        Checklist tiers stack — tick every threshold that was met. Banded lines pay the one band
        picked for the week. Items tagged
        <span className="mx-1 rounded bg-zinc-100 px-1 py-0.5 uppercase tracking-wider dark:bg-zinc-800">monthly</span>
        are earned only in the last payroll week of the month.
      </p>
    </div>
  );
}
// ── Add External Member modal ─────────────────────────────────────────────────

interface ExternalCandidate {
  name: string;
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
  /** True for picks from the Offboarded group (see OffboardedSuggestions). */
  offboarded?: boolean;
  off_boarded_at?: string | null;
  hubstaff_email?: string | null;
}

/** The email an external candidate is keyed under — WORK email ONLY. All of HSL
 *  keys people by work email: the roster (hsl_team_members, from the Hogan sheet)
 *  and the hardcoded Managers cohort are all @simple.biz work emails, and Hubstaff
 *  matches on work email. We deliberately DO NOT fall back to personal email even
 *  when one is on file — a personal-keyed entry is exactly the bug this fixes. A
 *  candidate with no work email therefore has no usable email and can't be added
 *  (the picker disables them). Offboarded picks key HUBSTAFF-first: their master
 *  work email can drift from the login their final hours are under, and the
 *  Hubstaff email is the only identity payroll resolves for off-roster people. */
function candidateEmail(c: ExternalCandidate): string {
  if (c.offboarded) return normEmail(c.hubstaff_email ?? null) || normEmail(c.work_email) || '';
  return normEmail(c.work_email) || '';
}

/** "Add external member": search the Global Master List (the same endpoint the
 *  transfer picker uses, so a plain manager needs no extra permission), pick
 *  someone, then confirm. On confirm the person is appended to the dept's
 *  calculator and flows to payroll via the normal autosave → Mark Ready path. */
function HslAddMemberModal({
  deptName,
  color,
  offboarded,
  onAdd,
  onClose,
}: {
  deptName: string;
  color: string;
  /** Recently offboarded people (fetched once by the calculator) — rendered as
   *  a second, clearly-labeled group so final bonuses can still be scored. */
  offboarded: OffboardedCandidate[];
  /** Attempt the add; return an error message to surface, or null on success. */
  onAdd: (name: string, email: string) => string | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ExternalCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ExternalCandidate | null>(null);
  const [phase, setPhase] = useState<'pick' | 'confirm'>('pick');
  const [error, setError] = useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => searchRef.current?.focus(), 60);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [onClose]);

  // Debounced Global-Master-List search. The endpoint already excludes the
  // manager's own departments, so everyone it returns is external to the team.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      fetch(`/api/manager/transfer-candidates?${params.toString()}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { people?: ExternalCandidate[] }) => {
          if (!cancelled) setCandidates(j.people ?? []);
        })
        .catch(() => {
          if (!cancelled) setCandidates([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  const selectedEmail = selected ? candidateEmail(selected) : '';
  // The offboarded group filters locally — the list is small and fetched once,
  // so it must not re-query per keystroke like the active candidates do.
  const offboardedShown = offboarded.filter((c) => matchesOffboardedQuery(c, query));

  function handleConfirm() {
    if (!selected) return;
    const err = onAdd(selected.name, candidateEmail(selected));
    if (err) {
      setError(err);
      setPhase('pick');
      return;
    }
    onClose();
  }

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Add external member"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.24, ease: COLLAPSE_EASE }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-zinc-950/45 backdrop-blur-md dark:bg-black/65"
      />
      <motion.div
        className="relative flex max-h-[min(620px,90vh)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-[#0e1117]"
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 4 }}
        transition={{ duration: 0.32, ease: COLLAPSE_EASE }}
      >
        {phase === 'pick' ? (
          <div className="flex min-h-0 flex-col gap-3 px-6 py-6">
            <div className="flex items-center gap-3">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                style={{ backgroundColor: `${color}24`, color }}
              >
                <UserPlus className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="text-base font-bold text-zinc-900 dark:text-zinc-100">Add External Member</div>
                <p className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">{deptName} · KPI Calculator</p>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Pick someone from the{' '}
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">Global Master List</span> who isn’t on the{' '}
              {deptName} roster. They’ll be scored in this period and go to payroll with the rest of the team.
            </p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or email…"
                className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2.5 text-[13px] text-zinc-900 outline-none transition-colors focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-100"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              {loading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-10 text-xs text-zinc-400">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Searching the master list…
                </div>
              ) : candidates.length === 0 && offboardedShown.length === 0 ? (
                <div className="px-3 py-10 text-center text-xs text-zinc-400">
                  No one on the master list matches{query.trim() ? ` “${query.trim()}”` : ''}.
                </div>
              ) : (
                <>
                  {candidates.map((c) => {
                    const email = candidateEmail(c);
                    const isSelected =
                      !!selected && !selected.offboarded && candidateEmail(selected) === email && selected.name === c.name;
                    const noEmail = !email;
                    return (
                      <button
                        key={`${c.name}:${email || c.department || ''}`}
                        type="button"
                        disabled={noEmail}
                        onClick={() => {
                          setSelected(c);
                          setError(null);
                        }}
                        title={noEmail ? 'No work email on file — cannot be added' : undefined}
                        className={cn(
                          'flex w-full items-center gap-2.5 border-b border-zinc-100 px-3 py-2 text-left transition-colors last:border-0 dark:border-zinc-800/60',
                          noEmail
                            ? 'cursor-not-allowed opacity-45'
                            : isSelected
                              ? 'bg-emerald-50 dark:bg-emerald-950/30'
                              : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50',
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-medium text-zinc-800 dark:text-zinc-100">
                            {c.name}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-zinc-400">
                            {email || 'no work email on file'}
                          </span>
                        </span>
                        {c.department && (
                          <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" title={c.department ?? undefined}>
                            {formatDeptLabel(c.department)}
                          </span>
                        )}
                        {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />}
                      </button>
                    );
                  })}
                  {/* Offboarded group — recently-left people whose final bonuses
                      may still need scoring. Keyed Hubstaff/work-first on add so
                      the amount resolves to their payable row. */}
                  {offboardedShown.length > 0 && (
                    <>
                      <div className="border-b border-amber-200/60 bg-amber-50/70 px-3 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/[0.08] dark:text-amber-300">
                        Offboarded — Last Pay: final bonuses owed on their last check
                      </div>
                      {offboardedShown.map((o) => {
                        const c: ExternalCandidate = { ...o, offboarded: true };
                        const email = candidateEmail(c);
                        const isSelected =
                          !!selected && !!selected.offboarded && candidateEmail(selected) === email && selected.name === c.name;
                        const noEmail = !email;
                        return (
                          <button
                            key={`off:${c.name}:${email || c.off_boarded_at || ''}`}
                            type="button"
                            disabled={noEmail}
                            onClick={() => {
                              setSelected(c);
                              setError(null);
                            }}
                            title={noEmail ? 'No work email on file — cannot be added' : undefined}
                            className={cn(
                              'flex w-full items-center gap-2.5 border-b border-zinc-100 px-3 py-2 text-left transition-colors last:border-0 dark:border-zinc-800/60',
                              noEmail
                                ? 'cursor-not-allowed opacity-45'
                                : isSelected
                                  ? 'bg-emerald-50 dark:bg-emerald-950/30'
                                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50',
                            )}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12.5px] font-medium text-zinc-800 dark:text-zinc-100">
                                {c.name}
                              </span>
                              <span className="block truncate font-mono text-[10px] text-zinc-400">
                                {email || 'no work email on file'}
                              </span>
                            </span>
                            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                              {offboardedLeftLabel(o)}
                            </span>
                            {c.department && (
                              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" title={c.department ?? undefined}>
                                {formatDeptLabel(c.department)}
                              </span>
                            )}
                            {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />}
                          </button>
                        );
                      })}
                    </>
                  )}
                </>
              )}
            </div>
            {error && (
              <p className="flex items-start gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {error}
              </p>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700 disabled:opacity-60"
                disabled={!selected || !selectedEmail}
                onClick={() => setPhase('confirm')}
              >
                Continue
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 px-6 py-7 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/50">
              <AlertTriangle className="h-7 w-7 text-amber-600 dark:text-amber-400" aria-hidden />
            </span>
            <div className="text-base font-bold text-zinc-900 dark:text-zinc-100">Double-check before adding</div>
            <div className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-left dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100" title={selected?.name}>
                {selected?.name}
              </div>
              <div className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400" title={selectedEmail}>
                {selectedEmail}
              </div>
              {selected?.department && (
                <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">
                  {selected.offboarded ? 'Was in' : 'Currently in'}: {formatDeptLabel(selected.department)}
                </div>
              )}
            </div>
            {selected?.offboarded && (
              <p className="w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left text-[11px] leading-relaxed text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                This person is <span className="font-semibold">offboarded</span> — you’re scoring their final
                bonuses. The amount pays with the week that covers their last hours; if they have no hours in
                the pay week, ask Accounting to use People → Pay instead.
              </p>
            )}
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              This person is outside the {deptName} roster. Once added they’ll be scored in this period’s KPI submission and
              paid under the details above — make sure it’s the right person. You can remove them any time before Mark Ready.
            </p>
            <div className="mt-1 flex gap-2">
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setPhase('pick')}>
                Go back
              </Button>
              <Button size="sm" className="h-8 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700" onClick={handleConfirm}>
                <UserPlus className="h-3.5 w-3.5" /> Confirm &amp; Add
              </Button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// ── Week switch (live | upcoming) ─────────────────────────────────────────────

/** "Sep 20 – Sep 26" for a Sunday key. Parsed as a LOCAL date, never through
 *  `new Date('YYYY-MM-DD')`, which is UTC and shifts a day west of Greenwich. */
function fmtWeekRange(start: string): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y!, m! - 1, d!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  return `${fmt(start)} – ${fmt(weekEndFromStart(start))}`;
}

/** Two weeks only, by ruling: the live batch and the ONE after it (Q3). */
function HslWeekSwitch({
  ahead,
  liveWeekStart,
  upcomingWeekStart,
  busy,
  onChange,
}: {
  ahead: boolean;
  liveWeekStart: string;
  upcomingWeekStart: string | null;
  busy: boolean;
  onChange: (ahead: boolean) => void;
}) {
  const options: { ahead: boolean; label: string; week: string | null }[] = [
    { ahead: false, label: 'Live', week: liveWeekStart },
    { ahead: true, label: 'Upcoming', week: upcomingWeekStart },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Pay week"
      className="flex items-center rounded-lg border border-zinc-200 bg-white p-0.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      {options.map((o) => {
        const active = o.ahead === ahead;
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={busy || !o.week}
            onClick={() => onChange(o.ahead)}
            title={o.week ? `Week of ${fmtWeekRange(o.week)}` : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed',
              active
                ? o.ahead
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                  : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-800 disabled:opacity-50 dark:hover:text-zinc-200',
            )}
          >
            {busy && !active ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
            {o.label}
            {o.week && <span className="font-normal normal-case tracking-normal opacity-70">{fmtWeekRange(o.week)}</span>}
          </button>
        );
      })}
    </div>
  );
}
