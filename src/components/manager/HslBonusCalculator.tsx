'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle, AppWindow, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Download, Eye, History, Loader2, Lock, Maximize2, Minus, PanelRight, Plus,
  RefreshCw, RotateCcw, Search, Trash2, UserPlus, Users, X,
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
import { kpiCalculatorRevealed } from '@/lib/manager/kpi-calculator-reveal';
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
import {
  KPI_AUTOSAVE_DEBOUNCE_MS,
  kpiAutosaveGate,
  shouldRearmAutosave,
  subTeamInputsBlank,
} from '@/lib/manager/kpi-autosave';

import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
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

/** Each sub-team's colours live in CSS (see the `--ssd-*` block in index.css)
 *  rather than as Tailwind classes, because the same hue has to reach places a
 *  class cannot go: `color-mix()`, inline `style`, and an arbitrary-value
 *  utility. `varName` is the stem those four custom properties share. */
export interface SubTeamPalette {
  varName: string;
}

export const SUB_TEAM_PALETTE: Record<SubTeamName, SubTeamPalette> = {
  BLUE:   { varName: 'blue' },
  GREEN:  { varName: 'green' },
  YELLOW: { varName: 'yellow' },
  ORANGE: { varName: 'orange' },
  PURPLE: { varName: 'purple' },
  RED:    { varName: 'red' },
};

/** Active sub-team filter for the SSD roster: a specific team, every member
 *  ('ALL'), or only the still-unassigned ('NONE'). */
export type SubTeamFilter = SubTeamName | 'ALL' | 'NONE';

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
    // The team-level inputs are NOT persisted, so after a reload they are blank
    // while the saved shares are not. Recomputing then would zero every member
    // of the team on the strength of inputs nobody re-entered — under the Save
    // button that needed a click, under autosave it would land by itself. Hold
    // the existing share until the manager re-enters the team's numbers (a typed
    // 0 counts as entered, so a genuine zero score still writes).
    if (subTeamInputsBlank(sub) && e.calculated_bonus !== 0) return e;
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

  // Autosave bookkeeping. Scoring persists as the manager types (no Save
  // button), so three things have to be tracked outside render state:
  //  - `deptStateRef` because a debounced write fires from a timer and must send
  //    what is on screen NOW, not what was in the closure when the timer was set;
  //  - `autosaveTimers` so each dept debounces independently;
  //  - `autosaveFailedRef` so a failed write is not re-sent until the manager
  //    changes something (a failure leaves the dept dirty, which would otherwise
  //    re-arm the debounce forever). Identity of the entries/subTeams objects is
  //    the token — every mutation replaces them, so `!==` means "edited since".
  const deptStateRef = useRef<AllDeptState>(deptState);
  deptStateRef.current = deptState;
  const autosaveTimers = useRef<Partial<Record<HslDeptKey, ReturnType<typeof setTimeout>>>>({});
  /** The dept state each pending timer was armed for, so the debounce resets only
   *  when THAT dept changed — not whenever any other dept does. */
  const autosaveArmedRef = useRef<Partial<Record<HslDeptKey, DeptState>>>({});
  const autosaveFailedRef = useRef<Partial<Record<HslDeptKey, { entries: EntryRow[]; subTeams: Record<SubTeamName, SubTeamState> }>>>({});
  /** Last successful autosave per dept, for the inline "Saved HH:MM" status. */
  const [savedAt, setSavedAt] = useState<Partial<Record<HslDeptKey, number>>>({});
  /** Depts whose last autosave failed — the footer says so instead of a toast
   *  per keystroke, and Mark Ready stays blocked because `dirty` is still set. */
  const [autosaveError, setAutosaveError] = useState<Partial<Record<HslDeptKey, string>>>({});

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
    // A branch's period key is the Hubstaff upload's week — reading before that
    // resolves queries a key nothing was ever saved under, which is what made
    // one manager's scores look empty on another account. Applies to monthly
    // branches too now (see `periodStart`).
    if (!weekResolved) return;
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
  }, [weekStart, weekResolved]); // eslint-disable-line react-hooks/exhaustive-deps

  // First-load gate: show a loading screen until every visible dept's initial
  // fetch has settled, so switching to the tab doesn't flash an empty calculator.
  const [loadsSettled, setLoadsSettled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all(visibleDepts.map((k) => loadDept(k)));
      // Stay on the loading screen until the payroll week is known either way —
      // weekly branches skip their fetch while it's unresolved, so flipping this
      // first would flash an empty calculator that looks like "no scores".
      if (!cancelled && weekResolved) setLoadsSettled(true);
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
  const booted = kpiCalculatorRevealed({ dataSettled: loadsSettled, weekError });

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

  /**
   * Persist a dept's entries. Called by the autosave debounce (`silent`) and by
   * the flush on unmount / page-hide; there is no Save button any more.
   *
   * Reads from `deptStateRef` rather than the render closure because a debounced
   * call must send what is on screen when it fires. Returns whether it wrote.
   */
  async function saveDept(key: HslDeptKey, opts?: { silent?: boolean }): Promise<boolean> {
    const d = deptStateRef.current[key]!;
    const dept = HSL_DEPTS[key];
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
    const attempted = { entries: d.entries, subTeams: d.subTeams };

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
      const superseded = latest.entries !== attempted.entries || latest.subTeams !== attempted.subTeams;
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
          !!failed && failed.entries === d.entries && failed.subTeams === d.subTeams,
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

  async function setStatus(key: HslDeptKey, next: BonusStatus): Promise<boolean> {
    const dept = HSL_DEPTS[key];
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
            loading={loadingDepts.has(key)}
            searchSeed={personSearch}
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
            savedAtMs={savedAt[key]}
            autosaveError={autosaveError[key]}
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
            {/* Sets how the next "Open" presents; also switchable from inside
                the overlay, so the choice is never a dead end. */}
            <ViewSwitch mode={openMode} onChange={setOpenMode} />
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

      {/* Branches. A manager with one branch gets the scoring surface directly —
          a one-row list you have to click through would be pure ceremony. Anyone
          with several gets the list, and picks one to open. */}
      <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
        {multiDept ? (
          <HslBranchList
            deptKeys={filteredDepts}
            state={deptState}
            loadingDepts={loadingDepts}
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
                  aria-label={`${HSL_DEPTS[overlayDept].name} KPI calculator`}
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
                  style={{ borderTop: `3px solid ${HSL_DEPTS[overlayDept].color}` }}
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
                              style={{ backgroundColor: HSL_DEPTS[k].color }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12.5px] font-medium text-zinc-800 dark:text-zinc-100">
                                {HSL_DEPTS[k].name}
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

/** Status chip for a scoring period. Shared by the branch list and the block
 *  header so one status never reads two ways. */
const DEPT_STATUS_CHIP: Record<BonusStatus, string> = {
  draft:  'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
  ready:  'bg-amber-200 text-amber-900 dark:bg-amber-700/80 dark:text-amber-100',
  locked: 'bg-emerald-200 text-emerald-900 dark:bg-emerald-800/80 dark:text-emerald-100',
};

interface HslBranchListProps {
  deptKeys: HslDeptKey[];
  state: AllDeptState;
  loadingDepts: Set<HslDeptKey>;
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
 *  always squeezed into whatever width the stack left it. A list compares in one
 *  glance and hands the whole overlay to the branch you actually picked. */
export function HslBranchList({
  deptKeys, state, loadingDepts, periodStart, matchedBySearch, onOpen,
}: HslBranchListProps) {
  if (deptKeys.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-10 text-center text-xs text-zinc-500 dark:border-zinc-800">
        No branches match the current filter.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950/50">
      {deptKeys.map((key) => {
        const dept = HSL_DEPTS[key];
        const st = state[key]!;
        const total = st.entries.reduce((s, e) => s + e.calculated_bonus, 0);
        const loading = loadingDepts.has(key);
        const matched = !!matchedBySearch?.has(key);
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => onOpen(key)}
              title={`Open ${dept.name}`}
              className="group flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-left outline-none transition-colors duration-150 hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:hover:bg-zinc-900/60 dark:focus-visible:bg-zinc-900/60"
            >
              <span
                aria-hidden
                className="h-8 w-1 flex-none rounded-full"
                style={{ backgroundColor: dept.color }}
              />

              {/* `basis-40` is the load-bearing bit: the name keeps a readable
                  minimum and the figures wrap to their own line rather than
                  squeezing "SSD Medical Records" into "SSD …". */}
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

              <span className="ml-auto flex flex-none items-center gap-3">
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]',
                      DEPT_STATUS_CHIP[st.status],
                    )}
                  >
                    {st.status}
                  </span>
                  {loading && (
                    <RefreshCw className="h-3 w-3 animate-spin text-zinc-500" aria-hidden />
                  )}
                </span>

                <span className="text-right font-mono text-[10px] text-zinc-500 sm:w-16">
                  {st.entries.length} ppl
                </span>

                <span
                  className="text-right font-mono text-sm font-bold tabular-nums sm:w-32"
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
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  onToggleManager: (email: string) => void;
  /** Epoch ms of the last successful autosave for this dept, for the inline
   *  "Saved HH:MM" status. Absent until the first write of the session. */
  savedAtMs?: number;
  /** Message from the last failed autosave, if it has not since succeeded. */
  autosaveError?: string;
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
  deptKey, state, loading, searchSeed, sectionClassName,
  chromeless, onOpen, periodStartStr,
  onKpiChange, onToggleManager,
  savedAtMs, autosaveError, onMarkReady, onMarkUnready, onView, onSubTeamChange, ssdShareForTeam,
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

  /** Page stepper. Rendered in the toolbar for most departments; SSD instead
   *  hands it to the roster footer, where it sits with the rows it pages. */
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
          <span className={cn('rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]', DEPT_STATUS_CHIP[state.status])}>
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
              {/* SSD renders this in the roster footer instead — see `pagerControls`. */}
              {!isTeamSplit && pagerControls}
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

        {/* SSD: status strip + one team card + full-width roster. The roster
            filter is lifted to this block because `filteredEntries` above pages
            against it — the workspace must not hold a second copy. */}
        {isTeamSplit && ssdShareForTeam && (
          <SsdWorkspace
            subTeams={state.subTeams}
            isLocked={readOnly}
            onSubTeamChange={onSubTeamChange}
            ssdShareForTeam={ssdShareForTeam}
            subTeamMemberCount={subTeamMemberCount}
            entries={pagedEntries}
            allEntries={state.entries}
            onSubTeamAssign={(email, subTeam) =>
              onKpiChange(email, 'sub_team', subTeam as unknown as number)
            }
            activeFilter={subTeamFilter}
            onFilterChange={setSubTeamFilter}
            rosterEmails={rosterEmails}
            offboardedEmails={offboardedEmails}
            onRemoveMember={onRemoveMember}
            pager={pagerControls}
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
// ── SSD Medical Records workspace ─────────────────────────────────────────────
//
// Structure comes from the Bonus Run design handoff
// (references/UI improvement request/design_handoff_bonus_run/): a status strip
// that doubles as the team tab bar, ONE team card at a time, then a full-width
// roster. Three places deliberately depart from it, because the handoff was
// written against sample data and says so itself:
//
//  1. Tier thresholds are the REAL ones from schema.ts — below 90% earns
//     nothing, 90–94.99% pays ₱250/record, 95%+ pays ₱350/record — plus the
//     SEPARATE RFC pool (₱250 per RFC, split by headcount) that stacks on top.
//     The handoff's 90/95/98 → 50/75/100%-of-pool ladder is flagged as invented
//     in its own README.
//  2. Its "✓ Saved 2 min ago" footer would be a lie sitting under these three
//     fields: accuracy / records / RFC are deliberately NOT persisted (Kane,
//     2026-08-17 — docs/features/hsl-kpi-calculator-2026-07.md). That forces a
//     fourth team state, `restored`, and an amber note in place of a save stamp.
//  3. Unassigned rows carry a dot, not its 3px inset side stripe.

const SSD_TEAMS: SubTeamName[] = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED'];

/** Binds one team's colour tokens (index.css) to an element as `--team*`, so a
 *  single hue can drive inline styles and `color-mix()` — neither of which can
 *  take a Tailwind class. Every SSD surface reads `var(--team)` and friends. */
function teamVars(name: SubTeamName): React.CSSProperties {
  const v = SUB_TEAM_PALETTE[name].varName;
  return {
    '--team': `var(--ssd-${v})`,
    '--team-solid': `var(--ssd-${v}-solid)`,
    '--team-on': `var(--ssd-${v}-on)`,
    '--team-text': `var(--ssd-${v}-text)`,
  } as React.CSSProperties;
}

/** Completeness of one sub-team, derived every render and never stored.
 *
 *  `restored` is the state the handoff could not have known about: after a
 *  reload the three inputs are blank while the per-member shares they produced
 *  are not. Reporting that as "Not started" would send the operator off to
 *  re-key numbers that are already banked — and `recomputeSsdEntries` refuses to
 *  overwrite those shares precisely because they are real. A typed `0` counts as
 *  entered, matching `subTeamInputsBlank`. */
type SsdTeamStatus = 'entered' | 'partial' | 'restored' | 'empty';

function ssdTeamStatus(st: SubTeamState, hasSavedShare: boolean): SsdTeamStatus {
  const filled = [st.pct, st.records, st.rfc].filter((v) => v.trim() !== '').length;
  if (filled === 3) return 'entered';
  if (filled > 0) return 'partial';
  return hasSavedShare ? 'restored' : 'empty';
}

const SSD_STATUS_MARK: Record<SsdTeamStatus, string> = {
  entered: '✓',
  partial: '!',
  restored: '·',
  empty: '–',
};

const SSD_STATUS_LABEL: Record<SsdTeamStatus, string> = {
  entered: 'Entered',
  partial: 'Incomplete',
  restored: 'Scored earlier',
  empty: 'Not started',
};

/** Which threshold a team's accuracy lands in, and how far along the tier meter
 *  that is. Reads the live rule rather than restating it, so a schema edit can
 *  never leave the meter describing a rate that no longer pays. */
function ssdTier(pct: number, rule: TeamSplitRule | undefined) {
  const sorted = [...(rule?.thresholds ?? [])].sort((a, b) => a.minPct - b.minPct);
  const idx = sorted.findIndex(
    (t) => pct >= t.minPct && (t.maxPct === null || pct <= t.maxPct),
  );
  const hit = idx >= 0 ? sorted[idx] : undefined;
  const firstPaying = sorted.find((t) => t.ratePerRecord > 0);
  return {
    step: idx >= 0 ? idx + 1 : 0,
    steps: Math.max(1, sorted.length),
    rate: hit?.ratePerRecord ?? 0,
    label: !hit
      ? 'No matching tier'
      : hit.ratePerRecord === 0
        ? `Below ${firstPaying?.minPct ?? 90}% · no accuracy bonus`
        : `${hit.minPct}%${hit.maxPct === null ? '+' : `–${hit.maxPct}%`} · ${formatPeso(hit.ratePerRecord)}/record`,
  };
}

// ── Status strip / team tab bar ───────────────────────────────────────────────

interface SsdTeamTabsProps {
  statuses: Record<SubTeamName, SsdTeamStatus>;
  memberCount: (t: SubTeamName) => number;
  activeTeam: SubTeamName;
  onSelect: (t: SubTeamName) => void;
  unassignedCount: number;
  onShowUnassigned: () => void;
}

/** The completion overview AND the tab control. Answers "which teams are done?"
 *  without opening any of them — every tab carries a glyph as well as a colour,
 *  so status never rests on hue alone. */
function SsdTeamTabs({
  statuses, memberCount, activeTeam, onSelect, unassignedCount, onShowUnassigned,
}: SsdTeamTabsProps) {
  const scored = SSD_TEAMS.filter(
    (t) => statuses[t] === 'entered' || statuses[t] === 'restored',
  ).length;
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  // Roving focus: the tablist is a single tab stop and arrows move between teams.
  function onKeyDown(e: React.KeyboardEvent, i: number) {
    const last = SSD_TEAMS.length - 1;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = i === last ? 0 : i + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = i === 0 ? last : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    e.preventDefault();
    onSelect(SSD_TEAMS[next]!);
    tabsRef.current[next]?.focus();
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-200 bg-zinc-50/80 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
      {/* Held at its natural size — without `flex-none` and `nowrap` this block
          collapses into a vertical stack the moment the tabs need to wrap. */}
      <div className="flex-none whitespace-nowrap border-r border-zinc-200 pr-4 dark:border-zinc-800">
        <span className="font-mono text-base font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
          {scored} / {SSD_TEAMS.length}
        </span>
        <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
          teams scored
        </span>
      </div>

      <div
        role="tablist"
        aria-label="Sub-teams"
        className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-1.5 sm:basis-0"
      >
        {SSD_TEAMS.map((name, i) => {
          const status = statuses[name];
          const active = activeTeam === name;
          const touched = status !== 'empty';
          const members = memberCount(name);
          return (
            <button
              key={name}
              ref={(el) => { tabsRef.current[i] = el; }}
              type="button"
              role="tab"
              id={`ssd-tab-${name}`}
              aria-selected={active}
              aria-controls={`ssd-card-${name}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(name)}
              onKeyDown={(e) => onKeyDown(e, i)}
              style={teamVars(name)}
              title={`${name} — ${SSD_STATUS_LABEL[status]}, ${members} ${members === 1 ? 'member' : 'members'}`}
              className={cn(
                'inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1',
                'font-mono text-[10px] font-semibold uppercase tracking-[0.12em] outline-none',
                'transition-[background-color,border-color,box-shadow,color] duration-200 ease-[cubic-bezier(0.2,0.7,0.3,1)]',
                'focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-zinc-950',
                active
                  ? 'border-[var(--team)] bg-[color-mix(in_srgb,var(--team)_18%,transparent)] text-zinc-900 shadow-[inset_0_0_0_1px_var(--team)] dark:text-zinc-50'
                  : touched
                    ? 'border-zinc-200 bg-white text-zinc-700 hover:border-[var(--team)] dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300'
                    : 'border-zinc-200 bg-white text-zinc-400 hover:border-zinc-300 hover:text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-500 dark:hover:text-zinc-400',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'h-2 w-2 flex-none rounded-full transition-colors duration-200',
                  !touched && !active && 'bg-zinc-300 dark:bg-zinc-700',
                )}
                style={touched || active ? { backgroundColor: 'var(--team)' } : undefined}
              />
              {name}
              <span
                aria-hidden
                className={cn(
                  'w-2 text-center',
                  status === 'entered' && 'text-emerald-600 dark:text-emerald-400',
                  status === 'partial' && 'text-amber-600 dark:text-amber-400',
                  status === 'restored' && 'text-zinc-500',
                  status === 'empty' && 'text-zinc-300 dark:text-zinc-600',
                )}
              >
                {SSD_STATUS_MARK[status]}
              </span>
              <span className="sr-only">{SSD_STATUS_LABEL[status]}</span>
            </button>
          );
        })}
      </div>

      {unassignedCount > 0 && (
        <button
          type="button"
          onClick={onShowUnassigned}
          className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-amber-700 outline-none transition-colors hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-400 dark:hover:bg-amber-950/40"
          title="Show only the people with no sub-team"
        >
          <span aria-hidden className="h-2 w-2 rounded-full bg-amber-500" />
          {unassignedCount} unassigned
        </button>
      )}
    </div>
  );
}

// ── Team card ─────────────────────────────────────────────────────────────────

interface SsdTeamCardProps {
  name: SubTeamName;
  state: SubTeamState;
  status: SsdTeamStatus;
  members: number;
  /** Per-member payout. For a `restored` team this is the SAVED share, not a
   *  recompute — the three inputs are blank, so recomputing would report ₱0 for
   *  a team that has already been scored and will be paid. */
  share: number;
  splitRule: TeamSplitRule | undefined;
  poolRule: TeamPoolRule | undefined;
  isLocked: boolean;
  onChange: (field: 'pct' | 'records' | 'rfc', val: string) => void;
}

const SSD_FIELD_LABEL =
  'mb-1 block font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400';
const SSD_FIELD_SHELL =
  'flex items-center rounded-lg border border-zinc-300 bg-zinc-50 transition-colors duration-[180ms] focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/25 dark:border-zinc-700 dark:bg-zinc-900';
const SSD_FIELD_INPUT =
  'h-10 w-full min-w-0 bg-transparent px-2.5 font-mono text-[15px] font-semibold tabular-nums text-zinc-900 outline-none placeholder:font-normal placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-55 dark:text-zinc-100 dark:placeholder:text-zinc-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

function SsdTeamCard({
  name, state, status, members, share, splitRule, poolRule, isLocked, onChange,
}: SsdTeamCardProps) {
  const pct = parseFloat(state.pct) || 0;
  const records = parseFloat(state.records) || 0;
  const rfc = parseFloat(state.rfc) || 0;
  const tier = ssdTier(pct, splitRule);
  const rfcRate = poolRule?.ratePerRecord ?? 0;
  const denom = members || 1;

  // The two rules are independent and SUM. Showing only the total would hide
  // that a team under 90% accuracy still earns its RFC pool.
  const accuracyShare = (records * tier.rate) / denom;
  const rfcShare = (rfc * rfcRate) / denom;
  const typed = status === 'entered' || status === 'partial';

  return (
    <div
      id={`ssd-card-${name}`}
      role="tabpanel"
      aria-labelledby={`ssd-tab-${name}`}
      tabIndex={0}
      style={teamVars(name)}
      className={cn(
        'ssd-card-in flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white outline-none',
        'transition-[border-color,box-shadow] duration-[260ms] ease-[cubic-bezier(0.2,0.7,0.3,1)]',
        'focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:bg-zinc-950/50 dark:focus-visible:ring-offset-zinc-950',
        status === 'empty'
          ? 'border-zinc-200 dark:border-zinc-800'
          : 'border-[color-mix(in_srgb,var(--team)_50%,#e4e4e7)] shadow-[0_1px_2px_rgba(0,0,0,0.05),0_8px_20px_-12px_rgba(0,0,0,0.18)] dark:border-[color-mix(in_srgb,var(--team)_45%,#27272a)]',
      )}
    >
      <div
        aria-hidden
        className="h-1 w-full flex-none transition-colors duration-[260ms]"
        style={{
          backgroundColor:
            status === 'empty' ? 'color-mix(in srgb, var(--team) 22%, transparent)' : 'var(--team)',
        }}
      />

      {/* Identity left, a text badge right — the card's state is never carried
          by colour alone. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="h-2.5 w-2.5 flex-none rounded-full"
            style={{ backgroundColor: 'var(--team)' }}
          />
          <h4 className="font-mono text-[13px] font-bold uppercase tracking-[0.16em] text-zinc-900 dark:text-zinc-100">
            {name}
          </h4>
          <span className="font-mono text-[11px] text-zinc-500">
            {members} {members === 1 ? 'member' : 'members'}
          </span>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em]',
            status === 'entered' && 'text-[var(--team-on)]',
            status === 'partial' && 'border border-amber-500 text-amber-700 dark:text-amber-400',
            status === 'restored' && 'border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400',
            status === 'empty' && 'border border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-500',
          )}
          style={status === 'entered' ? { backgroundColor: 'var(--team-solid)' } : undefined}
        >
          {status === 'entered' && <Check className="h-2.5 w-2.5" aria-hidden />}
          {status === 'restored' && <History className="h-2.5 w-2.5" aria-hidden />}
          {SSD_STATUS_LABEL[status]}
        </span>
      </div>

      {/* Fields stay strings end to end: the operator types "96." on the way to
          "96.2", and coercing on every keystroke fights the input. */}
      <div className="grid gap-x-4 gap-y-3 px-4 py-4 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <div className="min-w-0">
          <label className={SSD_FIELD_LABEL} htmlFor={`ssd-pct-${name}`}>Accuracy</label>
          <div className={SSD_FIELD_SHELL}>
            <input
              id={`ssd-pct-${name}`}
              type="number"
              inputMode="decimal"
              step="0.01"
              min={0}
              max={100}
              className={cn(SSD_FIELD_INPUT, 'min-w-[56px] pr-0')}
              value={state.pct}
              disabled={isLocked}
              placeholder="0.00"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => onChange('pct', e.target.value)}
            />
            <span aria-hidden className="pr-2.5 font-mono text-[11px] text-zinc-500">%</span>
          </div>
        </div>

        <div className="min-w-0">
          <label className={SSD_FIELD_LABEL} htmlFor={`ssd-rec-${name}`}>Records</label>
          <div className={SSD_FIELD_SHELL}>
            <input
              id={`ssd-rec-${name}`}
              type="number"
              inputMode="numeric"
              min={0}
              className={SSD_FIELD_INPUT}
              value={state.records}
              disabled={isLocked}
              placeholder="0"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => onChange('records', e.target.value)}
            />
          </div>
        </div>

        <div className="min-w-0">
          <label className={SSD_FIELD_LABEL} htmlFor={`ssd-rfc-${name}`}>RFC · pooled</label>
          <div className={SSD_FIELD_SHELL}>
            <input
              id={`ssd-rfc-${name}`}
              type="number"
              inputMode="numeric"
              min={0}
              className={SSD_FIELD_INPUT}
              value={state.rfc}
              disabled={isLocked}
              placeholder="0"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => onChange('rfc', e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Live arithmetic for both rules, so the payout below is never a number
          the operator has to take on faith. A restored team has no arithmetic to
          show — its inputs are gone and only the result survived. */}
      {status === 'restored' ? (
        <p className="border-t border-zinc-100 px-4 py-2.5 font-mono text-[11px] leading-relaxed text-zinc-600 dark:border-zinc-800/70 dark:text-zinc-400">
          Scored in an earlier session. Accuracy, records and RFC aren&rsquo;t saved between
          sessions, so only the share below survived. Re-enter all three to change it.
        </p>
      ) : (
      <dl className="grid gap-1 border-t border-zinc-100 px-4 py-2.5 font-mono text-[11px] dark:border-zinc-800/70">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt className="min-w-0 text-zinc-500">
            {records > 0 && tier.rate > 0
              ? `${records.toLocaleString('en-PH')} records × ${formatPeso(tier.rate)} ÷ ${denom}`
              : state.pct.trim() && tier.rate === 0
                ? 'Accuracy below the paying tier'
                : 'Accuracy sets the per-record rate'}
          </dt>
          <dd className="tabular-nums text-zinc-700 dark:text-zinc-300">
            {records > 0 && tier.rate > 0 ? formatPeso(accuracyShare) : '—'}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt className="min-w-0 text-zinc-500">
            {rfc > 0
              ? `${rfc.toLocaleString('en-PH')} RFC × ${formatPeso(rfcRate)} ÷ ${denom}`
              : `RFC pools at ${formatPeso(rfcRate)} each, split evenly`}
          </dt>
          <dd className="tabular-nums text-zinc-700 dark:text-zinc-300">
            {rfc > 0 ? formatPeso(rfcShare) : '—'}
          </dd>
        </div>
      </dl>
      )}

      {/* Tier meter left, per-member payout right. */}
      <div className="mt-auto flex flex-wrap items-end justify-between gap-3 border-t border-zinc-200 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1" aria-hidden>
            {Array.from({ length: tier.steps }, (_, i) => {
              const lit = !!state.pct.trim() && i < tier.step;
              return (
                <span
                  key={i}
                  className={cn(
                    'h-1.5 w-7 rounded-full transition-colors duration-[240ms]',
                    !lit && 'bg-zinc-200 dark:bg-zinc-800',
                  )}
                  style={lit ? { backgroundColor: 'var(--team)' } : undefined}
                />
              );
            })}
          </div>
          <span
            className={cn(
              'font-mono text-[11px] font-medium',
              state.pct.trim() ? 'text-[var(--team-text)]' : 'text-zinc-500',
            )}
          >
            {state.pct.trim()
              ? tier.label
              : status === 'restored'
                ? 'Accuracy not on screen'
                : 'Awaiting accuracy'}
          </span>
        </div>
        <div className="text-right">
          <div
            className={cn(
              'font-mono text-xl font-bold tabular-nums leading-none',
              typed || share !== 0 ? 'text-[var(--team-text)]' : 'text-zinc-400 dark:text-zinc-600',
            )}
          >
            {typed || status === 'restored' || share !== 0 ? <AnimatedPeso amount={share} /> : '—'}
          </div>
          <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
            per member
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-team picker (one roster row) ──────────────────────────────────────────

/** A native <select> with the browser chrome removed — one control per row
 *  instead of seven chips, which is what keeps a 60-person roster readable.
 *  `option` styling is re-set to normal case: browsers otherwise inherit the
 *  uppercase tracking straight into the popup. */
function SubTeamSelect({
  value, onChange, isLocked, employeeName,
}: {
  value: SubTeamName | '';
  onChange: (v: SubTeamName | '') => void;
  isLocked: boolean;
  employeeName: string;
}) {
  return (
    <div className="relative block min-w-0 flex-1">
      <select
        aria-label={`Sub-team for ${employeeName}`}
        value={value}
        disabled={isLocked}
        onChange={(e) => onChange(e.target.value as SubTeamName | '')}
        className={cn(
          'w-full min-w-0 appearance-none truncate rounded-full border py-1.5 pl-3 pr-7 outline-none',
          'font-mono text-[10px] font-semibold uppercase tracking-[0.1em]',
          'transition-[background-color,border-color,box-shadow] duration-[180ms] ease-[cubic-bezier(0.2,0.7,0.3,1)]',
          'hover:brightness-[1.04] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-zinc-950',
          'disabled:cursor-not-allowed disabled:opacity-60',
          value
            ? 'border-[color-mix(in_srgb,var(--team)_60%,transparent)] bg-[color-mix(in_srgb,var(--team)_16%,transparent)] text-zinc-900 dark:text-zinc-100'
            : 'border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400',
        )}
      >
        <option value="" className="font-sans text-[13px] normal-case tracking-normal">
          Unassigned
        </option>
        {SSD_TEAMS.map((t) => (
          <option key={t} value={t} className="font-sans text-[13px] normal-case tracking-normal">
            {t.charAt(0) + t.slice(1).toLowerCase()}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className={cn(
          'pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-70',
          value ? 'text-[var(--team-text)]' : 'text-zinc-500',
        )}
      />
    </div>
  );
}

// ── Roster ────────────────────────────────────────────────────────────────────

interface SsdRosterProps {
  entries: EntryRow[];
  allEntries: EntryRow[];
  isLocked: boolean;
  /** Per-row payout. Not `ssdShareForTeam` directly: a team scored in an earlier
   *  session has blank inputs, and recomputing from those would print ₱0.00 next
   *  to a share that is banked and about to be paid. */
  shareForRow: (entry: EntryRow, subTeam: SubTeamName, memberCount: number) => number;
  onSubTeamAssign: (email: string, subTeam: SubTeamName | '') => void;
  activeFilter: SubTeamFilter;
  onFilterChange: (f: SubTeamFilter) => void;
  rosterEmails?: Set<string>;
  offboardedEmails?: Set<string>;
  onRemoveMember?: (email: string) => void;
  /** Page controls owned by the parent block, dropped into the roster footer. */
  pager?: React.ReactNode;
}

function SsdRoster({
  entries, allEntries, isLocked, shareForRow, onSubTeamAssign,
  activeFilter, onFilterChange, rosterEmails, offboardedEmails, onRemoveMember, pager,
}: SsdRosterProps) {
  // Counts must reflect the whole department, never just the visible page.
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

  // Selection is keyed by email so it survives paging and filtering; checkboxes
  // only render for the rows currently on screen.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Drop selected emails that no longer exist (the roster changed under us).
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

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = somePageSelected && !allPageSelected;
    }
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

  const chipBase =
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] outline-none transition-[background-color,border-color,color] duration-200 ease-[cubic-bezier(0.2,0.7,0.3,1)] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-zinc-950';
  const chipIdle =
    'border-zinc-200 bg-white text-zinc-600 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400 dark:hover:text-zinc-200';

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/40">
      {/* Filter bar. Independent of the open team card, so you can score BLUE
          while looking at who is still unassigned. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
        <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
          Roster
        </span>
        <button
          type="button"
          onClick={() => onFilterChange('ALL')}
          aria-pressed={activeFilter === 'ALL'}
          className={cn(
            chipBase,
            activeFilter === 'ALL'
              ? 'border-transparent bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : chipIdle,
          )}
        >
          All
          <span className="tabular-nums opacity-65">{allEntries.length}</span>
        </button>
        {SSD_TEAMS.map((name) => {
          const active = activeFilter === name;
          return (
            <button
              key={name}
              type="button"
              style={teamVars(name)}
              onClick={() => onFilterChange(active ? 'ALL' : name)}
              aria-pressed={active}
              title={active ? `Showing ${name} only — click to show everyone` : `Show ${name} only`}
              className={cn(
                chipBase,
                active ? 'border-transparent bg-[var(--team-solid)] text-[var(--team-on)]' : chipIdle,
              )}
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: active ? 'var(--team-on)' : 'var(--team)' }}
              />
              {name}
              <span className="tabular-nums opacity-65">{memberCounts[name] ?? 0}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onFilterChange(activeFilter === 'NONE' ? 'ALL' : 'NONE')}
          aria-pressed={activeFilter === 'NONE'}
          title={
            activeFilter === 'NONE'
              ? 'Showing unassigned only — click to show everyone'
              : 'Show only people with no sub-team'
          }
          className={cn(
            chipBase,
            activeFilter === 'NONE'
              ? 'border-transparent bg-amber-700 text-white dark:bg-amber-400 dark:text-amber-950'
              : chipIdle,
          )}
        >
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              activeFilter === 'NONE' ? 'bg-white dark:bg-amber-950' : 'bg-amber-500',
            )}
          />
          Unassigned
          <span className="tabular-nums opacity-65">{unassignedCount}</span>
        </button>
        {activeFilter !== 'ALL' && (
          <button
            type="button"
            onClick={() => onFilterChange('ALL')}
            className="ml-auto inline-flex items-center gap-1 rounded font-mono text-[10px] text-zinc-500 underline-offset-2 outline-none transition-colors hover:text-zinc-900 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-zinc-200"
          >
            <X className="h-3 w-3" aria-hidden /> Clear
          </button>
        )}
      </div>

      {/* Bulk-assign bar — present only when there is something to assign. */}
      <AnimatePresence initial={false}>
        {selected.size > 0 && (
          <motion.div
            key="ssd-bulk"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.24, ease: COLLAPSE_EASE },
              opacity: { duration: 0.16 },
            }}
            className="overflow-hidden border-b border-zinc-200 bg-blue-50/80 dark:border-zinc-800 dark:bg-blue-950/25"
          >
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-blue-800 dark:text-blue-300">
                <span className="font-bold tabular-nums">{selected.size}</span> selected · assign to
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => bulkAssign('')}
                  className={cn(chipBase, chipIdle, isLocked && 'cursor-not-allowed opacity-50')}
                >
                  Unassigned
                </button>
                {SSD_TEAMS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    style={teamVars(name)}
                    disabled={isLocked}
                    onClick={() => bulkAssign(name)}
                    title={`Move ${selected.size} ${selected.size === 1 ? 'person' : 'people'} to ${name}`}
                    className={cn(
                      chipBase,
                      'border-[color-mix(in_srgb,var(--team)_60%,transparent)] bg-white text-[var(--team-text)] hover:bg-[color-mix(in_srgb,var(--team)_12%,transparent)] dark:bg-zinc-950/60',
                      isLocked && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: 'var(--team)' }}
                    />
                    {name}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="ml-auto rounded font-mono text-[10px] text-zinc-600 underline-offset-2 outline-none transition-colors hover:text-zinc-900 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                Clear
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="min-h-0 flex-1 overflow-x-auto">
        <table className="table-keep w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40">
              <th scope="col" className="w-9 px-2 py-2 text-center">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="accent-blue-600"
                  checked={allPageSelected}
                  disabled={isLocked || pageEmails.length === 0}
                  onChange={toggleAllOnPage}
                  aria-label="Select every person shown"
                />
              </th>
              <th scope="col" className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
                Employee
              </th>
              <th scope="col" className="w-[190px] px-2 py-2 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
                Sub-team
              </th>
              <th scope="col" className="w-[110px] px-3 py-2 text-right font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center font-mono text-[11px] text-zinc-500">
                  {activeFilter === 'NONE'
                    ? 'Everyone has a sub-team.'
                    : activeFilter !== 'ALL'
                      ? `No ${activeFilter} members on this page.`
                      : 'No employees on this page.'}
                </td>
              </tr>
            )}
            {entries.map((e, i) => {
              const subTeam = String(e.kpi_data.sub_team ?? '') as SubTeamName | '';
              const memberCount = subTeam ? (memberCounts[subTeam] ?? 0) : 0;
              const share = subTeam ? shareForRow(e, subTeam, memberCount) : 0;
              const isSel = selected.has(e.employee_email);
              const isExternal = !!rosterEmails && !rosterEmails.has(e.employee_email);
              return (
                <tr
                  // The filter is part of the key so rows remount and replay the
                  // cascade every time the roster is re-sliced.
                  key={`${activeFilter}-${e.employee_email}`}
                  // `--team*` is set on the row, not the cells, so the picker and
                  // the share figure below it read the same hue from one place.
                  style={{
                    animation: `ssd-row-in 0.28s cubic-bezier(0.2,0.7,0.3,1) ${Math.min(i * 26, 260)}ms both`,
                    ...(subTeam ? teamVars(subTeam) : {}),
                  }}
                  className={cn(
                    'ssd-roster-row border-b border-zinc-100 transition-colors duration-150 last:border-b-0 dark:border-zinc-800/60',
                    isSel
                      ? 'bg-blue-50/80 dark:bg-blue-950/30'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50',
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
                      {/* The slot is always here, filled only when unassigned —
                          rendering it conditionally indented every flagged name
                          out of the column. */}
                      <span className="flex h-1.5 w-1.5 flex-none items-center justify-center">
                        {!subTeam && (
                          <span
                            aria-hidden
                            title="No sub-team — this person earns nothing until assigned"
                            className="h-1.5 w-1.5 rounded-full bg-amber-500"
                          />
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                          <span className="truncate">{e.employee_name}</span>
                          {isExternal && (
                            <ExtChip email={e.employee_email} offboardedEmails={offboardedEmails} />
                          )}
                        </div>
                        <div className="truncate font-mono text-[10px] text-zinc-500">
                          {e.employee_email}
                        </div>
                      </div>
                      {isExternal && onRemoveMember && !isLocked && (
                        <button
                          type="button"
                          onClick={() => onRemoveMember(e.employee_email)}
                          title="Remove external member"
                          aria-label={`Remove ${e.employee_name}`}
                          className="ml-auto shrink-0 rounded p-1 text-zinc-500 outline-none transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex">
                      <SubTeamSelect
                        value={subTeam}
                        isLocked={isLocked}
                        employeeName={e.employee_name}
                        onChange={(v) => onSubTeamAssign(e.employee_email, v)}
                      />
                    </div>
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right font-mono font-bold tabular-nums',
                      subTeam ? 'text-[var(--team-text)]' : 'text-zinc-400 dark:text-zinc-600',
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

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-500">
          {entries.length} of {allEntries.length} shown
        </span>
        {pager}
      </div>
    </div>
  );
}

// ── Workspace ─────────────────────────────────────────────────────────────────

interface SsdWorkspaceProps {
  subTeams: Record<SubTeamName, SubTeamState>;
  isLocked: boolean;
  onSubTeamChange: (subTeam: SubTeamName, field: 'pct' | 'records' | 'rfc', val: string) => void;
  ssdShareForTeam: (subTeam: SubTeamName, memberCount: number) => number;
  subTeamMemberCount: (subTeam: SubTeamName) => number;
  /** Rows currently on screen (already searched, filtered and paged). */
  entries: EntryRow[];
  /** Every row in the department — counts and totals must not follow the page. */
  allEntries: EntryRow[];
  onSubTeamAssign: (email: string, subTeam: SubTeamName | '') => void;
  /** Controlled roster filter. Omit to let the workspace own it (edit modal). */
  activeFilter?: SubTeamFilter;
  onFilterChange?: (f: SubTeamFilter) => void;
  rosterEmails?: Set<string>;
  offboardedEmails?: Set<string>;
  onRemoveMember?: (email: string) => void;
  pager?: React.ReactNode;
}

/** The whole SSD scoring surface: status strip, one team card, full-width
 *  roster. Owns which team is open; the roster filter is either controlled by
 *  the parent (so its search and paging can honour the same slice) or local. */
export function SsdWorkspace({
  subTeams, isLocked, onSubTeamChange, ssdShareForTeam, subTeamMemberCount,
  entries, allEntries, onSubTeamAssign, activeFilter, onFilterChange,
  rosterEmails, offboardedEmails, onRemoveMember, pager,
}: SsdWorkspaceProps) {
  const [activeTeam, setActiveTeam] = useState<SubTeamName>('BLUE');
  const [ownFilter, setOwnFilter] = useState<SubTeamFilter>('ALL');
  const filter = activeFilter ?? ownFilter;
  const setFilter = onFilterChange ?? setOwnFilter;

  const splitRule = HSL_DEPTS.ssd_medical_records.rules.find(
    (r): r is TeamSplitRule => r.type === 'team_split',
  );
  const poolRule = HSL_DEPTS.ssd_medical_records.rules.find(
    (r): r is TeamPoolRule => r.type === 'team_pool',
  );

  // A team whose inputs are blank but whose members carry a non-zero saved share
  // was scored in an earlier session — see `ssdTeamStatus`.
  const statuses = useMemo(() => {
    const savedByTeam: Record<string, boolean> = {};
    for (const e of allEntries) {
      const st = String(e.kpi_data.sub_team ?? '');
      if (st && e.calculated_bonus !== 0) savedByTeam[st] = true;
    }
    return Object.fromEntries(
      SSD_TEAMS.map((t) => [t, ssdTeamStatus(subTeams[t], !!savedByTeam[t])]),
    ) as Record<SubTeamName, SsdTeamStatus>;
  }, [subTeams, allEntries]);

  const unassignedCount = useMemo(
    () => allEntries.filter((e) => !String(e.kpi_data.sub_team ?? '')).length,
    [allEntries],
  );

  /** The banked per-member share for a team whose inputs are no longer on
   *  screen. Every member of a team gets the same share by construction, so the
   *  first non-zero one is the team's figure. */
  const savedShareByTeam = useMemo(() => {
    const byTeam: Partial<Record<SubTeamName, number>> = {};
    for (const e of allEntries) {
      const t = String(e.kpi_data.sub_team ?? '') as SubTeamName | '';
      if (t && byTeam[t] === undefined && e.calculated_bonus !== 0) byTeam[t] = e.calculated_bonus;
    }
    return byTeam;
  }, [allEntries]);

  const shareForRow = useCallback(
    (e: EntryRow, team: SubTeamName, memberCount: number) =>
      statuses[team] === 'restored' ? e.calculated_bonus : ssdShareForTeam(team, memberCount),
    [statuses, ssdShareForTeam],
  );

  const blanks = SSD_TEAMS.filter((t) => statuses[t] === 'empty');
  const partials = SSD_TEAMS.filter((t) => statuses[t] === 'partial');
  const members = subTeamMemberCount(activeTeam);
  const activeShare =
    statuses[activeTeam] === 'restored'
      ? (savedShareByTeam[activeTeam] ?? 0)
      : ssdShareForTeam(activeTeam, members || 1);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SsdTeamTabs
        statuses={statuses}
        memberCount={subTeamMemberCount}
        activeTeam={activeTeam}
        onSelect={setActiveTeam}
        unassignedCount={unassignedCount}
        onShowUnassigned={() => setFilter('NONE')}
      />

      <div className="grid min-w-0 items-stretch gap-4 lg:grid-cols-[minmax(0,620px)_minmax(230px,1fr)]">
        {/* Keyed by team so the card remounts and replays its entrance — two
            teams can score identically and the switch still reads. */}
        <SsdTeamCard
          key={activeTeam}
          name={activeTeam}
          state={subTeams[activeTeam]}
          status={statuses[activeTeam]}
          members={members}
          share={activeShare}
          splitRule={splitRule}
          poolRule={poolRule}
          isLocked={isLocked}
          onChange={(field, val) => onSubTeamChange(activeTeam, field, val)}
        />

        {/* The rules, stated once, read off the live schema. The handoff left
            these as invented placeholders and asked for the real ones. */}
        {/* A container, not a viewport consumer: this panel is ~330px wide beside
            the card in a half-window overlay and full width when stacked, so its
            own inline size decides the split. Keying it to `sm:` collided the two
            columns' text at exactly the width the side panel produces. */}
        <aside className="@container flex min-w-0 flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/60 px-4 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/30">
          <h4 className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
            How a share is built
          </h4>
          {/* Two columns only once the panel itself can carry them. */}
          <div className="grid gap-x-6 gap-y-3 @md:grid-cols-2">
            <div className="min-w-0">
              <p className="font-mono text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                {splitRule?.label ?? 'Team Accuracy Bonus'}
              </p>
              <ul className="mt-1 space-y-0.5">
                {(splitRule?.thresholds ?? []).map((t) => (
                  <li
                    key={t.minPct}
                    className="flex gap-2 font-mono text-[10px] text-zinc-600 dark:text-zinc-400"
                  >
                    <span className="w-[5.5rem] flex-none tabular-nums">
                      {t.minPct}%{t.maxPct === null ? '+' : `–${t.maxPct}%`}
                    </span>
                    <span className="tabular-nums">
                      {t.ratePerRecord === 0 ? 'no bonus' : `${formatPeso(t.ratePerRecord)}/record`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 font-mono text-[10px] text-zinc-500">records × rate ÷ headcount</p>
            </div>
            <div className="min-w-0 border-t border-zinc-200 pt-3 dark:border-zinc-800 @md:border-l @md:border-t-0 @md:pl-6 @md:pt-0">
              <p className="font-mono text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                {poolRule?.label ?? 'RFC'} pool
              </p>
              <p className="mt-1 max-w-[42ch] font-mono text-[10px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                {formatPeso(poolRule?.ratePerRecord ?? 0)} per RFC, pooled and split evenly. No
                accuracy tiering — it stacks on top of the bonus above.
              </p>
            </div>
          </div>

          {/* Why the run is not finished, stated plainly rather than left for the
              operator to infer from six tab glyphs. */}
          <div className="mt-auto border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
            {blanks.length === 0 && partials.length === 0 && unassignedCount === 0 ? (
              <p className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3 flex-none" aria-hidden /> All teams scored ·
                everyone assigned
              </p>
            ) : (
              <p className="inline-flex items-start gap-1.5 font-mono text-[10px] uppercase leading-relaxed tracking-[0.1em] text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-px h-3 w-3 flex-none" aria-hidden />
                <span>
                  {[
                    blanks.length > 0 &&
                      `${blanks.length} ${blanks.length === 1 ? 'team' : 'teams'} not started`,
                    partials.length > 0 && `${partials.length} incomplete`,
                    unassignedCount > 0 && `${unassignedCount} unassigned`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </p>
            )}
          </div>
        </aside>
      </div>

      <SsdRoster
        entries={entries}
        allEntries={allEntries}
        isLocked={isLocked}
        shareForRow={shareForRow}
        onSubTeamAssign={onSubTeamAssign}
        activeFilter={filter}
        onFilterChange={setFilter}
        rosterEmails={rosterEmails}
        offboardedEmails={offboardedEmails}
        onRemoveMember={onRemoveMember}
        pager={pager}
      />
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
