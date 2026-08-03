'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Download, Eye, Filter, Loader2, Lock, Minus, Plus, RefreshCw, RotateCcw,
  Save, Search, Trash2, UserPlus, Users, X,
} from 'lucide-react';

const COLLAPSE_EASE = [0.22, 1, 0.36, 1] as const;
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import {
  BonusStatus, DeptConfig, HslDeptKey, HSL_DEPTS, HSL_DEPT_KEYS,
  HSL_MANAGERS, HSL_MANAGERS_BY_EMAIL, KpiData, ManagerComponent,
  SubTeamName, TeamPoolRule, TeamSplitRule, TieredRule,
  calcBonus, calcManagerBonus, calcTeamPoolShare, calcTeamSplitShare, canAccessHslDept, formatPeso,
} from '@/lib/hsl-bonus/schema';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import {
  pickCurrentSourceFile,
  type HubstaffSourceFilesResponse,
} from '@/lib/hubstaff/current-upload';
import HslBonusReadyPreview from './HslBonusReadyPreview';
import KpiCalculatorLoading from './KpiCalculatorLoading';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntryRow {
  id?: string;
  employee_email: string;
  employee_name: string;
  is_manager: boolean;
  kpi_data: KpiData;
  calculated_bonus: number;
}

export interface SubTeamState {
  pct: string;
  records: string;
  /** RFC count for the team_pool rule — pooled at ratePerRecord and split evenly
   *  across the sub-team's headcount, independent of the accuracy % tiering. */
  rfc: string;
}

interface DeptState {
  entries: EntryRow[];
  status: BonusStatus;
  subTeams: Record<SubTeamName, SubTeamState>;
  dirty: boolean;
  saving: boolean;
  /** Emails belonging to the dept's true roster (hsl_team_members, or HSL_MANAGERS
   *  for the Managers dept). Any entry whose email is NOT here was added manually
   *  as an external member and can be removed. */
  rosterEmails: Set<string>;
}

type AllDeptState = Record<HslDeptKey, DeptState>;

export const DEFAULT_SUB_TEAMS: Record<SubTeamName, SubTeamState> = {
  BLUE: { pct: '', records: '', rfc: '' },
  GREEN: { pct: '', records: '', rfc: '' },
  YELLOW: { pct: '', records: '', rfc: '' },
  ORANGE: { pct: '', records: '', rfc: '' },
  PURPLE: { pct: '', records: '', rfc: '' },
  RED: { pct: '', records: '', rfc: '' },
};

export interface SubTeamPalette {
  ring:       string;  // outer ring colour
  headerBg:   string;  // top strip
  headerText: string;
  bodyBg:     string;  // inner card body
  accent:     string;  // text-color for share + tier
  dotOn:      string;  // filled tier dot
}

export const SUB_TEAM_PALETTE: Record<SubTeamName, SubTeamPalette> = {
  BLUE: {
    ring:       'ring-blue-400/60 dark:ring-blue-500/50',
    headerBg:   'bg-gradient-to-r from-blue-500 to-blue-600 dark:from-blue-600 dark:to-blue-700',
    headerText: 'text-white',
    bodyBg:     'bg-blue-50/60 dark:bg-blue-950/30',
    accent:     'text-blue-700 dark:text-blue-300',
    dotOn:      'bg-blue-500 dark:bg-blue-400',
  },
  GREEN: {
    ring:       'ring-emerald-400/60 dark:ring-emerald-500/50',
    headerBg:   'bg-gradient-to-r from-emerald-500 to-emerald-600 dark:from-emerald-600 dark:to-emerald-700',
    headerText: 'text-white',
    bodyBg:     'bg-emerald-50/60 dark:bg-emerald-950/30',
    accent:     'text-emerald-700 dark:text-emerald-300',
    dotOn:      'bg-emerald-500 dark:bg-emerald-400',
  },
  YELLOW: {
    ring:       'ring-yellow-400/60 dark:ring-yellow-500/50',
    headerBg:   'bg-gradient-to-r from-yellow-400 to-amber-500 dark:from-yellow-500 dark:to-amber-600',
    headerText: 'text-zinc-900',
    bodyBg:     'bg-yellow-50/60 dark:bg-yellow-950/30',
    accent:     'text-amber-700 dark:text-amber-300',
    dotOn:      'bg-yellow-500 dark:bg-yellow-400',
  },
  ORANGE: {
    ring:       'ring-orange-400/60 dark:ring-orange-500/50',
    headerBg:   'bg-gradient-to-r from-orange-500 to-orange-600 dark:from-orange-600 dark:to-orange-700',
    headerText: 'text-white',
    bodyBg:     'bg-orange-50/60 dark:bg-orange-950/30',
    accent:     'text-orange-700 dark:text-orange-300',
    dotOn:      'bg-orange-500 dark:bg-orange-400',
  },
  PURPLE: {
    ring:       'ring-violet-400/60 dark:ring-violet-500/50',
    headerBg:   'bg-gradient-to-r from-violet-500 to-violet-600 dark:from-violet-600 dark:to-violet-700',
    headerText: 'text-white',
    bodyBg:     'bg-violet-50/60 dark:bg-violet-950/30',
    accent:     'text-violet-700 dark:text-violet-300',
    dotOn:      'bg-violet-500 dark:bg-violet-400',
  },
  RED: {
    ring:       'ring-red-400/60 dark:ring-red-500/50',
    headerBg:   'bg-gradient-to-r from-red-500 to-red-600 dark:from-red-600 dark:to-red-700',
    headerText: 'text-white',
    bodyBg:     'bg-red-50/60 dark:bg-red-950/30',
    accent:     'text-red-700 dark:text-red-300',
    dotOn:      'bg-red-500 dark:bg-red-400',
  },
};

/** Active sub-team filter for the SSD roster: a specific team, every member
 *  ('ALL'), or only the still-unassigned ('NONE'). */
export type SubTeamFilter = SubTeamName | 'ALL' | 'NONE';

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

function isoMonthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function isoWeekEnd(start: string): string {
  const d = new Date(start);
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

function isoMonthEnd(start: string): string {
  const [y, m] = start.split('-').map(Number);
  return new Date(y!, m!, 0).toISOString().slice(0, 10);
}

function periodEnd(dept: DeptConfig, start: string): string {
  return dept.cadence === 'weekly' ? isoWeekEnd(start) : isoMonthEnd(start);
}

/**
 * Per-employee bonus recompute for SSD Medical Records (team_split + team_pool
 * rules). `calcBonus` skips both rule types because their shares depend on
 * team-level pct/records/rfc held in `subTeams` state, not on `kpi_data`. This
 * computes the combined share and writes it into each entry's
 * `calculated_bonus` so dept totals, the View modal, and persisted
 * `hsl_bonus_entries.calculated_bonus` (read by PayrollWizard) all reflect
 * reality.
 *
 * Returns a new entries array; pass-through if not SSD.
 */
export function recomputeSsdEntries(
  deptKey: HslDeptKey,
  entries: EntryRow[],
  subTeams: Record<SubTeamName, SubTeamState>,
): EntryRow[] {
  if (deptKey !== 'ssd_medical_records') return entries;
  const splitRule = HSL_DEPTS.ssd_medical_records.rules.find(
    (r): r is TeamSplitRule => r.type === 'team_split',
  );
  const poolRule = HSL_DEPTS.ssd_medical_records.rules.find(
    (r): r is TeamPoolRule => r.type === 'team_pool',
  );
  const memberCounts: Record<string, number> = {};
  for (const e of entries) {
    const st = String(e.kpi_data.sub_team ?? '');
    if (st) memberCounts[st] = (memberCounts[st] ?? 0) + 1;
  }
  return entries.map((e) => {
    const st = String(e.kpi_data.sub_team ?? '') as SubTeamName | '';
    if (!st) return e.calculated_bonus === 0 ? e : { ...e, calculated_bonus: 0 };
    const sub = subTeams[st];
    const memberCount = memberCounts[st] ?? 0;
    const pct = parseFloat(sub.pct) || 0;
    const records = parseInt(sub.records, 10) || 0;
    const rfc = parseInt(sub.rfc, 10) || 0;
    const splitShare = splitRule ? calcTeamSplitShare(pct, records, memberCount, splitRule) : 0;
    const poolShare = poolRule ? calcTeamPoolShare(rfc, memberCount, poolRule) : 0;
    const share = splitShare + poolShare;
    return e.calculated_bonus === share ? e : { ...e, calculated_bonus: share };
  });
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
): EntryRow[] {
  if (!HSL_DEPTS[deptKey].perEmployee) return entries;
  return entries.map((e) => {
    const bonus = calcManagerBonus(e.employee_email, e.kpi_data);
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
  sub_team: SubTeamName | null;
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
  /** Start focused on this HSL sub-department (filter pre-selected, block
   *  expanded). Used by the Payroll Readiness "fix it from here" modal, which
   *  also scopes `managedDepts` to the same key so only that sub-dept renders. */
  initialFilter?: HslDeptKey;
  /** Where a Mark-Ready/Lock submission originates, recorded in the audit log.
   *  Omit for the manager's own KPI tab (defaults to "manager_kpi" server-side);
   *  the Payroll Wizard Readiness modal passes its own source. */
  submissionSource?: string;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HslBonusCalculator({
  viewerEmail,
  managedDepts,
  isElevated,
  initialFilter,
  submissionSource,
}: HslBonusCalculatorProps) {
  const today = new Date();
  const [weekStart, setWeekStart] = useState(() => isoWeekStart(today));
  const [monthStart] = useState(() => isoMonthStart(today));
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
   * weeks. So weekly branches stay gated until this flips true.
   */
  const [weekResolved, setWeekResolved] = useState(false);
  /** Resolution failed outright (after retries) — say so instead of silently
   *  scoring the wrong week. */
  const [weekError, setWeekError] = useState(false);

  const visibleDepts = useMemo<HslDeptKey[]>(
    () => HSL_DEPT_KEYS.filter((k) => canAccessHslDept(managedDepts, k, isElevated)),
    [managedDepts, isElevated],
  );

  const [deptState, setDeptState] = useState<AllDeptState>(() => {
    const init = {} as AllDeptState;
    for (const k of HSL_DEPT_KEYS) {
      init[k] = {
        entries: [],
        status: 'draft',
        subTeams: { ...DEFAULT_SUB_TEAMS },
        dirty: false,
        saving: false,
        rosterEmails: new Set(),
      };
    }
    return init;
  });

  const [loadingDepts, setLoadingDepts] = useState<Set<HslDeptKey>>(new Set());
  /** Which dept's preview modal is open (null = closed). Mounted at the parent so
   *  it overlays the page rather than nesting inside a single dept block. */
  const [viewingDept, setViewingDept] = useState<HslDeptKey | null>(null);
  const [reopenSubmitting, setReopenSubmitting] = useState(false);
  const { state: dispatchLock } = useDispatchLock();
  const payrollLocked = dispatchLock.locked;

  // Department navigation: which dept's block is expanded, and the active filter
  // pill. With many HSL branches visible at once a flat stack is unreadable, so
  // "All" shows a collapsed overview and a single dept can be focused.
  const [activeFilter, setActiveFilter] = useState<HslDeptKey | 'all'>(initialFilter ?? 'all');
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});
  /** Cross-branch people search: type a work email (or a name) and only the
   *  branches that score that person stay on screen, expanded and pre-filtered. */
  const [personSearch, setPersonSearch] = useState('');
  /** Which dept's "add external member" modal is open (null = closed). */
  const [addingMemberDept, setAddingMemberDept] = useState<HslDeptKey | null>(null);
  // Recently offboarded people (final bonuses may still be owed) — fetched once
  // and shared by the per-dept Offboarded strips and the add-member modal.
  const { people: offboardedPeople, hoursWeekFloor: offboardedHoursFloor } = useOffboardedPeople(true);
  // Only the ones still in their FINAL pay cycle for the week in view: left
  // during/after the scored week, or logged hours in it. Anyone who left
  // before the scored week started got their last check in an earlier run —
  // re-offering them here only invites double-paying an old bonus. (Monthly
  // branches use the same weekly rule: once the final check is out, nothing
  // can pay a late-scored bonus anyway.) Until the week resolves to a real
  // payroll Sunday, the Monday local-clock seed would filter against the WRONG
  // week — skip scoping until then ('' = no filter).
  const offboardedForWeek = useMemo(
    () =>
      offboardedPeople.filter((p) =>
        offboardedRelevantToWeek(p, weekResolved ? weekStart : '', offboardedHoursFloor),
      ),
    [offboardedPeople, offboardedHoursFloor, weekStart, weekResolved],
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
      for (const key of HSL_DEPT_KEYS) {
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

  function periodStart(dept: DeptConfig): string {
    return dept.cadence === 'weekly' ? weekStart : monthStart;
  }

  function setDept(key: HslDeptKey, patch: Partial<DeptState>) {
    setDeptState((prev) => ({ ...prev, [key]: { ...prev[key]!, ...patch } }));
  }

  function patchEntry(key: HslDeptKey, email: string, patch: Partial<EntryRow>) {
    setDeptState((prev) => {
      const d = prev[key]!;
      return {
        ...prev,
        [key]: {
          ...d,
          dirty: true,
          entries: d.entries.map((e) =>
            e.employee_email === email ? { ...e, ...patch } : e,
          ),
        },
      };
    });
  }

  // ── External members ───────────────────────────────────────────────────────
  // "Add external member" appends an off-roster person to a dept's calculator.
  // No employee/roster record is created — the saved hsl_bonus_entries row is the
  // single source of truth, so they flow to payroll through the normal Save →
  // Mark Ready path exactly like a roster member.

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
    const start = periodStart(HSL_DEPTS[key]);
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

  const loadDept = useCallback(async (key: HslDeptKey) => {
    const dept = HSL_DEPTS[key];
    // A weekly branch's period key is the Hubstaff upload's week — reading before
    // that resolves queries a key nothing was ever saved under, which is what made
    // one manager's scores look empty on another account. Monthly branches key on
    // the 1st of the month, which the local clock already knows.
    if (dept.cadence === 'weekly' && !weekResolved) return;
    const start = periodStart(dept);
    setLoadingDepts((prev) => new Set([...prev, key]));
    try {
      const [entriesRes, statusRes, membersRes] = await Promise.all([
        fetch(`/api/hsl-bonus/entries?dept=${key}&period_start=${start}`, { cache: 'no-store' }),
        fetch(`/api/hsl-bonus/period-status?dept=${key}&period_start=${start}`, { cache: 'no-store' }),
        fetch(`/api/hsl-bonus/team-members?dept=${key}`, { cache: 'no-store' }),
      ]);
      const entriesJson = (await entriesRes.json()) as { rows?: {
        id: string; employee_email: string; employee_name: string | null;
        is_manager: boolean; kpi_data: KpiData; calculated_bonus: number;
      }[] };
      const statusJson = (await statusRes.json()) as { rows?: { status: BonusStatus }[] };
      const membersJson = (await membersRes.json()) as { rows?: HslMember[] };

      // DB entries (existing scored data) — these win over roster defaults
      const byEmail = new Map<string, EntryRow>();
      (entriesJson.rows ?? []).forEach((r) => {
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
      // Pre-fill kpi_data.sub_team for SSD so the dropdown reflects the seeded assignment.
      // rosterEmails tracks the true roster so manually-added external members
      // (email not in the roster) can be tagged + removed.
      const rosterEmails = new Set<string>();
      (membersJson.rows ?? []).forEach((m) => {
        const email = m.email.toLowerCase();
        if (!email) return;
        rosterEmails.add(email);
        if (byEmail.has(email)) return;
        const kpi: KpiData = {};
        if (m.sub_team) (kpi as unknown as Record<string, string>).sub_team = m.sub_team;
        byEmail.set(email, {
          employee_email: email,
          employee_name: m.full_name ?? m.hsl_name ?? email,
          is_manager: m.is_manager,
          kpi_data: kpi,
          calculated_bonus: 0,
        });
      });

      // Managers Weekly dept: the roster is the hardcoded HSL_MANAGERS cohort,
      // not hsl_team_members. Seed any manager not already present so the dept
      // always shows its full lineup even before anything has been scored.
      if (dept.perEmployee) {
        HSL_MANAGERS.forEach((mgr) => {
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

      const sortedEntries = Array.from(byEmail.values()).sort((a, b) =>
        a.employee_name.localeCompare(b.employee_name),
      );
      const status: BonusStatus = statusJson.rows?.[0]?.status ?? 'draft';
      // After load, recompute per-employee amounts (SSD team-split shares and
      // Managers Weekly component sums) so the dept total + table read the right
      // values (DB persists 0 for legacy/unscored entries).
      setDeptState((prev) => {
        const cur = prev[key]!;
        // Never clobber in-flight local work: refreshAll checks `dirty` when it
        // DISPATCHES, but this fetch can land after the user has since edited or
        // added a member (parent re-renders also re-run the boot effect). Guard
        // at write time so unsaved entries survive any reload path.
        if (cur.dirty || cur.saving) return prev;
        let recomputed = recomputeSsdEntries(key, sortedEntries, cur.subTeams);
        recomputed = recomputeManagerEntries(key, recomputed);
        return {
          ...prev,
          [key]: { ...cur, entries: recomputed, status, dirty: false, rosterEmails },
        };
      });
    } catch {
      // silent — table may be empty on first use
    } finally {
      setLoadingDepts((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [weekStart, monthStart, weekResolved]); // eslint-disable-line react-hooks/exhaustive-deps

  // First-load gate: show a loading screen until every visible dept's initial
  // fetch has settled, so switching to the tab doesn't flash an empty calculator.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all(visibleDepts.map((k) => loadDept(k)));
      // Stay on the loading screen until the payroll week is known either way —
      // weekly branches skip their fetch while it's unresolved, so flipping
      // `booted` first would flash an empty calculator that looks like "no scores".
      if (!cancelled && (weekResolved || weekError)) setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [visibleDepts, loadDept]);

  // ── Live refresh ───────────────────────────────────────────────────────────
  // Reload every visible dept, but skip any with unsaved local edits (`dirty`)
  // or an in-flight save so another scorer's change can't clobber work in
  // progress. Used by both the manual Refresh button and the live subscription.
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = useCallback(async () => {
    await Promise.all(
      visibleDepts.map((k) => {
        const d = deptState[k];
        if (d?.dirty || d?.saving) return Promise.resolve();
        return loadDept(k);
      }),
    );
  }, [visibleDepts, deptState, loadDept]);

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
    }
  }, [refreshAll]);

  // See teammates' scoring as it lands: watch the entry + status tables and
  // re-pull (debounced). Falls back to a 30s poll + tab-focus refresh when
  // Realtime isn't available for these tables.
  useLiveRefresh({
    tables: ['hsl_bonus_entries', 'hsl_bonus_period_status'],
    onRefresh: refreshAll,
    channel: 'hsl-bonus-calc-live',
    enabled: visibleDepts.length > 0,
  });

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
            const d = range.start;
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (cancelled) return;
            setWeekStart(iso);
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

  async function saveDept(key: HslDeptKey) {
    const d = deptState[key]!;
    const dept = HSL_DEPTS[key];
    // Refuse rather than strand the work: an unresolved week would write this
    // dept-week under a key no reader asks for (invisible scores, and a duplicate
    // if it's re-scored later under the right key).
    if (dept.cadence === 'weekly' && !weekResolved) {
      toast.error('Payroll week not confirmed', {
        description: 'Reload the page before saving — scores saved now would not be visible to anyone else.',
      });
      return;
    }
    const start = periodStart(dept);
    const end = periodEnd(dept, start);

    setDept(key, { saving: true });
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

      setDept(key, { dirty: false });
      toast.success(`${dept.name} saved`, { description: `${json.saved ?? 0} entries updated` });
    } catch (e) {
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setDept(key, { saving: false });
    }
  }

  async function setStatus(key: HslDeptKey, next: BonusStatus): Promise<boolean> {
    const dept = HSL_DEPTS[key];
    // Same reason as saveDept: a status row on an unresolved week is a dept-week
    // Readiness will never see, so the branch would read "Pending" forever.
    if (dept.cadence === 'weekly' && !weekResolved) {
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
    const d = deptState[key]!;
    if (d.dirty) {
      toast.error('Save your changes first', {
        description: 'Click Save before marking the period Ready.',
      });
      return;
    }
    const ok = await setStatus(key, 'ready');
    if (ok) {
      toast.success(`${HSL_DEPTS[key].name} marked ready`, {
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
      toast.success(`${HSL_DEPTS[key].name} reopened`, {
        description: 'Back to draft — make edits and Mark Ready when done.',
      });
      setViewingDept(null);
    }
  }

  function ssdShareForTeam(subTeam: SubTeamName, memberCount: number): number {
    const d = deptState.ssd_medical_records!;
    const st = d.subTeams[subTeam];
    const pct = parseFloat(st.pct) || 0;
    const records = parseInt(st.records, 10) || 0;
    const rfc = parseInt(st.rfc, 10) || 0;
    const splitRule = HSL_DEPTS.ssd_medical_records.rules.find(
      (r): r is TeamSplitRule => r.type === 'team_split',
    )!;
    const poolRule = HSL_DEPTS.ssd_medical_records.rules.find(
      (r): r is TeamPoolRule => r.type === 'team_pool',
    );
    const splitShare = calcTeamSplitShare(pct, records, memberCount, splitRule);
    const poolShare = poolRule ? calcTeamPoolShare(rfc, memberCount, poolRule) : 0;
    return splitShare + poolShare;
  }

  function exportCsv() {
    const headers = ['Department', 'Period', 'Employee', 'Email', 'Bonus (PHP)', 'Status'];
    const rows: string[] = [];
    for (const key of visibleDepts) {
      const dept = HSL_DEPTS[key];
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

  const totalPeople = useMemo(
    () => visibleDepts.reduce((sum, k) => sum + deptState[k]!.entries.length, 0),
    [deptState, visibleDepts],
  );

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

  const filteredDepts = useMemo<HslDeptKey[]>(() => {
    // A people search spans every branch — it outranks the focus pill, otherwise
    // you'd have to already know which branch the person sits in.
    if (personQuery) return personHitDepts;
    return activeFilter === 'all' ? visibleDepts : visibleDepts.filter((k) => k === activeFilter);
  }, [personQuery, personHitDepts, activeFilter, visibleDepts]);

  // "All" overview lays the collapsed branches out as a grid; an expanded card
  // spans the full width so its wide tables aren't squeezed into one column.
  const gridMode = !personQuery && activeFilter === 'all' && multiDept;

  /** A block is expanded when: only one dept exists, it's the focused filter,
   *  a people search matched inside it, or the user manually opened it. With
   *  multiple depts under "All" the blocks start collapsed so the page reads as
   *  a tidy overview. */
  function isOpen(key: HslDeptKey): boolean {
    if (personQuery) return true; // searched branches always show their match
    if (key in manualOpen) return manualOpen[key]!;
    if (!multiDept) return true;
    return activeFilter === key;
  }

  function toggleOpen(key: HslDeptKey) {
    setManualOpen((m) => ({ ...m, [key]: !isOpen(key) }));
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
        title={
          isElevated
            ? 'All Departments'
            : visibleDepts.length === 1
              ? HSL_DEPTS[visibleDepts[0]!].name
              : 'My Departments'
        }
        cards={visibleDepts.length}
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
              {isElevated ? 'All Departments' : visibleDepts.length === 1 ? HSL_DEPTS[visibleDepts[0]!].name : 'My Departments'}
              <span className="ml-2 font-mono text-xs font-normal text-zinc-500">
                week of {weekStart}
              </span>
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">Total</span>
              <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                <AnimatedPeso amount={grandTotal} />
              </span>
              <span className="font-mono text-[10px] text-zinc-500">{totalPeople} ppl</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void manualRefresh()}
              disabled={refreshing}
              title="Reload scores (also updates live as teammates edit)"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
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
            weekly branches are held back rather than scored against a guessed
            week key (which is invisible to everyone else — see `weekResolved`). */}
        {weekError && (
          <div
            role="alert"
            className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-200"
          >
            <span className="font-semibold">Couldn&apos;t confirm the payroll week.</span> Weekly
            branches are paused — anything scored now would be saved under the wrong week and
            wouldn&apos;t be visible to Accounting or the other managers. Reload the page to try
            again.
          </div>
        )}

        {/* Department filter rail — focus one branch or scan them all, plus a
            cross-branch people search (find someone by work email). */}
        {multiDept && (
          <div className="flex flex-wrap items-center gap-2">
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
            <div className="-mx-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1 pb-0.5">
              <DeptPill
                active={!personQuery && activeFilter === 'all'}
                label="All"
                count={visibleDepts.length}
                onClick={() => {
                  setPersonSearch('');
                  setActiveFilter('all');
                }}
              />
              {visibleDepts.map((k) => (
                <DeptPill
                  key={k}
                  active={!personQuery && activeFilter === k}
                  label={HSL_DEPTS[k].name}
                  color={HSL_DEPTS[k].color}
                  count={deptState[k]!.entries.length}
                  onClick={() => {
                    // Picking a branch ends the cross-branch search — the two
                    // filters would otherwise fight over what's on screen.
                    setPersonSearch('');
                    setActiveFilter(k);
                    setManualOpen((m) => ({ ...m, [k]: true }));
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {personQuery && (
          <p className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            {personHitDepts.length === 0
              ? `No one matches “${personSearch.trim()}” in your branches.`
              : `Matched in ${personHitDepts.length} ${personHitDepts.length === 1 ? 'branch' : 'branches'}: ${personHitDepts.map((k) => HSL_DEPTS[k].name).join(', ')}`}
          </p>
        )}
      </div>

      {/* Payroll processing lock banner */}
      {payrollLocked && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span>Payroll is being processed — KPI Calculator is locked. You cannot mark ready or unready until processing is complete.</span>
        </div>
      )}

      {/* Department blocks */}
      <div
        className={cn(
          'px-4 py-5 sm:px-6',
          gridMode
            ? 'grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3'
            : 'flex flex-col gap-4',
        )}
      >
        {filteredDepts.map((key) => (
          <DeptBlock
            key={key}
            deptKey={key}
            state={deptState[key]!}
            loading={loadingDepts.has(key)}
            collapsible={multiDept}
            open={isOpen(key)}
            searchSeed={personSearch}
            sectionClassName={cn(gridMode && isOpen(key) && 'sm:col-span-2 xl:col-span-3')}
            onToggleOpen={() => toggleOpen(key)}
            periodStartStr={periodStart(HSL_DEPTS[key])}
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
                    // uniform rule engine.
                    calculated_bonus: HSL_DEPTS[key].perEmployee
                      ? calcManagerBonus(email, newKpi)
                      : calcBonus(newKpi, HSL_DEPTS[key], e.is_manager),
                  };
                });
                // For SSD, sub_team changes affect every team member's share —
                // the per-member denominator just changed. Recompute the whole list.
                const finalEntries = recomputeSsdEntries(key, next, d.subTeams);
                return { ...prev, [key]: { ...d, entries: finalEntries, dirty: true } };
              });
            }}
            onToggleManager={(email) => {
              setDeptState((prev) => {
                const d = prev[key]!;
                const next = d.entries.map((e) => {
                  if (e.employee_email !== email) return e;
                  const newIsManager = !e.is_manager;
                  return {
                    ...e,
                    is_manager: newIsManager,
                    calculated_bonus: HSL_DEPTS[key].perEmployee
                      ? calcManagerBonus(email, e.kpi_data)
                      : calcBonus(e.kpi_data, HSL_DEPTS[key], newIsManager),
                  };
                });
                // Re-share for SSD — toggling someone's manager flag doesn't
                // change the team_split share but we re-run the recompute so
                // calculated_bonus stays canonical (it was reset by calcBonus=0).
                const finalEntries = recomputeSsdEntries(key, next, d.subTeams);
                return { ...prev, [key]: { ...d, entries: finalEntries, dirty: true } };
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
            onSave={() => void saveDept(key)}
            onMarkReady={() => void markReady(key)}
            onMarkUnready={() => void reopenToDraft(key)}
            onView={() => setViewingDept(key)}
            payrollLocked={payrollLocked}
            markUnreadySubmitting={reopenSubmitting}
            onSubTeamChange={(subTeam, field, val) => {
              setDeptState((prev) => {
                const d = prev[key]!;
                const newSubTeams = {
                  ...d.subTeams,
                  [subTeam]: { ...d.subTeams[subTeam], [field]: val },
                };
                // Pct/records changed → recompute per-employee shares so dept
                // total and the persisted `calculated_bonus` reflect the new score.
                const newEntries = recomputeSsdEntries(key, d.entries, newSubTeams);
                return {
                  ...prev,
                  [key]: {
                    ...d,
                    dirty: true,
                    subTeams: newSubTeams,
                    entries: newEntries,
                  },
                };
              });
            }}
            ssdShareForTeam={key === 'ssd_medical_records' ? ssdShareForTeam : undefined}
          />
        ))}
      </div>

      {/* Read-only preview modal — opens on View button click. Reopen flips the
          period back to draft so the manager can edit again. */}
      <HslBonusReadyPreview
        open={viewingDept !== null}
        dept={viewingDept ? HSL_DEPTS[viewingDept] : null}
        status={
          viewingDept && deptState[viewingDept]!.status !== 'draft'
            ? (deptState[viewingDept]!.status as 'ready' | 'locked')
            : 'ready'
        }
        periodLabel={
          viewingDept
            ? periodLabel(HSL_DEPTS[viewingDept], periodStart(HSL_DEPTS[viewingDept]))
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
            deptName={HSL_DEPTS[addingMemberDept].name}
            color={HSL_DEPTS[addingMemberDept].color}
            offboarded={offboardedForWeek}
            onAdd={(name, email) => addMember(addingMemberDept, name, email)}
            onClose={() => setAddingMemberDept(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Department filter pill ──────────────────────────────────────────────────

function DeptPill({
  active, label, color, count, onClick,
}: {
  active: boolean;
  label: string;
  color?: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-transparent bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
          : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300 dark:hover:bg-zinc-800/60',
      )}
    >
      {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />}
      <span className="max-w-[10rem] truncate">{label}</span>
      <span className={cn('font-mono text-[10px] tabular-nums', active ? 'opacity-70' : 'text-zinc-400')}>{count}</span>
    </button>
  );
}

// ── DeptBlock ─────────────────────────────────────────────────────────────────

interface DeptBlockProps {
  deptKey: HslDeptKey;
  state: DeptState;
  loading: boolean;
  collapsible: boolean;
  open: boolean;
  /** Query pushed down from the top bar's cross-branch people search. Whenever
   *  it changes it takes over this block's own search box, so a branch that
   *  surfaced from a work-email search opens already filtered to that person. */
  searchSeed?: string;
  sectionClassName?: string;
  onToggleOpen: () => void;
  periodStartStr: string;
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  onToggleManager: (email: string) => void;
  onSave: () => void;
  onMarkReady: () => void;
  onMarkUnready: () => void;
  onView: () => void;
  onSubTeamChange: (subTeam: SubTeamName, field: 'pct' | 'records' | 'rfc', val: string) => void;
  ssdShareForTeam?: (subTeam: SubTeamName, memberCount: number) => number;
  payrollLocked: boolean;
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
  deptKey, state, loading, collapsible, open, searchSeed, sectionClassName, onToggleOpen, periodStartStr,
  onKpiChange, onToggleManager,
  onSave, onMarkReady, onMarkUnready, onView, onSubTeamChange, ssdShareForTeam,
  payrollLocked, markUnreadySubmitting,
  rosterEmails, offboardedEmails, onAddMember, offboardedSuggestions, onQuickAddOffboarded, onRemoveMember,
}: DeptBlockProps) {
  const dept = HSL_DEPTS[deptKey];
  const deptTotal = state.entries.reduce((s, e) => s + e.calculated_bonus, 0);
  const isTeamSplit = dept.rules[0]?.type === 'team_split';
  const tieredRule = dept.rules.find((r): r is TieredRule => r.type === 'tiered');
  const isLocked = state.status === 'locked';
  // Scoring is editable only in draft. Once a period is 'ready' (sent to
  // Accounting) or 'locked', inputs go read-only until it's reopened — this stops
  // silent edits that never get saved to the DB Accounting actually reads.
  const readOnly = state.status !== 'draft' || payrollLocked;

  function subTeamMemberCount(subTeam: SubTeamName): number {
    return state.entries.filter((e) => (e.kpi_data.sub_team as unknown as string) === subTeam).length;
  }

  // Per-dept search + pagination
  const [search, setSearch] = useState(searchSeed ?? '');
  const [page, setPage] = useState(1);

  // The top bar's cross-branch search drives this box; the manager can still
  // retype here afterwards (the effect only fires when the seed itself changes).
  useEffect(() => {
    if (searchSeed !== undefined) setSearch(searchSeed);
  }, [searchSeed]);

  // SSD sub-team filter — shared between the colored scoring boxes (left) and the
  // employee table (right) so clicking either surface filters the roster live.
  // 'ALL' shows everyone, 'NONE' shows only the unassigned.
  const [subTeamFilter, setSubTeamFilter] = useState<SubTeamFilter>('ALL');
  const toggleSubTeamFilter = useCallback((name: SubTeamName) => {
    setSubTeamFilter((prev) => (prev === name ? 'ALL' : name));
  }, []);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = state.entries;
    if (q) {
      list = list.filter((e) =>
        e.employee_name.toLowerCase().includes(q) || e.employee_email.toLowerCase().includes(q),
      );
    }
    if (isTeamSplit && subTeamFilter !== 'ALL') {
      list = list.filter((e) => {
        const st = String(e.kpi_data.sub_team ?? '');
        return subTeamFilter === 'NONE' ? !st : st === subTeamFilter;
      });
    }
    return list;
  }, [state.entries, search, subTeamFilter, isTeamSplit]);

  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / DEPT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * DEPT_PAGE_SIZE;
  const pagedEntries = filteredEntries.slice(pageStart, pageStart + DEPT_PAGE_SIZE);

  // Reset to page 1 whenever the search or sub-team filter changes
  useEffect(() => { setPage(1); }, [search, subTeamFilter]);

  const statusColors: Record<BonusStatus, string> = {
    draft:  'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
    ready:  'bg-amber-200 text-amber-900 dark:bg-amber-700/80 dark:text-amber-100',
    locked: 'bg-emerald-200 text-emerald-900 dark:bg-emerald-800/80 dark:text-emerald-100',
  };

  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60',
        sectionClassName,
      )}
      style={{ borderLeft: `3px solid ${dept.color}` }}
    >
      {/* Header — click to expand/collapse when several depts are visible */}
      <header
        className={cn(
          'flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-zinc-50/70 px-5 py-3.5 dark:border-zinc-800/80 dark:bg-zinc-900/40',
          collapsible && 'cursor-pointer select-none transition-colors hover:bg-zinc-100/70 dark:hover:bg-zinc-900/70',
        )}
        {...(collapsible
          ? {
              role: 'button' as const,
              tabIndex: 0,
              'aria-expanded': open,
              onClick: onToggleOpen,
              onKeyDown: (ev: React.KeyboardEvent) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onToggleOpen();
                }
              },
            }
          : {})}
      >
        {collapsible && (
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
              open ? 'rotate-180' : 'rotate-0',
            )}
            aria-hidden
          />
        )}
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
          <span className={cn('rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]', statusColors[state.status])}>
            {state.status}
          </span>
          {dept.monthlyMax && (
            <span className="font-mono text-[9px] text-zinc-500 dark:text-zinc-500">
              max {formatPeso(dept.monthlyMax)}/mo
            </span>
          )}
          <span className="font-mono text-[10px] text-zinc-500">· {periodLabel(dept, periodStartStr)}</span>
          {loading && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-zinc-500">
              <RefreshCw className="h-3 w-3 animate-spin" /> loading
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="font-mono text-[10px] text-zinc-500">{state.entries.length} ppl</span>
          <span className="font-mono text-base font-bold tabular-nums" style={{ color: dept.color }}>
            <AnimatedPeso amount={deptTotal} />
          </span>
        </div>
      </header>

      {/* Body */}
      <AnimatePresence initial={false}>
      {open && (
      <motion.div
        key="dept-body"
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ height: { duration: 0.36, ease: COLLAPSE_EASE }, opacity: { duration: 0.22, ease: 'easeOut' } }}
        className="overflow-hidden"
      >
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
              <div data-readonly-allow className="flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60">
                <button
                  type="button"
                  className="rounded p-1 text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-[3rem] text-center font-mono text-[10px] tabular-nums text-zinc-600 dark:text-zinc-400">
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  className="rounded p-1 text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
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

        {!dept.noKpi && !isTeamSplit && !dept.perEmployee && (
          <KpiTable
            dept={dept}
            entries={pagedEntries}
            subtotal={deptTotal}
            isLocked={readOnly}
            onKpiChange={onKpiChange}
            onToggleManager={onToggleManager}
            rosterEmails={rosterEmails}
            offboardedEmails={offboardedEmails}
            onRemoveMember={onRemoveMember}
          />
        )}

        {/* Managers Weekly — each manager has a bespoke incentive checklist. */}
        {dept.perEmployee && (
          <HslManagersTable
            entries={pagedEntries}
            subtotal={deptTotal}
            isLocked={readOnly}
            onKpiChange={onKpiChange}
            rosterEmails={rosterEmails}
            offboardedEmails={offboardedEmails}
            onRemoveMember={onRemoveMember}
          />
        )}

        {/* SSD: side-by-side at lg+ — sub-team scoring boxes (left), employee
            chip picker (right). `items-stretch` (default for grid) + the inner
            `h-full auto-rows-fr` on SsdSubTeamGrid keeps both columns and the
            6 boxes vertically aligned with the employee list. */}
        {isTeamSplit && ssdShareForTeam && !dept.noKpi && (
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col">
              <SsdSubTeamGrid
                subTeams={state.subTeams}
                isLocked={readOnly}
                onSubTeamChange={onSubTeamChange}
                ssdShareForTeam={ssdShareForTeam}
                subTeamMemberCount={subTeamMemberCount}
                activeFilter={subTeamFilter}
                onFilterToggle={toggleSubTeamFilter}
              />
            </div>
            <div className="flex min-w-0 flex-col">
              <SsdEmployeeTable
                entries={pagedEntries}
                allEntries={state.entries}
                isLocked={readOnly}
                ssdShareForTeam={ssdShareForTeam}
                onSubTeamAssign={(email, subTeam) =>
                  onKpiChange(email, 'sub_team', subTeam as unknown as number)
                }
                activeFilter={subTeamFilter}
                onFilterChange={setSubTeamFilter}
                rosterEmails={rosterEmails}
                offboardedEmails={offboardedEmails}
                onRemoveMember={onRemoveMember}
              />
            </div>
          </div>
        )}

        {/* Fallback for any team_split dept that has no KPI inputs (none today).
            No employee table here, so the boxes stay static (no filter toggle). */}
        {isTeamSplit && ssdShareForTeam && dept.noKpi && (
          <SsdSubTeamGrid
            subTeams={state.subTeams}
            isLocked={readOnly}
            onSubTeamChange={onSubTeamChange}
            ssdShareForTeam={ssdShareForTeam}
            subTeamMemberCount={subTeamMemberCount}
          />
        )}

        {/* Action bar — Save / Mark Ready (draft) → Mark as Unready + View (ready/locked). */}
        <div className="flex items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <span className="font-mono text-[10px] text-zinc-500">
            {state.status === 'draft' && state.dirty && !payrollLocked && 'Unsaved changes'}
            {state.status === 'draft' && !state.dirty && state.entries.length > 0 && !payrollLocked && 'Saved · ready to mark'}
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
            {state.status === 'draft' && state.dirty && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                disabled={state.saving || payrollLocked}
                onClick={onSave}
              >
                <Save className="h-3 w-3" />
                {state.saving ? 'Saving…' : 'Save'}
              </Button>
            )}
            {state.status === 'draft' && (
              <Button
                size="sm"
                className="h-7 gap-1.5 bg-amber-600 text-xs text-white hover:bg-amber-500 disabled:opacity-50"
                disabled={state.dirty || state.saving || state.entries.length === 0 || payrollLocked}
                title={
                  payrollLocked
                    ? 'KPI Calculator is locked while payroll is processing'
                    : state.dirty
                      ? 'Save your changes before marking ready'
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
      </motion.div>
      )}
      </AnimatePresence>
    </section>
  );
}

// ── KPI Table ─────────────────────────────────────────────────────────────────

interface KpiTableProps {
  dept: DeptConfig;
  entries: EntryRow[];
  subtotal: number;
  isLocked: boolean;
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  onToggleManager: (email: string) => void;
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

export function KpiTable({ dept, entries, subtotal, isLocked, onKpiChange, onToggleManager, rosterEmails, offboardedEmails, onRemoveMember }: KpiTableProps) {
  const rules = dept.rules.filter((r) => r.type !== 'team_split');

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="table-keep w-full min-w-[600px] text-xs">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
            <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Employee</th>
            <th className="px-2 py-2 text-center font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Mgr</th>
            {rules.map((r) => (
              <th key={r.key} className="px-2 py-2 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-500">
                {r.label}
                <span className="block font-normal text-zinc-400 dark:text-zinc-600">
                  {r.type === 'per_unit' ? formatPeso(r.rate, r.currency) :
                   r.type === 'flat' ? `${formatPeso(r.amount, r.currency)} flat` :
                   r.type === 'manual' ? 'manual ₱' :
                   'tiered'}
                </span>
              </th>
            ))}
            <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Bonus</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={rules.length + 3} className="px-3 py-6 text-center font-mono text-[10px] text-zinc-500">
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
              <td className="px-2 py-2 text-center">
                <input
                  type="checkbox"
                  className="accent-blue-600"
                  checked={e.is_manager}
                  disabled={isLocked}
                  onChange={() => onToggleManager(e.employee_email)}
                />
              </td>
              {rules.map((r) => (
                <td key={r.key} className="px-2 py-2 text-right">
                  {r.type === 'flat' ? (
                    r.managerOnly && !e.is_manager ? (
                      <span className="text-zinc-300 dark:text-zinc-700">n/a</span>
                    ) : (
                      <input
                        type="checkbox"
                        className="accent-amber-500"
                        checked={Boolean(e.kpi_data[r.key])}
                        disabled={isLocked}
                        onChange={(ev) => onKpiChange(e.employee_email, r.key, ev.target.checked)}
                      />
                    )
                  ) : r.type === 'manual' ? (
                    r.managerOnly && !e.is_manager ? (
                      <span className="text-zinc-300 dark:text-zinc-700">n/a</span>
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
              <td className="px-3 py-2 text-right font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                <AnimatedPeso amount={e.calculated_bonus} />
              </td>
            </tr>
            );
          })}
          <tr className="border-t border-zinc-300 bg-zinc-100/70 dark:border-zinc-700 dark:bg-zinc-900/60">
            <td colSpan={rules.length + 2} className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
              Subtotal
            </td>
            <td className="px-3 py-2 text-right font-mono font-bold text-zinc-900 dark:text-zinc-100">
              <AnimatedPeso amount={subtotal} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Managers Weekly Table ─────────────────────────────────────────────────────

interface HslManagersTableProps {
  entries: EntryRow[];
  subtotal: number;
  isLocked: boolean;
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  rosterEmails?: Set<string>;
  offboardedEmails?: Set<string>;
  onRemoveMember?: (email: string) => void;
}

/** The Managers Weekly dept renders one row per manager, each showing that
 *  person's own hardcoded incentive checklist (HSL_MANAGERS). Ticking a component
 *  adds its fixed amount; the row total sums every ticked component. */
export function HslManagersTable({
  entries, subtotal, isLocked, onKpiChange, rosterEmails, offboardedEmails, onRemoveMember,
}: HslManagersTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="table-keep w-full min-w-[600px] text-xs">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
            <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Manager</th>
            <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
              Incentives — tick what was met
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
            const spec = HSL_MANAGERS_BY_EMAIL[e.employee_email.toLowerCase()];
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
        Tiers stack — tick every threshold that was met. Items tagged
        <span className="mx-1 rounded bg-zinc-100 px-1 py-0.5 uppercase tracking-wider dark:bg-zinc-800">monthly</span>
        are earned only in the last payroll week of the month.
      </p>
    </div>
  );
}

// ── SSD Sub-team Grid ─────────────────────────────────────────────────────────

interface SsdSubTeamGridProps {
  subTeams: Record<SubTeamName, SubTeamState>;
  isLocked: boolean;
  onSubTeamChange: (subTeam: SubTeamName, field: 'pct' | 'records' | 'rfc', val: string) => void;
  ssdShareForTeam: (subTeam: SubTeamName, memberCount: number) => number;
  subTeamMemberCount: (subTeam: SubTeamName) => number;
  /** Currently-active roster filter (shared with the employee table). */
  activeFilter?: SubTeamFilter;
  /** Toggle the filter for a team — click the same team again to clear it. */
  onFilterToggle?: (subTeam: SubTeamName) => void;
}

export function SsdSubTeamGrid({
  subTeams, isLocked, onSubTeamChange, ssdShareForTeam, subTeamMemberCount,
  activeFilter = 'ALL', onFilterToggle,
}: SsdSubTeamGridProps) {
  const SUB_TEAM_NAMES: SubTeamName[] = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED'];
  const filterActive = activeFilter !== 'ALL';
  return (
    <div className="grid h-full auto-rows-fr gap-3 sm:grid-cols-2">
      {SUB_TEAM_NAMES.map((name) => {
        const st = subTeams[name];
        const members = subTeamMemberCount(name);
        const share = ssdShareForTeam(name, members || 1);
        const pct = parseFloat(st.pct) || 0;
        const tier: 'gold' | 'silver' | 'none' = pct >= 95 ? 'gold' : pct >= 90 ? 'silver' : 'none';
        const palette = SUB_TEAM_PALETTE[name];
        const tierLabel =
          tier === 'gold'   ? '≥ 95%  ·  ₱350 / record'
          : tier === 'silver' ? '90–94%  ·  ₱250 / record'
          : 'Below 90%  ·  no bonus';
        const tierStep = tier === 'gold' ? 3 : tier === 'silver' ? 2 : 1;
        const isPicked = activeFilter === name;       // this box drives the filter
        const isDimmed = filterActive && !isPicked;   // another team is being viewed

        return (
          <div
            key={name}
            className={cn(
              'group/box relative overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm ring-1 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:border-zinc-800 dark:bg-zinc-950/40',
              palette.ring,
              tier === 'gold' && 'shadow-md',
              isPicked && 'scale-[1.015] shadow-lg ring-2',
              isDimmed && 'scale-[0.99] opacity-55 saturate-[0.7]',
            )}
          >
            {/* Header — doubles as the filter toggle for this team */}
            <button
              type="button"
              onClick={() => onFilterToggle?.(name)}
              aria-pressed={isPicked}
              title={isPicked ? `Showing ${name} only — click to show all` : `Filter roster to ${name}`}
              className={cn(
                'flex w-full items-center justify-between px-3 py-2 text-left transition-[filter] duration-200',
                palette.headerBg, palette.headerText,
                onFilterToggle ? 'cursor-pointer hover:brightness-110 active:brightness-95' : 'cursor-default',
              )}
            >
              <span className="flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-[0.2em]">
                <Filter
                  className={cn(
                    'h-3 w-3 transition-all duration-300',
                    isPicked ? 'scale-100 opacity-100' : 'scale-75 opacity-0 group-hover/box:opacity-60',
                  )}
                  aria-hidden
                />
                {name}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold backdrop-blur-sm transition-colors',
                  isPicked ? 'bg-white/40 ring-1 ring-white/60' : 'bg-white/25',
                )}
              >
                {members} {members === 1 ? 'member' : 'members'}
              </span>
            </button>

            {/* Body */}
            <div className={cn('px-3 py-3', palette.bodyBg)}>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
                    Accuracy %
                  </label>
                  <div className="relative">
                    <input
                      type="number" step="0.01" min={0} max={100}
                      className="h-9 w-full rounded-md border border-zinc-300 bg-white pl-2 pr-7 font-mono text-sm font-medium text-zinc-900 shadow-inner outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-200 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-700"
                      value={st.pct}
                      disabled={isLocked}
                      placeholder="0.00"
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => onSubTeamChange(name, 'pct', e.target.value)}
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-zinc-400">%</span>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
                    Records
                  </label>
                  <input
                    type="number" min={0}
                    className="h-9 w-full rounded-md border border-zinc-300 bg-white px-2 font-mono text-sm font-medium text-zinc-900 shadow-inner outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-200 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-700"
                    value={st.records}
                    disabled={isLocked}
                    placeholder="0"
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => onSubTeamChange(name, 'records', e.target.value)}
                  />
                </div>
              </div>

              {/* RFC — pooled at a flat ₱250/record and split evenly across the
                  team's headcount, independent of the accuracy tier above. */}
              <div className="mt-2">
                <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
                  RFC · ₱250/record, pooled
                </label>
                <input
                  type="number" min={0}
                  className="h-9 w-full rounded-md border border-zinc-300 bg-white px-2 font-mono text-sm font-medium text-zinc-900 shadow-inner outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-200 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-700"
                  value={st.rfc}
                  disabled={isLocked}
                  placeholder="0"
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => onSubTeamChange(name, 'rfc', e.target.value)}
                />
              </div>

              {/* Tier indicator + share */}
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-200/80 pt-2.5 dark:border-zinc-800/80">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1">
                    {[1, 2, 3].map((step) => (
                      <span
                        key={step}
                        className={cn(
                          'h-1.5 w-5 rounded-full transition-colors',
                          step <= tierStep ? palette.dotOn : 'bg-zinc-200 dark:bg-zinc-800',
                        )}
                        aria-hidden
                      />
                    ))}
                  </div>
                  <span className={cn('font-mono text-[10px] font-medium', palette.accent)}>
                    {tierLabel}
                  </span>
                </div>
                <div className="text-right">
                  <div className={cn('font-mono text-base font-bold tabular-nums leading-none', palette.accent)}>
                    <AnimatedPeso amount={share} />
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-500">
                    per member
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── SSD Employee Table ────────────────────────────────────────────────────────

interface SsdEmployeeTableProps {
  entries: EntryRow[];
  allEntries: EntryRow[];
  isLocked: boolean;
  ssdShareForTeam: (subTeam: SubTeamName, memberCount: number) => number;
  onSubTeamAssign: (email: string, subTeam: SubTeamName | '') => void;
  /** Active roster filter, shared with the colored scoring boxes. */
  activeFilter?: SubTeamFilter;
  /** Set the active roster filter. */
  onFilterChange?: (f: SubTeamFilter) => void;
  rosterEmails?: Set<string>;
  offboardedEmails?: Set<string>;
  onRemoveMember?: (email: string) => void;
}

/** Colored sub-team chip picker. Replaces the native <select> — clicking a chip
 *  assigns that sub-team. Selected chip uses the sub-team's gradient header
 *  palette so the row's affiliation is visible at a glance. */
export function SubTeamChips({
  value,
  onChange,
  isLocked,
}: {
  value: SubTeamName | '';
  onChange: (v: SubTeamName | '') => void;
  isLocked: boolean;
}) {
  const SUB_TEAM_NAMES: SubTeamName[] = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED'];
  return (
    <div className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        disabled={isLocked}
        onClick={() => onChange('')}
        className={cn(
          'rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors',
          value === ''
            ? 'bg-zinc-200 text-zinc-700 ring-1 ring-zinc-300 dark:bg-zinc-700 dark:text-zinc-200 dark:ring-zinc-600'
            : 'text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300',
          isLocked && 'cursor-not-allowed opacity-60',
        )}
      >
        none
      </button>
      {SUB_TEAM_NAMES.map((name) => {
        const palette = SUB_TEAM_PALETTE[name];
        const selected = value === name;
        return (
          <button
            key={name}
            type="button"
            disabled={isLocked}
            onClick={() => onChange(name)}
            title={`Assign to ${name}`}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all',
              selected
                ? `${palette.headerBg} ${palette.headerText} shadow-sm`
                : 'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-500 dark:ring-zinc-800 dark:hover:text-zinc-300',
              isLocked && 'cursor-not-allowed opacity-60',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                selected ? 'bg-white/85' : palette.dotOn,
              )}
            />
            {name}
          </button>
        );
      })}
    </div>
  );
}

export function SsdEmployeeTable({
  entries, allEntries, isLocked, ssdShareForTeam, onSubTeamAssign,
  activeFilter = 'ALL', onFilterChange, rosterEmails, offboardedEmails, onRemoveMember,
}: SsdEmployeeTableProps) {
  const SUB_TEAM_NAMES: SubTeamName[] = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED'];

  // Member counts must reflect every entry in the dept, not just the current page
  const memberCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of allEntries) {
      const st = String(e.kpi_data.sub_team ?? '');
      if (st) counts[st] = (counts[st] ?? 0) + 1;
    }
    return counts;
  }, [allEntries]);

  const unassignedCount = useMemo(
    () => allEntries.filter((e) => !String(e.kpi_data.sub_team ?? '')).length,
    [allEntries],
  );

  // ── Bulk selection ──────────────────────────────────────────────────────────
  // Selection is keyed by email so it survives pagination; checkboxes only show
  // for the rows currently on the page.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Drop any selected emails that no longer exist (e.g. roster changed).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(allEntries.map((e) => e.employee_email));
      let changed = false;
      const next = new Set<string>();
      for (const em of prev) {
        if (valid.has(em)) next.add(em);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allEntries]);

  const pageEmails = entries.map((e) => e.employee_email);
  const allPageSelected = pageEmails.length > 0 && pageEmails.every((em) => selected.has(em));
  const somePageSelected = pageEmails.some((em) => selected.has(em));

  const selectAllRef = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = somePageSelected && !allPageSelected;
  }, [somePageSelected, allPageSelected]);

  function toggleOne(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageEmails.forEach((em) => next.delete(em));
      else pageEmails.forEach((em) => next.add(em));
      return next;
    });
  }

  function bulkAssign(target: SubTeamName | '') {
    if (selected.size === 0) return;
    // Each call composes via functional setState in the parent, so looping is safe.
    selected.forEach((em) => onSubTeamAssign(em, target));
    setSelected(new Set());
  }

  return (
    <div className="flex h-full flex-col gap-2">
      {/* Filter bar — view the roster one team at a time. Stays in sync with the
          colored scoring boxes: clicking a box sets the same filter. */}
      {onFilterChange && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50/70 px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
            <Filter className="h-3 w-3" /> Filter
          </span>
          <button
            type="button"
            onClick={() => onFilterChange('ALL')}
            aria-pressed={activeFilter === 'ALL'}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all duration-200',
              activeFilter === 'ALL'
                ? 'bg-zinc-800 text-white shadow-sm dark:bg-zinc-200 dark:text-zinc-900'
                : 'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800 dark:hover:text-zinc-200',
            )}
          >
            All
            <span className={cn('tabular-nums', activeFilter === 'ALL' ? 'opacity-80' : 'opacity-60')}>{allEntries.length}</span>
          </button>
          {SUB_TEAM_NAMES.map((name) => {
            const palette = SUB_TEAM_PALETTE[name];
            const active = activeFilter === name;
            const count = memberCounts[name] ?? 0;
            return (
              <button
                key={name}
                type="button"
                onClick={() => onFilterChange(active ? 'ALL' : name)}
                aria-pressed={active}
                title={active ? `Showing ${name} only — click to show all` : `Show ${name} only`}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all duration-200',
                  active
                    ? `${palette.headerBg} ${palette.headerText} scale-105 shadow-sm`
                    : 'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800 dark:hover:text-zinc-200',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full transition-colors', active ? 'bg-white/85' : palette.dotOn)} />
                {name}
                <span className={cn('tabular-nums', active ? 'opacity-80' : 'opacity-60')}>{count}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onFilterChange(activeFilter === 'NONE' ? 'ALL' : 'NONE')}
            aria-pressed={activeFilter === 'NONE'}
            title={activeFilter === 'NONE' ? 'Showing unassigned only — click to show all' : 'Show unassigned only'}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all duration-200',
              activeFilter === 'NONE'
                ? 'bg-zinc-600 text-white shadow-sm dark:bg-zinc-400 dark:text-zinc-900'
                : 'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800 dark:hover:text-zinc-200',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', activeFilter === 'NONE' ? 'bg-white/85' : 'bg-zinc-300 dark:bg-zinc-600')} />
            Unassigned
            <span className={cn('tabular-nums', activeFilter === 'NONE' ? 'opacity-80' : 'opacity-60')}>{unassignedCount}</span>
          </button>
          {activeFilter !== 'ALL' && (
            <button
              type="button"
              onClick={() => onFilterChange('ALL')}
              className="ml-auto inline-flex items-center gap-0.5 font-mono text-[10px] text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
            >
              <X className="h-3 w-3" /> clear
            </button>
          )}
        </div>
      )}

      {/* Bulk-assign bar */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors',
          selected.size > 0
            ? 'border-blue-300 bg-blue-50/70 dark:border-blue-800/70 dark:bg-blue-950/30'
            : 'border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40',
        )}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
          {selected.size > 0 ? (
            <span className="font-semibold text-blue-700 dark:text-blue-300">{selected.size} selected</span>
          ) : (
            'Tick rows to bulk-assign'
          )}
        </span>
        <span className="font-mono text-[10px] text-zinc-400">→ assign to</span>
        <div className="flex flex-wrap items-center gap-1">
          {SUB_TEAM_NAMES.map((name) => {
            const palette = SUB_TEAM_PALETTE[name];
            return (
              <button
                key={name}
                type="button"
                disabled={isLocked || selected.size === 0}
                onClick={() => bulkAssign(name)}
                title={`Assign ${selected.size} selected to ${name}`}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all',
                  selected.size > 0
                    ? `${palette.headerBg} ${palette.headerText} shadow-sm hover:brightness-105`
                    : 'bg-white text-zinc-400 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-600 dark:ring-zinc-800',
                  (isLocked || selected.size === 0) && 'cursor-not-allowed opacity-50',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', selected.size > 0 ? 'bg-white/85' : palette.dotOn)} />
                {name}
              </button>
            );
          })}
          <button
            type="button"
            disabled={isLocked || selected.size === 0}
            onClick={() => bulkAssign('')}
            title={`Clear sub-team for ${selected.size} selected`}
            className={cn(
              'rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors',
              'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800',
              (isLocked || selected.size === 0) && 'cursor-not-allowed opacity-50',
            )}
          >
            none
          </button>
        </div>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto font-mono text-[10px] text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
          >
            clear
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="table-keep w-full min-w-[600px] text-xs">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
              <th className="w-9 px-2 py-2 text-center">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="accent-blue-600"
                  checked={allPageSelected}
                  disabled={isLocked || pageEmails.length === 0}
                  onChange={toggleAllOnPage}
                  aria-label="Select all on this page"
                />
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Employee</th>
              <th className="px-2 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Sub-Team</th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Share</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center font-mono text-[10px] text-zinc-500">
                  {activeFilter === 'NONE'
                    ? 'Everyone has a team — nothing unassigned.'
                    : activeFilter !== 'ALL'
                    ? `No ${activeFilter} members on this page.`
                    : 'No employees on this page.'}
                </td>
              </tr>
            )}
            {entries.map((e, i) => {
              const subTeam = String(e.kpi_data.sub_team ?? '') as SubTeamName | '';
              const memberCount = subTeam ? (memberCounts[subTeam] ?? 0) : 0;
              const share = subTeam ? ssdShareForTeam(subTeam, memberCount) : 0;
              const palette = subTeam ? SUB_TEAM_PALETTE[subTeam] : null;
              const isSel = selected.has(e.employee_email);
              return (
                <tr
                  // Key includes the active filter so rows remount — and replay the
                  // staggered cascade — every time the filter changes.
                  key={`${activeFilter}-${e.employee_email}`}
                  style={{ animation: `pab-row-in 0.32s cubic-bezier(0.22,1,0.36,1) ${Math.min(i * 35, 300)}ms both` }}
                  className={cn(
                    'border-b border-zinc-100 transition-colors hover:bg-zinc-50/60 dark:border-zinc-800/60 dark:hover:bg-zinc-900/40',
                    palette && palette.bodyBg,
                    isSel && 'bg-blue-50/70 dark:bg-blue-950/30',
                  )}
                >
                  <td className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      className="accent-blue-600"
                      checked={isSel}
                      disabled={isLocked}
                      onChange={() => toggleOne(e.employee_email)}
                      aria-label={`Select ${e.employee_name}`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                          <span className="truncate">{e.employee_name}</span>
                          {!!rosterEmails && !rosterEmails.has(e.employee_email) && (
                            <ExtChip email={e.employee_email} offboardedEmails={offboardedEmails} />
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-zinc-500">{e.employee_email}</div>
                      </div>
                      {!!rosterEmails && !rosterEmails.has(e.employee_email) && onRemoveMember && !isLocked && (
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
                  <td className="px-2 py-2">
                    <SubTeamChips
                      value={subTeam}
                      isLocked={isLocked}
                      onChange={(v) => onSubTeamAssign(e.employee_email, v)}
                    />
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right font-mono font-bold tabular-nums',
                      palette ? palette.accent : 'text-zinc-300 dark:text-zinc-700',
                    )}
                  >
                    {subTeam ? <AnimatedPeso amount={share} /> : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
 *  calculator and flows to payroll via the normal Save → Mark Ready path. */
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
                          <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            {c.department}
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
                              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                                {c.department}
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
                  {selected.offboarded ? 'Was in' : 'Currently in'}: {selected.department}
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
