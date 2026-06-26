'use client';

// KPI Calculator -- Departments (non-HSL).
//
// Catalog-driven: the bonuses a manager can apply come from the Bonus Catalog
// (Accounting tab). For each department the manager controls:
//   - "Common" bonuses (assigned to the whole department) apply to every member.
//   - "Individual" bonuses (assigned to one employee in the department) show on
//     that person only.
// On a fresh week, "Common" bonuses are pre-applied to everyone in the
// department (minus anyone excluded in the catalog) so the manager doesn't have
// to tick each person; once the week is saved, the saved selection is
// authoritative (a manual untick persists). Flat bonuses are a simple on/off;
// formula bonuses collect their variable inputs per employee and compute live
// via the catalog formula engine. Applied rows are saved to
// bonus_catalog_applied (one row per member x applied bonus) and, once the week
// is marked Ready, feed the Payroll Wizard "KPI Sub." column.
//
// UI model: a "My Departments" landing grid of summary cards. Opening a card
// reveals that department's calculator in either a right-side DRAWER or a
// full-screen FOCUS workspace (with a department rail) -- the manager picks via
// the "Open as" toggle. The calculator is a dense per-person table: rows are
// people, columns are bonuses, each row totals live, the footer subtotals the
// department, and Save / Mark Ready submit the week to payroll.
//
// Week = the latest Hubstaff upload (pinned, same key accounting processes).
// Status (draft/ready/locked) lives in hsl_bonus_period_status (reused).

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  AppWindow,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  CornerUpLeft,
  Loader2,
  Lock,
  Maximize2,
  Minus,
  PanelRight,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Unlock,
  User,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { DEPARTMENTS, DEPT_DESCRIPTION, MANAGER_BONUS_DEPT_KEYS } from '@/lib/payroll/department-bonus';
import { QC_DEPT_KEYS, isQcDeptKey } from '@/lib/qc/constants';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import {
  pickCurrentSourceFile,
  type HubstaffSourceFilesResponse,
} from '@/lib/hubstaff/current-upload';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import KpiCalculatorLoading from './KpiCalculatorLoading';
import { validateFormula, evaluateFormula } from '@/lib/bonus-catalog/formula';
import type { BonusDef, BonusAssignment } from '@/lib/bonus-catalog/types';
import { effectiveUsdToPhpRateFromStored } from '@/lib/fx/usd-php';
import {
  effectiveUsdToCopRateFromStored,
  officialFxRates,
  phpPerUnit,
  type FxRates,
} from '@/lib/fx/currency-fx';
import {
  CURRENCY_SYMBOL,
  CURRENCY_LOCALE,
  PAY_CURRENCIES,
  type PayCurrency,
} from '@/lib/payment-catalog/pay-structure';

// -- Types ---------------------------------------------------------------------

type BonusStatus = 'draft' | 'ready' | 'locked';
/** How the calculator overlay presents an open department. */
type OpenMode = 'drawer' | 'focus' | 'modal';

const EASE = [0.22, 1, 0.36, 1] as const;
const PESO = '₱';

/** Departments whose calculator table is paginated, and how many rows per page. */
const PAGED_DEPTS: Record<string, number> = { lead_gen: 8 };

/** Per-member, per-bonus applied state. `vars` holds formula inputs as strings. */
interface AppliedState {
  on: boolean;
  vars: Record<string, string>;
}

interface MemberState {
  email: string;
  name: string;
  applied: Record<string, AppliedState>; // keyed by bonusId
}

interface DeptState {
  members: MemberState[];
  /** Team-effort ("shared") common bonuses: entered once for the whole dept,
   *  keyed by bonusId. Every non-excluded member receives the computed amount. */
  shared: Record<string, AppliedState>;
  status: BonusStatus;
  dirty: boolean;
  saving: boolean;
  loaded: boolean;
}

type AllState = Record<string, DeptState>;

interface DeptBonusCalculatorProps {
  viewerEmail: string | null;
  teamMembers: EmployeeRow[];
  managedDepts: string[];
  isElevated: boolean;
  /**
   * `manager` (default): the dept manager's calculator — writes the official
   *  `bonus_catalog_applied` the Payroll Wizard pays, and (for QC depts) auto-
   *  seeds from the QC first-pass + shows the QC officer log.
   * `qc`: a QC officer's first-pass calculator — writes the staging table
   *  `qc_kpi_submissions`, scoped to their assigned members, with one
   *  officer-level "Lock & send to manager" action.
   */
  variant?: 'manager' | 'qc';
  /** QC mode: the officer's assigned members per department (slot-aware, so a
   *  transferred person appears under each dept they hold a slot in). This is the
   *  authoritative roster in QC mode — replaces the live-department grouping. */
  assignedByDept?: Record<string, Array<{ email: string; name: string }>>;
  /** QC mode: whether this officer has locked their batch for the week. */
  qcLocked?: boolean;
  /** QC mode: persist a lock/reopen (QCApp POSTs /api/qc/lock); returns ok. */
  onToggleQcLock?: (next: boolean) => Promise<boolean>;
  /** QC mode: report the resolved pay-week so the shell can fetch that week's
   *  assignment + lock state. Fires whenever the internal weekStart changes. */
  onWeekChange?: (weekStart: string) => void;
  /** QC mode: when provided, the shell owns the active pay-week (e.g. the QC
   *  Overview's period selector drives it). The calculator follows this value
   *  and reports its own WeekPicker changes back via `onWeekChange`. Leaving it
   *  undefined keeps the calculator's self-managed week (the manager view). */
  controlledWeek?: string;
}

// -- Per-department colour identity (hex; inline-styled to dodge Tailwind purge) --

const DEPT_COLOR: Record<string, string> = {
  accounting: '#10b981',
  edit: '#3b82f6',
  devs: '#8b5cf6',
  lead_gen: '#f59e0b',
  us_manager_bonus: '#f43f5e',
  callback: '#06b6d4',
  qc: '#f97316',
  discovery: '#14b8a6',
  hr: '#ec4899',
  sales_assistant: '#6366f1',
  smm: '#d946ef',
  pm_team: '#0ea5e9',
  client_va: '#84cc16',
  site_building: '#64748b',
};

function deptColor(key: string): string {
  return DEPT_COLOR[key] ?? '#6366f1';
}

/** hex (#rrggbb) -> rgba string at the given alpha. */
function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// -- Period helpers (weekly, Monday-anchored -- matches the payroll week) -------

function isoWeekStart(d: Date): string {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = day.getDay(); // 0=Sun ... 6=Sat
  const daysBack = dow === 0 ? 6 : dow - 1;
  day.setDate(day.getDate() - daysBack);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

function weekEndFromStart(startIso: string): string {
  const [y, m, d] = startIso.split('-').map(Number);
  const end = new Date(y!, m! - 1, d! + 6);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}

/** Money in one of the two supported currencies, e.g. "$50.00" / "₱1,200.00".
 *  Always shows centavos so a fractional formula result (e.g. a division in the
 *  Payment Catalog formula) is never silently rounded. */
function fmtMoney(n: number, currency: PayCurrency = 'PHP'): string {
  const sym = CURRENCY_SYMBOL[currency] ?? PESO;
  const locale = CURRENCY_LOCALE[currency] ?? 'en-PH';
  // COP has no minor unit; PHP/USD show centavos.
  const digits = currency === 'COP' ? 0 : 2;
  return `${sym}${n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A running total split by currency. A manager-view total can mix bonuses in
 *  different currencies on the same person/department, so we keep each currency
 *  separate rather than FX-converting — the conversion is a payout concern,
 *  applied only when the row is SAVED (computeAmount). */
type Money = Record<PayCurrency, number>;

/** A fresh zeroed Money. */
function zeroMoney(): Money {
  return { PHP: 0, USD: 0, COP: 0 };
}

/** Sum two Money bags currency-by-currency. */
function addMoney(a: Money, b: Money): Money {
  const out = zeroMoney();
  for (const c of PAY_CURRENCIES) out[c] = a[c] + b[c];
  return out;
}

/** Departments whose KPI bonuses ALWAYS resolve in a forced currency, regardless
 *  of each bonus's catalog currency — e.g. US-based teams (US Manager Bonus) are
 *  paid in dollars, so their amounts are dollar figures and both the calculator
 *  display AND the saved/converted payout treat them as USD. Add a Colombian
 *  team here with 'COP' to force COP the same way. */
const FORCED_DEPT_CURRENCY: Record<string, PayCurrency> = { us_manager_bonus: 'USD' };

/** The native currency a bonus is denominated in (legacy bonuses default PHP). */
function bonusCurrency(bonus: BonusDef): PayCurrency {
  return bonus.currency && PAY_CURRENCIES.includes(bonus.currency) ? bonus.currency : 'PHP';
}

/** The effective currency for a bonus IN A DEPARTMENT: a currency-forced
 *  department (e.g. US Manager Bonus) uses that currency across the board; any
 *  other department uses the bonus's own catalog currency. This is the single
 *  resolver every display + the saved payout funnels through, so a forced
 *  department stays self-consistent (shown native, converted to PHP on save). */
function effectiveCurrency(deptKey: string, bonus: BonusDef): PayCurrency {
  return FORCED_DEPT_CURRENCY[deptKey] ?? bonusCurrency(bonus);
}

function moneyPositive(m: Money): boolean {
  return PAY_CURRENCIES.some((c) => m[c] > 0);
}

/** Render a possibly-mixed total: only the non-zero currencies, joined by " · "
 *  (e.g. "₱1,200.00 · $50.00 · COP$8,000"). An empty total reads "₱0.00", so a
 *  single-currency department shows pure native and a PHP department is unchanged. */
function fmtTotals(m: Money): string {
  const parts: string[] = [];
  for (const c of PAY_CURRENCIES) {
    if (m[c]) parts.push(fmtMoney(m[c], c));
  }
  return parts.length ? parts.join(' · ') : fmtMoney(0, 'PHP');
}

/** Two-letter initials from a roster name (handles "Last, First M." formats). */
function initials(name: string): string {
  const parts = name.replace(/["']/g, '').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** Build short, *unique* abbreviations for the department picker tiles. The base
 *  form mirrors `initials()` — first letter of each of the first two words, or
 *  the first two letters when the name is a single word. On a collision we walk
 *  further into the name (and finally append a digit) so every department in the
 *  view ends up with a distinct tag. */
function uniqueDeptAbbrevs(items: { key: string; name: string }[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const { key, name } of items) {
    const cleaned = name.replace(/["']/g, '').replace(/[,/]/g, ' ').trim();
    const words = cleaned.split(/\s+/).filter(Boolean);
    const letters = cleaned.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

    // Candidate abbreviations, most-preferred first.
    const cands: string[] = [];
    const push = (s: string) => {
      const u = (s ?? '').toUpperCase();
      if (u.length >= 2 && !cands.includes(u)) cands.push(u);
    };
    push(initials(name)); // base, e.g. "LG"
    if (words.length >= 2) {
      for (let i = 2; i < words.length; i++) push(words[0]![0]! + words[i]![0]!); // first + later word
      push(words[0]!.slice(0, 2)); // first word, two letters
      push(words[0]![0]! + words[1]![0]! + (words[2]?.[0] ?? words[1]![1] ?? '')); // 3-letter
    } else {
      for (let i = 2; i < letters.length; i++) push(letters[0]! + letters[i]!); // first + later letter
      push(letters.slice(0, 3)); // 3-letter
    }

    let chosen = cands.find((c) => !used.has(c));
    if (!chosen) {
      const base = cands[0] ?? (key.slice(0, 2).toUpperCase() || '?');
      let n = 2;
      chosen = `${base}${n}`;
      while (used.has(chosen)) chosen = `${base}${++n}`;
    }
    used.add(chosen);
    out[key] = chosen;
  }
  return out;
}

function rowEmail(r: EmployeeRow): string {
  return normEmail(r.personal_email ?? null) || normEmail(r.work_email ?? null) || '';
}

/** Deterministic applied-row id so re-saves upsert the same row. */
function appliedId(dept: string, periodStart: string, email: string, bonusId: string): string {
  return `app:${periodStart}:${dept}:${email}:${bonusId}`;
}

/** Round a peso amount to centavos (2dp) — the money granularity the
 *  bonus_catalog_applied.amount column (numeric(14,2)) and the Payroll Wizard
 *  "KPI Sub." sum operate at. Keeps the live display, the saved row, and what
 *  the wizard pays in exact agreement. */
function toCentavos(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Compute the PESO amount a bonus pays for a given set of (string) variable
 *  inputs. Flat bonuses use the catalog amount; formula bonuses evaluate the
 *  Payment Catalog formula verbatim (`evaluateFormula`).
 *
 *  A non-PHP bonus is converted to its PHP-equivalent via `phpPerUnit(currency, fx)`
 *  — USD at the USD->PHP rate, COP via the USD-anchored cross-rate — the same
 *  rule Pay Structures use (resolve-rate.ts). The multiply happens BEFORE
 *  centavo-pinning so the stored PHP value is exact. Because this is the single
 *  chokepoint the saved `amount` funnels through, converting here keeps
 *  bonus_catalog_applied + the Payroll Wizard PHP-only. PHP bonuses (and legacy
 *  bonuses with no currency) pass through untouched.
 *
 *  `currency` overrides the bonus's own currency — passed for currency-forced
 *  departments (e.g. US Manager Bonus) so their amounts convert to PHP on save
 *  just like an explicitly-typed bonus would. Defaults to the bonus's catalog currency. */
function computeAmount(
  bonus: BonusDef,
  varsStr: Record<string, string> | undefined,
  fx: FxRates,
  currency: PayCurrency = bonusCurrency(bonus),
): number {
  const factor = phpPerUnit(currency, fx);
  if (bonus.kind === 'flat') {
    return toCentavos((Number.isFinite(bonus.amount) ? (bonus.amount as number) : 0) * factor);
  }
  const check = validateFormula(bonus.formula ?? '');
  if (!check.ok) return 0;
  const nums: Record<string, number> = {};
  for (const v of check.variables) nums[v] = Number(varsStr?.[v] ?? '') || 0;
  try {
    return toCentavos(evaluateFormula(bonus.formula ?? '', nums) * factor);
  } catch {
    return 0;
  }
}

/** The amount a bonus pays in its OWN currency — no FX. This is what the
 *  manager's view DISPLAYS, so a USD bonus reads in dollars rather than its
 *  peso equivalent. `computeAmount` (above) remains what gets SAVED + paid: the
 *  payout layer stays PHP, so USD bonuses are FX-converted only when the applied
 *  row is persisted (saveDept). Mirrors computeAmount with the factor fixed at 1. */
function computeNative(bonus: BonusDef, varsStr: Record<string, string> | undefined): number {
  if (bonus.kind === 'flat') {
    return toCentavos(Number.isFinite(bonus.amount) ? (bonus.amount as number) : 0);
  }
  const check = validateFormula(bonus.formula ?? '');
  if (!check.ok) return 0;
  const nums: Record<string, number> = {};
  for (const v of check.variables) nums[v] = Number(varsStr?.[v] ?? '') || 0;
  try {
    return toCentavos(evaluateFormula(bonus.formula ?? '', nums));
  } catch {
    return 0;
  }
}

/** The bonus amount in its OWN currency (no FX) — for showing the native source
 *  figure next to the converted peso. Flat bonuses only; formula results vary
 *  with inputs so callers show a plain "USD" tag instead. */
function nativeFlatAmount(bonus: BonusDef): number {
  return toCentavos(Number.isFinite(bonus.amount) ? (bonus.amount as number) : 0);
}

/** Variable names a formula references (empty for flat bonuses / invalid formulas). */
function bonusVariables(bonus: BonusDef): string[] {
  if (bonus.kind !== 'formula') return [];
  const check = validateFormula(bonus.formula ?? '');
  return check.ok ? check.variables : [];
}

// -- Component ------------------------------------------------------------------

/**
 * Manager-facing QC attribution strip, shown inside a Leadgen/Callback/Discovery
 * panel. Surfaces which QC officer was responsible for the week's first pass,
 * how many members each scored, whether they've locked, and a Return-to-QC
 * action. The scored values themselves are pre-filled into the table by loadDept.
 */
interface QcLogOfficer { email: string; index: number; memberCount: number }
interface QcLogAssignment { qc_officer_email: string; member_email: string; member_name: string | null; department: string }
interface QcLogLock { qc_officer_email: string; status: 'draft' | 'locked'; member_count: number; locked_at: string | null }
interface QcLogReview { department: string; status: 'pending' | 'accepted' | 'returned'; reviewed_by: string | null; reviewed_at: string | null; note: string | null }

function QcOfficerLog({
  deptKey,
  periodStart,
  selectedOfficer = null,
  onSelectOfficer,
}: {
  deptKey: string;
  periodStart: string;
  /** The officer whose people the table is currently filtered to (parent-owned). */
  selectedOfficer?: string | null;
  /** Click an officer to filter the table to the people they scored; null clears. */
  onSelectOfficer?: (sel: { officer: string; emails: string[] } | null) => void;
}) {
  const [data, setData] = useState<{
    officers: QcLogOfficer[];
    assignments: QcLogAssignment[];
    locks: QcLogLock[];
    review: QcLogReview[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [returning, setReturning] = useState(false);
  // Unique per mount so two QcOfficerLogs that briefly coexist during the
  // calculator's view-mode swap (AnimatePresence keeps the exiting panel mounted
  // while the new one enters) don't reuse the SAME realtime channel name — which
  // throws "cannot add postgres_changes callbacks after subscribe()".
  const channelUid = useId().replace(/[^a-z0-9]/gi, '');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/qc/assignments?period_start=${periodStart}`, { cache: 'no-store' });
      const json = (await res.json()) as {
        officers?: QcLogOfficer[]; assignments?: QcLogAssignment[]; locks?: QcLogLock[]; review?: QcLogReview[];
      };
      setData({
        officers: json.officers ?? [],
        assignments: json.assignments ?? [],
        locks: json.locks ?? [],
        review: json.review ?? [],
      });
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [periodStart]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Live: reflect officer locks / re-splits as they happen.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`qc-log-${deptKey}-${channelUid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qc_officer_locks' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qc_kpi_submissions' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qc_score_assignments' }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [deptKey, load, channelUid]);

  const deptAssignments = (data?.assignments ?? []).filter((a) => a.department === deptKey);
  const indexByOfficer = new Map((data?.officers ?? []).map((o) => [o.email.toLowerCase(), o.index]));
  const lockByOfficer = new Map((data?.locks ?? []).map((l) => [l.qc_officer_email.toLowerCase(), l]));
  const countByOfficer = new Map<string, number>();
  const membersByOfficer = new Map<string, { email: string; name: string }[]>();
  for (const a of deptAssignments) {
    const e = a.qc_officer_email.toLowerCase();
    countByOfficer.set(e, (countByOfficer.get(e) ?? 0) + 1);
    const list = membersByOfficer.get(e) ?? [];
    list.push({ email: a.member_email, name: a.member_name ?? a.member_email });
    membersByOfficer.set(e, list);
  }
  for (const list of membersByOfficer.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const officerEmails = Array.from(countByOfficer.keys()).sort(
    (a, b) => (indexByOfficer.get(a) ?? 99) - (indexByOfficer.get(b) ?? 99),
  );
  const review = (data?.review ?? []).find((r) => r.department === deptKey);

  async function returnToQc() {
    const note = window.prompt('Optional note to the QC officer(s) on what to revise:') ?? '';
    setReturning(true);
    try {
      const res = await fetch('/api/qc/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_start: periodStart, department: deptKey, status: 'returned', note }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? 'Failed to return');
      }
      toast.success('Returned to QC for revision');
      void load();
    } catch (e) {
      toast.error('Could not return to QC', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setReturning(false);
    }
  }

  const fmtTime = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  return (
    <div className="flex h-full min-h-0 w-40 shrink-0 flex-col border-r border-orange-100 bg-orange-50/40 dark:border-orange-950/40 dark:bg-orange-950/10 sm:w-48">
      {/* Header */}
      <div className="flex-none border-b border-orange-100/70 px-3 py-2.5 dark:border-orange-950/40">
        <div className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-700 dark:text-orange-300">
          <Users className="h-3 w-3" /> QC first pass
        </div>
        {(review?.status === 'returned' || review?.status === 'accepted') && (
          <div className="mt-1">
            {review?.status === 'returned' && (
              <span className="rounded bg-amber-200/70 px-1 py-px text-[9px] text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">returned</span>
            )}
            {review?.status === 'accepted' && (
              <span className="rounded bg-emerald-200/70 px-1 py-px text-[9px] text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">accepted</span>
            )}
          </div>
        )}
        <p className="mt-1 text-[9.5px] leading-tight text-zinc-400 dark:text-zinc-500">
          Click an officer to filter the table to who they scored.
        </p>
      </div>

      {/* Officer list (scrolls) */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {loading ? (
          <div className="flex items-center gap-1.5 px-1 text-[11px] text-zinc-500">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : officerEmails.length === 0 ? (
          <p className="px-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            No QC officer is assigned to score this department yet.
          </p>
        ) : (
          <>
            {selectedOfficer && (
              <button
                type="button"
                onClick={() => onSelectOfficer?.(null)}
                className="mb-1.5 flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] font-medium text-orange-700 transition-colors hover:bg-orange-100/70 dark:text-orange-300 dark:hover:bg-orange-950/40"
              >
                <CornerUpLeft className="h-3 w-3" /> Show all people
              </button>
            )}
            <ul className="space-y-1">
              {officerEmails.map((email) => {
                const lock = lockByOfficer.get(email);
                const locked = lock?.status === 'locked';
                const idx = indexByOfficer.get(email);
                const count = countByOfficer.get(email) ?? 0;
                const active = selectedOfficer === email;
                return (
                  <li key={email}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        onSelectOfficer?.(
                          active
                            ? null
                            : { officer: email, emails: (membersByOfficer.get(email) ?? []).map((m) => m.email) },
                        )
                      }
                      title={email}
                      className={cn(
                        'w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                        active
                          ? 'border-orange-400 bg-white ring-1 ring-orange-300 dark:border-orange-600 dark:bg-zinc-900 dark:ring-orange-700'
                          : locked
                            ? 'border-emerald-200 bg-emerald-50/70 hover:bg-emerald-100/70 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/40'
                            : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:bg-zinc-800/60',
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-100">QC Officer {idx ?? '?'}</span>
                        {locked ? (
                          <Lock className="h-3 w-3 shrink-0 text-emerald-500" aria-label="locked" />
                        ) : (
                          <Clock className="h-3 w-3 shrink-0 text-zinc-400" aria-label="scoring" />
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[9px] text-zinc-400" title={email}>{email}</div>
                      <div className="mt-0.5 text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">
                        {count} {count === 1 ? 'person' : 'people'}
                        {locked && lock?.locked_at ? ` · ${fmtTime(lock.locked_at)}` : ''}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* Footer: send back to QC */}
      {officerEmails.length > 0 && (
        <div className="flex-none border-t border-orange-100/70 p-2 dark:border-orange-950/40">
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full gap-1.5 text-[11px]"
            disabled={returning}
            onClick={() => void returnToQc()}
          >
            <CornerUpLeft className="h-3 w-3" /> Return to QC
          </Button>
        </div>
      )}
    </div>
  );
}

export default function DeptBonusCalculator({
  viewerEmail,
  teamMembers,
  managedDepts,
  isElevated,
  variant = 'manager',
  assignedByDept,
  qcLocked = false,
  onToggleQcLock,
  onWeekChange,
  controlledWeek,
}: DeptBonusCalculatorProps) {
  // QC officer's first-pass calculator vs the manager's official one. QC writes
  // a separate staging table and never touches `bonus_catalog_applied` /
  // `hsl_bonus_period_status` (payroll) directly.
  const isQc = variant === 'qc';
  const appliedEndpoint = isQc ? '/api/qc/submissions' : '/api/bonus-catalog-applied';
  // QC mode roster source: the officer's assigned members per department (the
  // authoritative per-dept roster in QC mode), plus a per-dept email set for
  // filtering saved rows. Built from the `assignedByDept` prop.
  const qcRosterByDept = useMemo(() => {
    const map = new Map<string, Array<{ email: string; name: string }>>();
    for (const [dept, list] of Object.entries(assignedByDept ?? {})) {
      const seen = new Set<string>();
      const out: Array<{ email: string; name: string }> = [];
      for (const m of list) {
        const e = m.email.trim().toLowerCase();
        if (!e || seen.has(e)) continue;
        seen.add(e);
        out.push({ email: e, name: m.name });
      }
      if (out.length > 0) map.set(dept, out.sort((a, b) => a.name.localeCompare(b.name)));
    }
    return map;
  }, [assignedByDept]);
  const qcEmailsByDept = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [dept, list] of qcRosterByDept) map.set(dept, new Set(list.map((m) => m.email)));
    return map;
  }, [qcRosterByDept]);
  // The active pay-week. In *controlled* mode (the QC shell owns the week via
  // `controlledWeek`) this DERIVES from the prop — a single source of truth, so
  // there is no state-sync effect to ping-pong against `onWeekChange`. Otherwise
  // the calculator manages it locally (the manager view).
  const weekIsControlled = controlledWeek != null;
  const [internalWeek, setInternalWeek] = useState(() => isoWeekStart(new Date()));
  const weekStart = weekIsControlled ? (controlledWeek as string) : internalWeek;
  const weekEnd = useMemo(() => weekEndFromStart(weekStart), [weekStart]);

  // Report the calculator's OWN week changes up to the shell. Skipped when the
  // shell controls the week — it already knows (user picks route through
  // `selectWeek` → `onWeekChange` directly), so firing here would only echo.
  useEffect(() => {
    if (!weekIsControlled) onWeekChange?.(weekStart);
  }, [weekStart, onWeekChange, weekIsControlled]);

  // A user-initiated week change. When the shell owns the week, route the pick up
  // through `onWeekChange` (the shell updates `controlledWeek`, which flows back in
  // as the derived `weekStart`); otherwise update local state.
  const selectWeek = useCallback(
    (w: string) => {
      if (weekIsControlled) onWeekChange?.(w);
      else setInternalWeek(w);
    },
    [weekIsControlled, onWeekChange],
  );

  // Which weeks the manager can switch between (one per uploaded Hubstaff file)
  // and which one is the *live* payroll week (the Initialized / is_current batch).
  const [availableWeeks, setAvailableWeeks] = useState<{ start: string; end: string }[]>([]);
  const [currentWeekStart, setCurrentWeekStart] = useState<string | null>(null);
  // Always offer the selected + live weeks even before the upload list resolves.
  const weekOptions = useMemo(() => {
    const map = new Map<string, { start: string; end: string }>();
    for (const w of availableWeeks) map.set(w.start, w);
    for (const s of [currentWeekStart, weekStart]) {
      if (s && !map.has(s)) map.set(s, { start: s, end: weekEndFromStart(s) });
    }
    return Array.from(map.values()).sort((a, b) =>
      a.start < b.start ? 1 : a.start > b.start ? -1 : 0,
    );
  }, [availableWeeks, currentWeekStart, weekStart]);
  const isLiveWeek = currentWeekStart == null || weekStart === currentWeekStart;

  // Catalog (authored in Accounting -> Bonus Catalog).
  const [bonuses, setBonuses] = useState<BonusDef[]>([]);
  const [assignments, setAssignments] = useState<BonusAssignment[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // Live USD-anchored FX rates. Non-PHP catalog bonuses are converted to PHP at
  // these rates when applied, mirroring how Pay Structures convert (resolve-rate.ts):
  // USD at usd_to_php_rate, COP via the USD-anchored cross-rate. Read from the
  // same benign app_settings keys the Payroll Wizard uses, falling back to the
  // official rates.
  const [fx, setFx] = useState<FxRates>(officialFxRates());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/app-settings?keys=usd_to_php_rate,usd_to_cop_rate', { cache: 'no-store' });
        const json = (await res.json()) as { values?: Record<string, string | null> };
        if (!cancelled) {
          const v = json.values ?? {};
          setFx({
            usdToPhp: effectiveUsdToPhpRateFromStored(v['usd_to_php_rate']),
            usdToCop: effectiveUsdToCopRateFromStored(v['usd_to_cop_rate']),
          });
        }
      } catch {
        /* keep the official fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bonusById = useMemo(() => {
    const m = new Map<string, BonusDef>();
    for (const b of bonuses) m.set(b.id, b);
    return m;
  }, [bonuses]);

  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/bonus-catalog', { cache: 'no-store' });
      const json = (await res.json()) as { bonuses?: BonusDef[]; assignments?: BonusAssignment[] };
      setBonuses(json.bonuses ?? []);
      setAssignments(json.assignments ?? []);
    } catch {
      /* keep prior */
    } finally {
      setCatalogLoaded(true);
    }
  }, []);

  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);

  // Roster grouped by normalized department key, limited to this calculator's depts.
  const rosterByDept = useMemo(() => {
    const map = new Map<string, { email: string; name: string }[]>();
    for (const r of teamMembers) {
      const key = normalizeDeptToKey(r.department);
      if (!key || !MANAGER_BONUS_DEPT_KEYS.includes(key)) continue;
      const email = rowEmail(r);
      if (!email) continue;
      const list = map.get(key) ?? [];
      list.push({ email, name: r.name ?? email });
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [teamMembers]);

  // Every email a single person owns — personal, work, and any alternate work
  // address — collapses to ONE identity key: the same personal-first key the
  // roster uses (`rowEmail`). The Payment Catalog stores assignments, exclusions
  // and applied rows under whatever email the accountant typed (usually the WORK
  // email), so anyone whose work email differs from their roster (personal) key —
  // e.g. scottc@simple.biz vs scottcam000@gmail.com — used to surface as a second
  // phantom member card and risk a double bonus. Aliasing is built ONLY from
  // emails that co-occur on the same master row, so two distinct humans who share
  // a near-identical work email are never merged.
  const emailAlias = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of teamMembers) {
      const canonical = rowEmail(r);
      if (!canonical) continue;
      for (const raw of [
        r.personal_email,
        r.work_email,
        r.alternate_work_email,
        r.alternate_work_email_2,
      ]) {
        const e = normEmail(raw ?? null);
        if (e) map.set(e, canonical);
      }
    }
    return map;
  }, [teamMembers]);

  const canonEmail = useCallback(
    (email: string | null | undefined): string => {
      const e = normEmail(email ?? null) || (email ?? '').trim().toLowerCase();
      return emailAlias.get(e) ?? e;
    },
    [emailAlias],
  );

  // Identity email (personal-first key) → company work email, so the people
  // search can match on the work address even though members are keyed on the
  // displayed (personal-first) email. Only set when a distinct work email exists.
  const workEmailByIdentity = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of teamMembers) {
      const id = rowEmail(r);
      const we = normEmail(r.work_email ?? null);
      if (id && we) map.set(id, we);
    }
    return map;
  }, [teamMembers]);

  // Common + per-employee catalog bonuses resolved per department key.
  const commonByDept = useMemo(() => {
    const map = new Map<string, BonusDef[]>();
    for (const a of assignments) {
      if (a.scope !== 'department') continue;
      const key = normalizeDeptToKey(a.departmentKey) ?? a.departmentKey;
      const bonus = bonusById.get(a.bonusId);
      if (!bonus) continue;
      const list = map.get(key) ?? [];
      if (!list.some((b) => b.id === bonus.id)) list.push(bonus);
      map.set(key, list);
    }
    return map;
  }, [assignments, bonusById]);

  // dept key -> set of bonusIds that are "team effort" (shared) common bonuses:
  // entered once for the whole dept, everyone non-excluded receives the result.
  const sharedCommonByDept = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (a.scope !== 'department' || !a.sharedTeam) continue;
      const key = normalizeDeptToKey(a.departmentKey) ?? a.departmentKey;
      const set = map.get(key) ?? new Set<string>();
      set.add(a.bonusId);
      map.set(key, set);
    }
    return map;
  }, [assignments]);

  // dept key -> (bonusId -> set of excluded member emails). A common bonus skips
  // anyone the accountant excluded for it (Payment Catalog -> Assignments).
  const commonExclusionsByDept = useMemo(() => {
    const map = new Map<string, Map<string, Set<string>>>();
    for (const a of assignments) {
      if (a.scope !== 'department' || !a.excludedEmails?.length) continue;
      const key = normalizeDeptToKey(a.departmentKey) ?? a.departmentKey;
      const byBonus = map.get(key) ?? new Map<string, Set<string>>();
      const set = byBonus.get(a.bonusId) ?? new Set<string>();
      // Canonicalize: the accountant excludes by work email, members are keyed by
      // personal-first email — resolve both to the same identity so the exclusion lands.
      for (const e of a.excludedEmails) set.add(canonEmail(e));
      byBonus.set(a.bonusId, set);
      map.set(key, byBonus);
    }
    return map;
  }, [assignments, canonEmail]);

  const individualByDept = useMemo(() => {
    // dept key -> (employee email -> BonusDef[])
    const map = new Map<string, Map<string, BonusDef[]>>();
    for (const a of assignments) {
      if (a.scope !== 'employee' || !a.employeeEmail) continue;
      const key = normalizeDeptToKey(a.departmentKey) ?? a.departmentKey;
      const bonus = bonusById.get(a.bonusId);
      if (!bonus) continue;
      // Key individual assignments by the same canonical identity the roster uses,
      // so an assignment made under the work email attaches to the one member card.
      const email = canonEmail(a.employeeEmail);
      const byEmail = map.get(key) ?? new Map<string, BonusDef[]>();
      const list = byEmail.get(email) ?? [];
      if (!list.some((b) => b.id === bonus.id)) list.push(bonus);
      byEmail.set(email, list);
      map.set(key, byEmail);
    }
    return map;
  }, [assignments, bonusById, canonEmail]);

  const deptLabelByKey = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    const add = (raw: string | null | undefined) => {
      if (!raw) return;
      const k = normalizeDeptToKey(raw);
      if (k && !(k in out)) out[k] = raw.trim();
    };
    for (const r of teamMembers) add(r.department);
    for (const d of managedDepts) add(d);
    return out;
  }, [teamMembers, managedDepts]);

  const visibleDeptKeys = useMemo<string[]>(() => {
    // QC officers only score the QC depts, and only the slots assigned to them
    // (qcRosterByDept is the authoritative per-dept roster in QC mode).
    if (isQc) {
      return QC_DEPT_KEYS.filter((k) => (qcRosterByDept.get(k)?.length ?? 0) > 0);
    }
    if (isElevated) {
      return MANAGER_BONUS_DEPT_KEYS.filter(
        (k) =>
          (rosterByDept.get(k)?.length ?? 0) > 0 ||
          (commonByDept.get(k)?.length ?? 0) > 0 ||
          (individualByDept.get(k)?.size ?? 0) > 0,
      );
    }
    const keys = new Set<string>();
    for (const d of managedDepts) {
      const k = normalizeDeptToKey(d);
      if (k && MANAGER_BONUS_DEPT_KEYS.includes(k)) keys.add(k);
    }
    return Array.from(keys);
  }, [isQc, isElevated, managedDepts, rosterByDept, commonByDept, individualByDept, qcRosterByDept]);

  const [state, setState] = useState<AllState>({});
  // Landing: filter the department cards by name.
  const [deptSearch, setDeptSearch] = useState('');
  // Per-department people search, used inside the open calculator panel.
  const [cardSearch, setCardSearch] = useState<Record<string, string>>({});
  // Lead Gen's roster is long, so its calculator table pages 5 people at a time
  // (zero-based; reset when the open dept or its search changes). Other depts
  // render every row in one scroll.
  const [leadGenPage, setLeadGenPage] = useState(0);
  // The open department (rendered in the overlay) + how the overlay presents:
  // a right-side drawer, or a full-screen focus workspace with a dept rail.
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<OpenMode>('drawer');
  // Manager QC review: when a QC officer is picked in the left rail, the table
  // filters to the people they scored. Keyed by dept so it resets on dept switch.
  const [qcOfficerFilter, setQcOfficerFilter] = useState<{ dept: string; officer: string; emails: string[] } | null>(null);
  // Portal guard: the fixed overlay only renders after mount (SSR-safe).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const reduceMotion = useReducedMotion();
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Pre-submit lock (local, per department): values must be locked before the
  // Submit-to-Payroll button is enabled. Locking freezes the inputs.
  const [lockedDepts, setLockedDepts] = useState<Record<string, boolean>>({});
  // Centered submit confirmation modal: 'sending' -> 'done' / 'error'.
  const [submit, setSubmit] = useState<{
    kind: 'lock' | 'submit';
    key: string;
    phase: 'sending' | 'done' | 'error';
    msg?: string;
  } | null>(null);
  // Mirror of `submit` for the (stable) Escape handler so it can defer to the
  // modal without re-binding the drawer's keydown listener.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  function patchDept(key: string, patch: Partial<DeptState>) {
    setState((prev) => {
      const cur = prev[key];
      if (!cur) return prev; // never create a partial (members-less) dept state
      return { ...prev, [key]: { ...cur, ...patch } };
    });
  }

  /** Bonuses applicable to one member: dept-common + that person's individual ones. */
  const applicableBonuses = useCallback(
    (deptKey: string, email: string): BonusDef[] => {
      const common = commonByDept.get(deptKey) ?? [];
      const indiv = individualByDept.get(deptKey)?.get(email) ?? [];
      const excludedFor = commonExclusionsByDept.get(deptKey);
      const lower = email.toLowerCase();
      const seen = new Set<string>();
      const out: BonusDef[] = [];
      // Common bonuses, minus anyone explicitly excluded from them.
      for (const b of common) {
        if (excludedFor?.get(b.id)?.has(lower)) continue;
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        out.push(b);
      }
      // Individual assignments always apply (and override a common exclusion).
      for (const b of indiv) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        out.push(b);
      }
      return out;
    },
    [commonByDept, individualByDept, commonExclusionsByDept],
  );

  // -- Load existing applied rows + status for a department ----------------------

  const loadDept = useCallback(
    async (key: string) => {
      // QC mode: the roster IS the officer's assigned slots for this dept (which
      // includes transferred people under their old dept). Manager mode groups
      // the live team roster by department as usual.
      const roster = isQc ? (qcRosterByDept.get(key) ?? []) : (rosterByDept.get(key) ?? []);
      const qcDeptEmails = isQc ? qcEmailsByDept.get(key) : undefined;
      try {
        // Manager mode reads the official applied rows + payroll status. QC mode
        // reads its own staging table and has no payroll status (the officer's
        // lock is a separate, officer-level concept).
        const appliedRes = await fetch(`${appliedEndpoint}?dept=${key}&period_start=${weekStart}`, { cache: 'no-store' });
        const appliedJson = (await appliedRes.json()) as {
          rows?: {
            employee_email: string;
            employee_name: string | null;
            bonus_id: string;
            vars: Record<string, number> | null;
          }[];
        };
        let savedRows = appliedJson.rows ?? [];

        let status: BonusStatus = 'draft';
        if (!isQc) {
          const statusRes = await fetch(`/api/hsl-bonus/period-status?dept=${key}&period_start=${weekStart}`, { cache: 'no-store' });
          const statusJson = (await statusRes.json()) as { rows?: { status: BonusStatus }[] };
          status = statusJson.rows?.[0]?.status ?? 'draft';
        }

        // Manager mode, QC department, never-saved draft → pre-fill the manager's
        // inputs from the QC officers' first-pass so they appear ready to review
        // and finalize. Once the manager saves, their own rows are authoritative.
        let seededFromQc = false;
        if (!isQc && isQcDeptKey(key) && savedRows.length === 0 && status === 'draft') {
          try {
            const qcRes = await fetch(`/api/qc/submissions?dept=${key}&period_start=${weekStart}`, { cache: 'no-store' });
            const qcJson = (await qcRes.json()) as { rows?: typeof savedRows };
            if (qcJson.rows && qcJson.rows.length > 0) {
              savedRows = qcJson.rows;
              seededFromQc = true;
            }
          } catch {
            /* ignore — fall back to the empty/pre-apply path */
          }
        }

        // Seed members from roster, then overlay anyone who has saved applied rows.
        const byEmail = new Map<string, MemberState>();
        for (const e of roster) byEmail.set(e.email, { email: e.email, name: e.name, applied: {} });
        // Also include individually-assigned employees even if not in the roster
        // fetch — but never in QC mode, where the roster is the assignment.
        const indivMap = individualByDept.get(key);
        if (indivMap && !isQc) {
          for (const email of indivMap.keys()) {
            if (!byEmail.has(email)) byEmail.set(email, { email, name: email, applied: {} });
          }
        }
        const sharedSet = sharedCommonByDept.get(key);
        const shared: Record<string, AppliedState> = {};
        for (const row of savedRows) {
          // Saved rows may be keyed under any of the person's emails (work vs
          // personal) — collapse to the canonical identity so duplicate rows from
          // a prior dual-email save merge onto the single member card.
          const em = canonEmail(row.employee_email);
          if (!em) continue;
          // QC mode: /api/qc/submissions returns ALL officers' rows for the dept;
          // keep only members in THIS officer's assignment for the dept. Match on
          // BOTH the canonical and the raw-normalized email — a transferred person
          // isn't in the live roster so canonEmail can't alias their address, but
          // their assignment + submission both key off the personal-first email.
          const rawEm = (row.employee_email ?? '').trim().toLowerCase();
          if (isQc && qcDeptEmails && !qcDeptEmails.has(em) && !qcDeptEmails.has(rawEm)) continue;
          const vars: Record<string, string> = {};
          if (row.vars) for (const [k, v] of Object.entries(row.vars)) vars[k] = String(v);
          // Team-effort bonuses are stored per-member but are identical across the
          // dept -- collapse them into one shared entry instead of per-member.
          if (sharedSet?.has(row.bonus_id)) {
            if (!shared[row.bonus_id]) shared[row.bonus_id] = { on: true, vars };
            continue;
          }
          const member =
            byEmail.get(em) ?? { email: em, name: row.employee_name ?? em, applied: {} };
          if (!byEmail.has(em)) byEmail.set(em, member);
          member.applied[row.bonus_id] = { on: true, vars };
        }

        // Pre-apply common bonuses: on a fresh (never-saved, still-draft) week a
        // common bonus set to "everyone" should already be ticked, so the manager
        // doesn't have to apply it by hand. Once the week has been saved, the
        // saved selection is authoritative (a manual untick persists). Excluded
        // members are skipped here and by applicableBonuses regardless.
        let preApplied = false;
        if (savedRows.length === 0 && status === 'draft') {
          const common = commonByDept.get(key) ?? [];
          const exMap = commonExclusionsByDept.get(key);
          for (const b of common) {
            if (sharedSet?.has(b.id)) {
              // Team-effort bonus: one shared entry, default on.
              shared[b.id] = { on: true, vars: {} };
              preApplied = true;
              continue;
            }
            for (const member of byEmail.values()) {
              const lower = member.email.toLowerCase();
              if (exMap?.get(b.id)?.has(lower)) continue;
              if (member.applied[b.id]) continue;
              member.applied[b.id] = { on: true, vars: {} };
              preApplied = true;
            }
          }
        }

        let members = Array.from(byEmail.values()).sort((a, b) => a.name.localeCompare(b.name));
        // QC mode safety net: never surface a member outside this officer's assignment for the dept.
        if (isQc && qcDeptEmails) {
          members = members.filter((m) => qcDeptEmails.has(m.email.toLowerCase()));
        }
        setState((prev) => ({
          // Pre-applied defaults — and QC-seeded values — are unsaved, so mark
          // dirty: manager Save (then Submit) persists into bonus_catalog_applied;
          // QC Save persists into the staging table.
          ...prev,
          [key]: { members, shared, status, dirty: preApplied || seededFromQc, saving: false, loaded: true },
        }));
      } catch {
        setState((prev) => ({
          ...prev,
          [key]: {
            members: roster.map((e) => ({ email: e.email, name: e.name, applied: {} })),
            shared: {},
            status: 'draft',
            dirty: false,
            saving: false,
            loaded: true,
          },
        }));
      }
    },
    [rosterByDept, individualByDept, commonByDept, commonExclusionsByDept, sharedCommonByDept, weekStart, canonEmail, isQc, qcRosterByDept, qcEmailsByDept, appliedEndpoint],
  );

  useEffect(() => {
    if (!catalogLoaded) return;
    visibleDeptKeys.forEach((k) => void loadDept(k));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDeptKeys, loadDept, catalogLoaded]);

  // Live: a teammate authoring/assigning a bonus, or another manager applying one,
  // refetches the catalog and reloads the open departments.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel('dept-bonus-calc')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bonus_catalog_bonuses' }, () => void fetchCatalog())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bonus_catalog_assignments' }, () => void fetchCatalog())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchCatalog]);

  // ── Live refresh ───────────────────────────────────────────────────────────
  // Reload every visible dept, skipping any with unsaved local edits (`dirty`)
  // or an in-flight save so another scorer's change can't clobber work in
  // progress. Used by both the manual Refresh button and the live subscription.
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = useCallback(async () => {
    await Promise.all(
      visibleDeptKeys.map((k) => {
        const d = state[k];
        if (d?.dirty || d?.saving) return Promise.resolve();
        return loadDept(k);
      }),
    );
  }, [visibleDeptKeys, state, loadDept]);

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Pull fresh catalog defs too, in case a bonus was added/retired elsewhere.
      await Promise.all([fetchCatalog(), refreshAll()]);
    } finally {
      setRefreshing(false);
    }
  }, [fetchCatalog, refreshAll]);

  // See other scorers' applied bonuses as they land: watch the applied + status
  // tables and re-pull (debounced). Falls back to a 30s poll + tab-focus refresh
  // when Realtime isn't available for these tables.
  useLiveRefresh({
    // QC officers write the staging tables, not the payroll ones — watch those so
    // a teammate's save / re-split / lock surfaces live (else only the 30s poll).
    tables: isQc
      ? ['qc_kpi_submissions', 'qc_score_assignments', 'qc_officer_locks']
      : ['bonus_catalog_applied', 'hsl_bonus_period_status'],
    onRefresh: refreshAll,
    channel: 'dept-bonus-calc-live',
    enabled: catalogLoaded && visibleDeptKeys.length > 0,
  });

  // First-load gate: the catalog plus every visible dept's applied rows must be
  // in before we reveal the calculator — otherwise switching to the tab flashes
  // an empty grid. (`.every` is vacuously true when nothing is visible, which
  // the parent already guards against.)
  const ready = catalogLoaded && visibleDeptKeys.every((k) => state[k]?.loaded);

  // Pin the KPI week to the Hubstaff batch accounting is dispatching — the
  // Initialized (is_current) upload, NOT merely the newest file. The public
  // endpoint returns newest-first, so we resolve the current batch the same way
  // the Payroll Wizard does (pickCurrentSourceFile) to keep the manager's KPI
  // week in lock-step with the week accounting processes.
  useEffect(() => {
    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (async () => {
      try {
        const res = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
        const json = (await res.json()) as HubstaffSourceFilesResponse;

        // Build the week menu: one entry per distinct uploaded Hubstaff week.
        const seen = new Set<string>();
        const weeks: { start: string; end: string }[] = [];
        const allFiles = [
          ...(json.uploads?.map((u) => u.source_file ?? '') ?? []),
          ...(json.files ?? []),
        ];
        for (const f of allFiles) {
          const range = f ? parseDateRangeFromFilename(f) : null;
          if (!range) continue;
          const startIso = toIso(range.start);
          if (seen.has(startIso)) continue;
          seen.add(startIso);
          weeks.push({ start: startIso, end: weekEndFromStart(startIso) });
        }
        weeks.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
        setAvailableWeeks(weeks);

        // Pin the *live* week to the batch accounting is dispatching (is_current).
        const latest = pickCurrentSourceFile(json.uploads, json.files);
        const range = latest ? parseDateRangeFromFilename(latest) : null;
        if (range) {
          const iso = toIso(range.start);
          setCurrentWeekStart(iso);
          // Default the view to the live week (only while still on today's auto-week).
          // Skipped when the shell controls the week — it does its own defaulting,
          // and overriding here would fight the controlled value on mount.
          if (!weekIsControlled) setInternalWeek((cur) => (cur === isoWeekStart(new Date()) ? iso : cur));
        }
      } catch {
        // keep today's week on any error
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Short, unique abbreviation per visible department for the picker tiles
  // (replaces the old wallpaper thumbnails). Computed over the whole visible set
  // so collisions resolve deterministically and a dept's tag is stable as the
  // landing search narrows.
  const deptAbbrevByKey = useMemo<Record<string, string>>(
    () =>
      uniqueDeptAbbrevs(
        visibleDeptKeys.map((key) => ({
          key,
          name: DEPARTMENTS.find((d) => d.key === key)?.name ?? deptLabelByKey[key] ?? key,
        })),
      ),
    [visibleDeptKeys, deptLabelByKey],
  );

  // -- Live bonus computation ----------------------------------------------------

  const memberTotal = useCallback(
    (deptKey: string, member: MemberState, shared: Record<string, AppliedState> | undefined): Money => {
      const sharedSet = sharedCommonByDept.get(deptKey);
      const sum: Money = zeroMoney();
      for (const bonus of applicableBonuses(deptKey, member.email)) {
        // Team-effort bonus: every member gets the single shared amount.
        if (sharedSet?.has(bonus.id)) {
          const sh = shared?.[bonus.id];
          if (sh?.on) sum[effectiveCurrency(deptKey, bonus)] += computeNative(bonus, sh.vars);
          continue;
        }
        const st = member.applied[bonus.id];
        if (st?.on) sum[effectiveCurrency(deptKey, bonus)] += computeNative(bonus, st.vars);
      }
      return sum;
    },
    [applicableBonuses, sharedCommonByDept],
  );

  const deptTotal = useCallback(
    (deptKey: string, st: DeptState | undefined): Money => {
      if (!st) return zeroMoney();
      return st.members.reduce<Money>(
        (s, m) => addMoney(s, memberTotal(deptKey, m, st.shared)),
        zeroMoney(),
      );
    },
    [memberTotal],
  );

  // Per-department view data: the derived rows, columns, subtotals and progress
  // stats shared by the landing card (summary) and the open calculator panel.
  const buildDeptView = useCallback(
    (key: string) => {
      const d = state[key];
      const dept = DEPARTMENTS.find((x) => x.key === key);
      const color = deptColor(key);
      // QC mode freezes inputs once the officer has locked their week's batch;
      // manager mode freezes once the dept is submitted (status != draft).
      const readOnly = isQc ? !!qcLocked : d ? d.status !== 'draft' : false;
      const total = deptTotal(key, d);
      const common = commonByDept.get(key) ?? [];
      const sharedSet = sharedCommonByDept.get(key);
      const normalCommon = common.filter((b) => !sharedSet?.has(b.id));
      const sharedCommon = common.filter((b) => sharedSet?.has(b.id));
      const allMembers = d?.members ?? [];
      const cq = (cardSearch[key] ?? '').trim().toLowerCase();
      const members = cq
        ? allMembers.filter(
            (e) =>
              e.name.toLowerCase().includes(cq) ||
              e.email.toLowerCase().includes(cq) ||
              (workEmailByIdentity.get(e.email)?.includes(cq) ?? false),
          )
        : allMembers;
      const hasIndividual = (individualByDept.get(key)?.size ?? 0) > 0;
      const hasAnyBonus = common.length > 0 || hasIndividual;

      // Per-column rollups for the table (header tri-state + footer subtotals),
      // computed over *all* members so the footer reflects the whole dept
      // independent of the current search view.
      const isApplicable = (email: string, bonusId: string) =>
        applicableBonuses(key, email).some((x) => x.id === bonusId);
      const colMeta = normalCommon.map((b) => {
        const appMembers = allMembers.filter((m) => isApplicable(m.email, b.id));
        const onCount = appMembers.filter((m) => m.applied[b.id]?.on).length;
        // A column is one bonus, so its subtotal is a single native currency.
        const subtotal = appMembers.reduce(
          (s, m) => s + (m.applied[b.id]?.on ? computeNative(b, m.applied[b.id]?.vars) : 0),
          0,
        );
        return {
          b,
          appCount: appMembers.length,
          onCount,
          allOn: appMembers.length > 0 && onCount === appMembers.length,
          someOn: onCount > 0 && onCount < appMembers.length,
          subtotal,
        };
      });
      const sharedMeta = sharedCommon.map((b) => {
        const sh = d?.shared?.[b.id];
        const on = !!sh?.on;
        const perPerson = on ? computeNative(b, sh?.vars) : 0;
        const appCount = allMembers.filter((m) => isApplicable(m.email, b.id)).length;
        return { b, sh, on, perPerson, subtotal: perPerson * appCount };
      });
      // Individual bonuses can be a mix of PHP and USD, so the subtotal is split.
      const indivSubtotal = allMembers.reduce<Money>(
        (s, m) => {
          const ind = applicableBonuses(key, m.email).filter(
            (b) => !common.some((c) => c.id === b.id) && !sharedSet?.has(b.id),
          );
          for (const b of ind) {
            if (m.applied[b.id]?.on) s[effectiveCurrency(key, b)] += computeNative(b, m.applied[b.id]?.vars);
          }
          return s;
        },
        zeroMoney(),
      );

      // Progress: who has any bonus turned on, and who has an ON formula bonus
      // still missing a required input (it would silently pay ₱0 -- worth a nudge).
      let entered = 0;
      let toFill = 0;
      for (const m of allMembers) {
        const appl = applicableBonuses(key, m.email);
        let anyOn = false;
        let needs = false;
        for (const b of appl) {
          const isShared = sharedSet?.has(b.id);
          const st = isShared ? d?.shared?.[b.id] : m.applied[b.id];
          if (!st?.on) continue;
          anyOn = true;
          if (b.kind === 'formula') {
            const vars = bonusVariables(b);
            if (vars.some((v) => !String(st.vars?.[v] ?? '').trim())) needs = true;
          }
        }
        if (anyOn) entered += 1;
        if (needs) toFill += 1;
      }

      return {
        d, dept, color, readOnly, total,
        common, sharedSet, normalCommon, sharedCommon,
        allMembers, members, cq,
        hasIndividual, hasAnyBonus,
        colMeta, sharedMeta, indivSubtotal,
        entered, toFill,
      };
    },
    [
      state, cardSearch, deptTotal, commonByDept, sharedCommonByDept,
      individualByDept, applicableBonuses, fx, workEmailByIdentity, isQc, qcLocked,
    ],
  );

  // -- Mutators ------------------------------------------------------------------

  function toggleBonus(deptKey: string, email: string, bonusId: string, on: boolean) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev; // dept not loaded yet -- ignore
      return {
        ...prev,
        [deptKey]: {
          ...d,
          dirty: true,
          members: d.members.map((m) =>
            m.email === email
              ? { ...m, applied: { ...m.applied, [bonusId]: { on, vars: m.applied[bonusId]?.vars ?? {} } } }
              : m,
          ),
        },
      };
    });
  }

  function setVar(deptKey: string, email: string, bonusId: string, varName: string, value: string) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev; // dept not loaded yet -- ignore
      return {
        ...prev,
        [deptKey]: {
          ...d,
          dirty: true,
          members: d.members.map((m) => {
            if (m.email !== email) return m;
            const cur = m.applied[bonusId] ?? { on: true, vars: {} };
            return {
              ...m,
              applied: { ...m.applied, [bonusId]: { on: true, vars: { ...cur.vars, [varName]: value } } },
            };
          }),
        },
      };
    });
  }

  /** Turn a team-effort (shared) bonus on/off for the whole department. */
  function toggleShared(deptKey: string, bonusId: string, on: boolean) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev;
      const cur = d.shared[bonusId] ?? { on: false, vars: {} };
      return {
        ...prev,
        [deptKey]: { ...d, dirty: true, shared: { ...d.shared, [bonusId]: { ...cur, on } } },
      };
    });
  }

  /** Set a shared formula variable for a team-effort bonus (entered once). */
  function setSharedVar(deptKey: string, bonusId: string, varName: string, value: string) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev;
      const cur = d.shared[bonusId] ?? { on: true, vars: {} };
      return {
        ...prev,
        [deptKey]: {
          ...d,
          dirty: true,
          shared: { ...d.shared, [bonusId]: { on: true, vars: { ...cur.vars, [varName]: value } } },
        },
      };
    });
  }

  /** Toggle a common bonus on/off for every member of the department at once. */
  function applyToAll(deptKey: string, bonusId: string, on: boolean) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev; // dept not loaded yet -- ignore
      return {
        ...prev,
        [deptKey]: {
          ...d,
          dirty: true,
          members: d.members.map((m) => ({
            ...m,
            applied: { ...m.applied, [bonusId]: { on, vars: m.applied[bonusId]?.vars ?? {} } },
          })),
        },
      };
    });
  }

  // -- Persistence ---------------------------------------------------------------

  async function saveDept(key: string): Promise<boolean> {
    const d = state[key];
    if (!d) return false;
    patchDept(key, { saving: true });
    let ok = false;
    try {
      const sharedSet = sharedCommonByDept.get(key);
      const rows = [] as Array<Record<string, unknown>>;
      for (const m of d.members) {
        for (const bonus of applicableBonuses(key, m.email)) {
          // Team-effort bonuses pull from the single shared entry; everyone who
          // is applicable gets an identical row (so the Wizard pays each member).
          const isShared = sharedSet?.has(bonus.id);
          const st = isShared ? d.shared[bonus.id] : m.applied[bonus.id];
          if (!st?.on) continue;
          const numVars: Record<string, number> = {};
          for (const v of bonusVariables(bonus)) numVars[v] = Number(st.vars?.[v] ?? '') || 0;
          rows.push({
            // QC staged rows live in a separate table — prefix the id so they
            // can never collide with the official applied rows.
            id: (isQc ? 'qc:' : '') + appliedId(key, weekStart, m.email, bonus.id),
            periodStart: weekStart,
            periodEnd: weekEnd,
            department: key,
            employeeEmail: m.email,
            employeeName: m.name,
            bonusId: bonus.id,
            bonusName: bonus.name,
            kind: bonus.kind,
            vars: bonus.kind === 'formula' ? numVars : null,
            // USD bonuses are converted to PHP here so the saved amount (and the
            // Payroll Wizard "KPI Sub." sum) stays PHP. The rate is snapshotted
            // at apply time, like the rest of the applied row. A USD-forced
            // department (US Manager Bonus) converts too, even when the bonus
            // itself isn't tagged USD — matching what the calculator displays.
            amount: computeAmount(bonus, st.vars, fx, effectiveCurrency(key, bonus)),
          });
        }
      }
      const res = await fetch(appliedEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department: key, period_start: weekStart, period_end: weekEnd, rows }),
      });
      const json = (await res.json()) as { error?: string | null; saved?: number };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
      patchDept(key, { dirty: false });
      const stillDraft = d.status !== 'ready' && d.status !== 'locked';
      const applied = `${rows.length} bonus${rows.length === 1 ? '' : 'es'} applied`;
      toast.success(`${DEPARTMENTS.find((x) => x.key === key)?.name ?? key} saved`, {
        description: isQc
          ? `${applied} · lock & send to manager when done`
          : stillDraft
            ? `${applied} · lock & submit before payroll`
            : applied,
      });
      ok = true;
    } catch (e) {
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      patchDept(key, { saving: false });
    }
    return ok;
  }

  async function setStatus(key: string, next: BonusStatus, opts?: { silent?: boolean }): Promise<boolean> {
    try {
      const res = await fetch('/api/hsl-bonus/period-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department: key,
          period_type: 'weekly',
          period_start: weekStart,
          period_end: weekEnd,
          status: next,
          locked_by: viewerEmail ?? undefined,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Status update failed');
      patchDept(key, { status: next });
      return true;
    } catch (e) {
      if (!opts?.silent) {
        toast.error('Status update failed', { description: e instanceof Error ? e.message : String(e) });
      }
      return false;
    }
  }

  /** Lock a department's values (saving any pending edits first). Locking
   *  freezes the inputs and is required before Submit-to-Payroll is enabled.
   *  Drives the centered loading modal (locking -> locked). */
  async function lockValues(key: string) {
    const d = state[key];
    if (!d) return;
    setSubmit({ kind: 'lock', key, phase: 'sending' });
    const t0 = Date.now();
    if (d.dirty) {
      const ok = await saveDept(key);
      if (!ok) {
        // Save failed -- stay editable so nothing is lost.
        setSubmit({ kind: 'lock', key, phase: 'error', msg: 'Could not save before locking. Check your connection and try again.' });
        return;
      }
    }
    // Minimum dwell so the loading modal reads as deliberate, not a flash.
    const wait = Math.max(0, 550 - (Date.now() - t0));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    setLockedDepts((m) => ({ ...m, [key]: true }));
    setSubmit({ kind: 'lock', key, phase: 'done' });
  }

  function unlockValues(key: string) {
    setLockedDepts((m) => ({ ...m, [key]: false }));
  }

  /** Submit locked values to payroll. Drives the centered confirmation modal
   *  (sending -> submitted) rather than a toast. */
  async function submitToPayroll(key: string) {
    setSubmit({ kind: 'submit', key, phase: 'sending' });
    const ok = await setStatus(key, 'ready', { silent: true });
    if (ok) {
      setLockedDepts((m) => ({ ...m, [key]: false }));
      setSubmit({ kind: 'submit', key, phase: 'done' });
      // Finalizing a QC department accepts the QC officers' first-pass for the
      // week (closes the review handoff). Best-effort — payroll submit succeeded.
      if (isQcDeptKey(key)) {
        void fetch('/api/qc/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ period_start: weekStart, department: key, status: 'accepted' }),
        });
      }
    } else {
      setSubmit({ kind: 'submit', key, phase: 'error', msg: 'Could not reach the server. Check your connection and try again.' });
    }
  }

  // -- QC mode: officer-level lock (covers all their assigned members) ----------

  /** Save any dirty departments, then ask QCApp to persist the officer's lock
   *  for the week. Reuses the centered submit modal for feedback. */
  async function qcLockPeriod() {
    if (!onToggleQcLock) return;
    const firstKey = visibleDeptKeys[0] ?? 'qc';
    setSubmit({ kind: 'submit', key: firstKey, phase: 'sending' });
    const t0 = Date.now();
    for (const k of visibleDeptKeys) {
      if (state[k]?.dirty) {
        const saved = await saveDept(k);
        if (!saved) {
          setSubmit({ kind: 'submit', key: firstKey, phase: 'error', msg: 'Could not save before locking. Check your connection and try again.' });
          return;
        }
      }
    }
    const ok = await onToggleQcLock(true);
    const wait = Math.max(0, 550 - (Date.now() - t0));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    setSubmit(ok
      ? { kind: 'submit', key: firstKey, phase: 'done' }
      : { kind: 'submit', key: firstKey, phase: 'error', msg: 'Could not reach the server. Check your connection and try again.' });
  }

  async function qcReopen() {
    if (!onToggleQcLock) return;
    const firstKey = visibleDeptKeys[0] ?? 'qc';
    setSubmit({ kind: 'submit', key: firstKey, phase: 'sending' });
    const ok = await onToggleQcLock(false);
    setSubmit(ok
      ? { kind: 'submit', key: firstKey, phase: 'done' }
      : { kind: 'submit', key: firstKey, phase: 'error', msg: 'Could not reach the server. Check your connection and try again.' });
  }

  // -- Overlay open / close / navigation -----------------------------------------

  const open = useCallback((key: string) => setOpenId(key), []);
  const close = useCallback(() => setOpenId(null), []);
  const goDept = useCallback(
    (delta: number) => {
      setOpenId((cur) => {
        if (!cur) return cur;
        const i = visibleDeptKeys.indexOf(cur);
        if (i < 0) return cur;
        const n = (i + delta + visibleDeptKeys.length) % visibleDeptKeys.length;
        return visibleDeptKeys[n] ?? cur;
      });
    },
    [visibleDeptKeys],
  );

  // If the open department drops out of view (catalog/roster change), close.
  useEffect(() => {
    if (openId && !visibleDeptKeys.includes(openId)) setOpenId(null);
  }, [openId, visibleDeptKeys]);

  // Reset the paginated table to its first page (and clear any QC officer filter)
  // whenever the open dept changes.
  useEffect(() => {
    setLeadGenPage(0);
    setQcOfficerFilter(null);
  }, [openId]);

  // Auto-dismiss the confirmation a moment after it succeeds (lock is lighter,
  // so it lingers less than a payroll submission).
  useEffect(() => {
    if (submit?.phase !== 'done') return;
    const t = window.setTimeout(() => setSubmit(null), submit.kind === 'lock' ? 1100 : 1900);
    return () => window.clearTimeout(t);
  }, [submit]);

  // While the overlay is open: Escape closes it and the page behind it is locked
  // from scrolling. Move focus into the panel for keyboard users.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      // While the submit modal is up it owns Escape; don't close the panel under it.
      if (e.key === 'Escape' && !submitRef.current) close();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = window.setTimeout(() => panelRef.current?.focus(), 60);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(t);
    };
  }, [openId, close]);

  // -- Derived view data ---------------------------------------------------------

  const grandTotal = useMemo<Money>(() => {
    let sum: Money = zeroMoney();
    for (const k of visibleDeptKeys) {
      sum = addMoney(sum, deptTotal(k, state[k]));
    }
    return sum;
  }, [visibleDeptKeys, state, deptTotal]);

  const totalPeople = useMemo(
    () => visibleDeptKeys.reduce((s, k) => s + (state[k]?.members.length ?? 0), 0),
    [visibleDeptKeys, state],
  );

  const dq = deptSearch.trim().toLowerCase();
  const filteredDeptKeys = dq
    ? visibleDeptKeys.filter((k) =>
        (DEPARTMENTS.find((d) => d.key === k)?.name ?? k).toLowerCase().includes(dq),
      )
    : visibleDeptKeys;

  if (visibleDeptKeys.length === 0) return null;

  // Weekly KPI deadline: managers submit before the current week's payroll.
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const [ey, em, ed] = weekEnd.split('-').map(Number);
  const daysLeft = Math.round((new Date(ey!, em! - 1, ed!).getTime() - today0) / 86_400_000);
  const overdue = daysLeft < 0;
  const totalDepts = visibleDeptKeys.length;
  const readyCount = visibleDeptKeys.filter((k) => {
    const s = state[k]?.status;
    return s === 'ready' || s === 'locked';
  }).length;
  const closingSoon = isLiveWeek && daysLeft <= 2;

  // -- Calculator panel (rendered inside the drawer / focus overlay) -------------

  const renderPanel = (key: string) => {
    const v = buildDeptView(key);
    const {
      d, dept, color, total, common, sharedSet,
      colMeta, sharedMeta, indivSubtotal, hasIndividual, hasAnyBonus,
      allMembers, cq, entered, toFill,
    } = v;
    // QC officer filter (manager review): when an officer is picked in the left
    // rail, show only the people they scored. Matched on the canonical
    // (personal-first) identity key, same as the QC member_email join.
    const officerFilter =
      !isQc && qcOfficerFilter && qcOfficerFilter.dept === key
        ? new Set(qcOfficerFilter.emails.map((e) => canonEmail(e)))
        : null;
    const members = officerFilter
      ? v.members.filter((m) => officerFilter.has(canonEmail(m.email)))
      : v.members;
    // Re-keys the table ONLY when the QC officer filter toggles (not on search /
    // pagination), so picking an officer cross-fades the table smoothly.
    const tableAnimKey = officerFilter ? `off:${qcOfficerFilter!.officer}` : 'all';
    // Inputs freeze both after submission (status != draft) and once the
    // manager has locked the values locally ahead of submitting.
    const statusReadOnly = v.readOnly;
    const editLocked = !!lockedDepts[key];
    const readOnly = statusReadOnly || editLocked;
    const accentSoft = hexA(color, 0.13);
    const accentBorder = hexA(color, 0.4);
    const tableReady = !!d?.loaded && hasAnyBonus && allMembers.length > 0;
    const chipBonuses = [...v.normalCommon, ...v.sharedCommon];

    // Pagination (Lead Gen only today): slice the search-filtered rows into
    // pages. Footer subtotals, header tri-states and progress are all computed
    // over allMembers, so they stay whole-department correct regardless of page.
    const pageSize = PAGED_DEPTS[key];
    const paginated = !!pageSize && members.length > pageSize;
    const pageCount = paginated ? Math.ceil(members.length / pageSize) : 1;
    const page = Math.min(leadGenPage, pageCount - 1);
    const pagedMembers = paginated ? members.slice(page * pageSize, page * pageSize + pageSize) : members;

    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-white dark:bg-[#0b0e15]">
        {/* Panel header: identity, KPI schema chips, dept nav, mode switch, close */}
        <div className="flex-none border-b border-zinc-200/80 px-4 py-3.5 dark:border-zinc-800 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span
                className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: color, boxShadow: `0 0 0 4px ${hexA(color, 0.15)}` }}
                aria-hidden
              />
              <div className="min-w-0">
                <h2 className="truncate text-[17px] font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
                  {dept?.name ?? key}
                </h2>
                <p className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  {allMembers.length} {allMembers.length === 1 ? 'person' : 'people'} · {fmtWeek(weekStart, weekEnd)}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {visibleDeptKeys.length > 1 && (
                <>
                  <PanelIconButton label="Previous department" onClick={() => goDept(-1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </PanelIconButton>
                  <PanelIconButton label="Next department" onClick={() => goDept(1)}>
                    <ChevronRight className="h-4 w-4" />
                  </PanelIconButton>
                </>
              )}
              <ViewSwitch mode={mode} onChange={setMode} compact />
              <PanelIconButton label="Close" onClick={close}>
                <X className="h-4 w-4" />
              </PanelIconButton>
            </div>
          </div>

          {chipBonuses.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-400">KPIs</span>
              {chipBonuses.map((b) => (
                <span
                  key={b.id}
                  className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] font-medium"
                  style={{ color, backgroundColor: accentSoft, borderColor: accentBorder }}
                  title={b.name}
                >
                  <span className="max-w-[12rem] truncate">{b.name}</span>
                </span>
              ))}
              {hasIndividual && (
                <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                  <User className="h-2.5 w-2.5" /> Individual
                </span>
              )}
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
                → Payout
              </span>
            </div>
          )}
        </div>

        {/* Toolbar: people search + progress */}
        {tableReady && (
          <div className="flex flex-none flex-col gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800/70 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                type="search"
                placeholder={`Search ${allMembers.length} ${allMembers.length === 1 ? 'person' : 'people'}…`}
                value={cardSearch[key] ?? ''}
                onChange={(e) => {
                  setCardSearch((prev) => ({ ...prev, [key]: e.target.value }));
                  if (PAGED_DEPTS[key]) setLeadGenPage(0);
                }}
                className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs text-zinc-900 outline-none transition-colors focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100"
              />
            </div>
            <div className="flex shrink-0 items-center">
              <CompletionGauge
                entered={entered}
                total={allMembers.length}
                toFill={toFill}
                reduce={!!reduceMotion}
              />
            </div>
          </div>
        )}

        {/* Body: optional QC officer rail (left) + the per-person table. The rail
            lets a manager filter the table to one QC officer's scored people. */}
        <div className="flex min-h-0 flex-1">
          {!isQc && isQcDeptKey(key) && (
            <QcOfficerLog
              deptKey={key}
              periodStart={weekStart}
              selectedOfficer={qcOfficerFilter?.dept === key ? qcOfficerFilter.officer : null}
              onSelectOfficer={(sel) => {
                setQcOfficerFilter(sel ? { dept: key, officer: sel.officer, emails: sel.emails } : null);
                setLeadGenPage(0);
              }}
            />
          )}
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tableAnimKey}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: EASE }}
          >
          {!d || !d.loaded ? (
            <DeptTableSkeleton
              rows={Math.min(10, Math.max(3, (isQc ? qcRosterByDept.get(key)?.length : rosterByDept.get(key)?.length) ?? 6))}
              cols={colMeta.length + sharedMeta.length + (hasIndividual ? 1 : 0)}
            />
          ) : !hasAnyBonus ? (
            <div className="px-5 py-12 text-center text-xs text-zinc-400">
              No bonuses assigned to this department yet.
              <br />
              Assign one in Accounting → Bonus Catalog.
            </div>
          ) : members.length === 0 ? (
            <div className="px-5 py-10 text-center text-xs text-zinc-400">
              {officerFilter
                ? 'This QC officer has no matching people here.'
                : cq
                  ? 'No one matches your search.'
                  : 'No team members in this department.'}
            </div>
          ) : (
            <table className="table-keep w-full border-collapse text-left">
              {/* Header: Member · one column per common / team bonus · Total */}
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-[6] min-w-[148px] border-b border-r border-zinc-200 bg-zinc-50 px-3 py-2 align-bottom dark:border-zinc-800 dark:bg-[#0f141b]">
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                      Member
                    </span>
                  </th>

                  {colMeta.map(({ b, allOn, someOn, onCount, appCount }) => (
                    <th
                      key={b.id}
                      className="sticky top-0 z-[4] min-w-[128px] border-b border-l border-zinc-200/70 bg-zinc-50 px-2.5 py-2 align-bottom dark:border-zinc-800/70 dark:bg-zinc-900/70"
                    >
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-start justify-between gap-1.5">
                          <span
                            className="line-clamp-2 text-[11.5px] font-semibold leading-tight text-zinc-800 dark:text-zinc-100"
                            title={b.name}
                          >
                            {b.name}
                          </span>
                          <KindDot kind={b.kind} />
                        </div>
                        <BonusCurrencyTag bonus={b} fx={fx} />
                        <button
                          type="button"
                          disabled={readOnly || !d?.loaded || appCount === 0}
                          onClick={() => applyToAll(key, b.id, !allOn)}
                          title={allOn ? 'Untick for everyone' : 'Tick for everyone'}
                          className={cn(
                            'inline-flex w-fit items-center gap-1 rounded-md border px-1.5 py-0.5 transition-colors disabled:opacity-40',
                            allOn
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : someOn
                                ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300'
                                : 'border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
                          )}
                        >
                          <span
                            className={cn(
                              'flex h-3 w-3 items-center justify-center rounded-[3px] border',
                              allOn
                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                : someOn
                                  ? 'border-amber-500 bg-amber-500 text-white'
                                  : 'border-zinc-300 dark:border-zinc-600',
                            )}
                          >
                            {allOn ? <Check className="h-2 w-2" strokeWidth={3.5} /> : someOn ? <Minus className="h-2 w-2" strokeWidth={3.5} /> : null}
                          </span>
                          <span className="font-mono text-[9px] font-semibold tabular-nums">
                            {onCount}/{appCount}
                          </span>
                        </button>
                      </div>
                    </th>
                  ))}

                  {sharedMeta.map(({ b, sh, on, perPerson }) => {
                    const vars = bonusVariables(b);
                    return (
                      <th
                        key={b.id}
                        className="sticky top-0 z-[4] min-w-[144px] border-b border-l border-violet-200/70 bg-violet-50/70 px-2.5 py-2 align-bottom dark:border-violet-900/50 dark:bg-violet-950/25"
                      >
                        <div className="flex flex-col gap-1.5">
                          <label className="flex items-start gap-1.5">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded accent-violet-600"
                              disabled={readOnly}
                              checked={on}
                              onChange={(ev) => toggleShared(key, b.id, ev.target.checked)}
                            />
                            <span
                              className="line-clamp-2 text-[11.5px] font-semibold leading-tight text-zinc-800 dark:text-zinc-100"
                              title={b.name}
                            >
                              {b.name}
                            </span>
                          </label>
                          <span className="inline-flex w-fit items-center gap-0.5 rounded bg-violet-100 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
                            <Users className="h-2 w-2" /> Team · {fmtMoney(perPerson, effectiveCurrency(key, b))}/ea
                          </span>
                          <BonusCurrencyTag bonus={b} fx={fx} />
                          {on && b.kind === 'formula' && vars.length > 0 && (
                            <VarFields
                              vars={vars}
                              values={sh?.vars}
                              onChange={(vn, value) => setSharedVar(key, b.id, vn, value)}
                              disabled={readOnly}
                              ownerLabel={`${b.name} (whole team)`}
                              accent="violet"
                            />
                          )}
                        </div>
                      </th>
                    );
                  })}

                  {hasIndividual && (
                    <th className="sticky top-0 z-[4] min-w-[150px] border-b border-l border-zinc-200/70 bg-zinc-50 px-2.5 py-2 align-bottom dark:border-zinc-800/70 dark:bg-zinc-900/70">
                      <span className="inline-flex items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                        <User className="h-2.5 w-2.5" /> Individual
                      </span>
                    </th>
                  )}

                  <th className="sticky right-0 top-0 z-[6] min-w-[96px] border-b border-l border-zinc-200 bg-zinc-50 px-3 py-2 text-right align-bottom dark:border-zinc-800 dark:bg-[#0f141b]">
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                      Total
                    </span>
                  </th>
                </tr>
              </thead>

              <tbody>
                {pagedMembers.map((m, ri) => {
                  const appl = applicableBonuses(key, m.email);
                  const applSet = new Set(appl.map((b) => b.id));
                  const mIndividual = appl.filter(
                    (b) => !common.some((c) => c.id === b.id) && !sharedSet?.has(b.id),
                  );
                  const mTotal = memberTotal(key, m, d.shared);
                  return (
                    // Opacity-only fade (no transform) so the sticky Member / Total
                    // columns keep sticking; replays as a soft cascade whenever the
                    // visible rows change — a page turn or a search narrowing.
                    <motion.tr
                      key={m.email}
                      initial={reduceMotion ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.24, ease: EASE, delay: Math.min(ri * 0.025, 0.2) }}
                      className="group/row border-b border-zinc-100 last:border-0 hover:bg-emerald-50/40 dark:border-zinc-800/60 dark:hover:bg-emerald-950/10"
                    >
                      {/* Member (sticky) */}
                      <td className="sticky left-0 z-[2] border-r border-zinc-200/80 bg-white px-3 py-2 align-top group-hover/row:bg-emerald-50/40 dark:border-zinc-800 dark:bg-[#11161c] dark:group-hover/row:bg-emerald-950/20">
                        <div className="flex items-center gap-2">
                          <span
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
                            style={{ backgroundColor: hexA(color, 0.16), color }}
                            aria-hidden
                          >
                            {initials(m.name)}
                          </span>
                          <span
                            className="min-w-0 truncate text-[12px] font-medium text-zinc-800 dark:text-zinc-100"
                            title={m.name}
                          >
                            {m.name}
                          </span>
                        </div>
                      </td>

                      {/* Common bonus cells */}
                      {colMeta.map(({ b }) => {
                        const applicable = applSet.has(b.id);
                        const st = m.applied[b.id];
                        const on = !!st?.on;
                        const vars = bonusVariables(b);
                        const amt = applicable && on ? computeNative(b, st?.vars) : 0;
                        return (
                          <td key={b.id} className="border-l border-zinc-100 px-2.5 py-2 align-top dark:border-zinc-800/50">
                            {!applicable ? (
                              <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-700">—</span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                <label className="flex items-center gap-1.5">
                                  <input
                                    type="checkbox"
                                    className="h-3.5 w-3.5 shrink-0 rounded accent-emerald-600"
                                    disabled={readOnly}
                                    checked={on}
                                    onChange={(ev) => toggleBonus(key, m.email, b.id, ev.target.checked)}
                                  />
                                  <span
                                    className={cn(
                                      'font-mono text-[11px] tabular-nums',
                                      amt > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                    )}
                                  >
                                    {on ? fmtMoney(amt, effectiveCurrency(key, b)) : '—'}
                                  </span>
                                </label>
                                {on && b.kind === 'formula' && vars.length > 0 && (
                                  <VarFields
                                    vars={vars}
                                    values={st?.vars}
                                    onChange={(vn, value) => setVar(key, m.email, b.id, vn, value)}
                                    disabled={readOnly}
                                    ownerLabel={`${b.name} — ${m.name}`}
                                    accent="emerald"
                                  />
                                )}
                              </div>
                            )}
                          </td>
                        );
                      })}

                      {/* Team bonus cells (entered once in the header; read-only per person) */}
                      {sharedMeta.map(({ b, on, perPerson }) => {
                        const applicable = applSet.has(b.id);
                        const amt = applicable && on ? perPerson : 0;
                        return (
                          <td
                            key={b.id}
                            className="border-l border-violet-100/70 bg-violet-50/20 px-2.5 py-2 align-top dark:border-violet-900/30 dark:bg-violet-950/10"
                          >
                            {!applicable ? (
                              <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-700">—</span>
                            ) : (
                              <span
                                className={cn(
                                  'font-mono text-[11px] tabular-nums',
                                  amt > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                )}
                              >
                                {on ? fmtMoney(amt, effectiveCurrency(key, b)) : '—'}
                              </span>
                            )}
                          </td>
                        );
                      })}

                      {/* Individual bonuses for this member */}
                      {hasIndividual && (
                        <td className="border-l border-zinc-100 px-2.5 py-2 align-top dark:border-zinc-800/50">
                          {mIndividual.length === 0 ? (
                            <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-700">—</span>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              {mIndividual.map((b) => {
                                const st = m.applied[b.id];
                                const on = !!st?.on;
                                const vars = bonusVariables(b);
                                const amt = on ? computeNative(b, st?.vars) : 0;
                                return (
                                  <div key={b.id} className="flex flex-col gap-0.5">
                                    <label className="flex items-center gap-1.5">
                                      <input
                                        type="checkbox"
                                        className="h-3.5 w-3.5 shrink-0 rounded accent-violet-600"
                                        disabled={readOnly}
                                        checked={on}
                                        onChange={(ev) => toggleBonus(key, m.email, b.id, ev.target.checked)}
                                      />
                                      <span className="min-w-0 truncate text-[11px] text-zinc-600 dark:text-zinc-300" title={b.name}>
                                        {b.name}
                                      </span>
                                      <BonusCurrencyTag bonus={b} fx={fx} />
                                      <span
                                        className={cn(
                                          'ml-auto shrink-0 font-mono text-[11px] tabular-nums',
                                          amt > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                        )}
                                      >
                                        {on ? fmtMoney(amt, effectiveCurrency(key, b)) : '—'}
                                      </span>
                                    </label>
                                    {on && b.kind === 'formula' && vars.length > 0 && (
                                      <VarFields
                                        vars={vars}
                                        values={st?.vars}
                                        onChange={(vn, value) => setVar(key, m.email, b.id, vn, value)}
                                        disabled={readOnly}
                                        ownerLabel={`${b.name} — ${m.name}`}
                                        accent="violet"
                                      />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      )}

                      {/* Member total (sticky) */}
                      <td className="sticky right-0 z-[2] border-l border-zinc-200/80 bg-white px-3 py-2 text-right align-top group-hover/row:bg-emerald-50/40 dark:border-zinc-800 dark:bg-[#11161c] dark:group-hover/row:bg-emerald-950/20">
                        <span
                          className={cn(
                            'font-mono text-[12px] font-bold tabular-nums',
                            moneyPositive(mTotal) ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                          )}
                        >
                          {fmtTotals(mTotal)}
                        </span>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>

              {/* Footer: per-column subtotals + dept grand total */}
              <tfoot>
                <tr>
                  <td className="sticky bottom-0 left-0 z-[5] border-r border-t border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-[#0f141b]">
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                      Totals
                    </span>
                  </td>
                  {colMeta.map(({ b, subtotal, onCount }) => (
                    <td key={b.id} className="sticky bottom-0 z-[3] border-l border-t border-zinc-200/70 bg-zinc-100 px-2.5 py-2 dark:border-zinc-800/70 dark:bg-[#10151c]">
                      <div className="flex flex-col">
                        <span
                          className={cn(
                            'font-mono text-[11px] font-semibold tabular-nums',
                            subtotal > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                          )}
                        >
                          {fmtMoney(subtotal, effectiveCurrency(key, b))}
                        </span>
                        <span className="font-mono text-[9px] text-zinc-400">{onCount} applied</span>
                      </div>
                    </td>
                  ))}
                  {sharedMeta.map(({ b, subtotal }) => (
                    <td key={b.id} className="sticky bottom-0 z-[3] border-l border-t border-violet-200/60 bg-violet-100 px-2.5 py-2 dark:border-violet-900/40 dark:bg-violet-950/50">
                      <span
                        className={cn(
                          'font-mono text-[11px] font-semibold tabular-nums',
                          subtotal > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                        )}
                      >
                        {fmtMoney(subtotal, effectiveCurrency(key, b))}
                      </span>
                    </td>
                  ))}
                  {hasIndividual && (
                    <td className="sticky bottom-0 z-[3] border-l border-t border-zinc-200/70 bg-zinc-100 px-2.5 py-2 dark:border-zinc-800/70 dark:bg-[#10151c]">
                      <span
                        className={cn(
                          'font-mono text-[11px] font-semibold tabular-nums',
                          moneyPositive(indivSubtotal) ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                        )}
                      >
                        {fmtTotals(indivSubtotal)}
                      </span>
                    </td>
                  )}
                  <td className="sticky bottom-0 right-0 z-[5] border-l border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-right dark:border-zinc-800 dark:bg-[#0f141b]">
                    <span className="font-mono text-[12px] font-extrabold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {fmtTotals(total)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
          </motion.div>
          </AnimatePresence>
          </div>
        </div>

        {/* Pager: only for paginated depts (Lead Gen) with more than one page */}
        {paginated && (
          <div className="flex flex-none items-center justify-between gap-3 border-t border-zinc-100 px-4 py-2 dark:border-zinc-800/70 sm:px-5">
            <span className="font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
              {page * pageSize + 1}–{Math.min(members.length, (page + 1) * pageSize)} of {members.length}
            </span>
            <div className="flex items-center gap-1.5">
              <PanelIconButton
                label="Previous page"
                disabled={page <= 0}
                onClick={() => setLeadGenPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </PanelIconButton>
              <span className="min-w-[5.5rem] text-center font-mono text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">
                Page {page + 1} / {pageCount}
              </span>
              <PanelIconButton
                label="Next page"
                disabled={page >= pageCount - 1}
                onClick={() => setLeadGenPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </PanelIconButton>
            </div>
          </div>
        )}

        {/* Footer: department subtotal + actions */}
        <div className="flex flex-none items-center justify-between gap-4 border-t border-zinc-200/80 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-[#0b0e15] sm:px-5">
          <div className="min-w-0">
            <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-zinc-400">Department subtotal</div>
            <div className="tabular-nums font-mono text-2xl font-bold leading-tight text-emerald-600 dark:text-emerald-400">
              {fmtTotals(total)}
            </div>
            <div
              className={cn(
                'mt-0.5 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide',
                statusReadOnly || editLocked
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : d?.dirty
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-zinc-400',
              )}
            >
              {isQc ? (
                qcLocked ? (
                  <>
                    <Lock className="h-2.5 w-2.5" /> Locked · sent to manager
                  </>
                ) : d?.dirty ? (
                  'Unsaved changes'
                ) : (
                  'Saved · lock to send'
                )
              ) : statusReadOnly ? (
                'Sent to Accounting'
              ) : editLocked ? (
                <>
                  <Lock className="h-2.5 w-2.5" /> Locked · ready to submit
                </>
              ) : d?.dirty ? (
                'Unsaved changes'
              ) : (
                'Saved · lock to submit'
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isQc ? (
              qcLocked ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 gap-1.5 text-xs"
                  onClick={() => void qcReopen()}
                >
                  <Unlock className="h-3.5 w-3.5" /> Reopen
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="outline" className="h-9 gap-1.5 text-xs" disabled={d?.saving} onClick={() => void saveDept(key)}>
                    <Save className="h-3.5 w-3.5" /> {d?.saving ? 'Saving…' : 'Save'}
                  </Button>
                  <motion.div whileTap={reduceMotion ? undefined : { scale: 0.96 }}>
                    <Button
                      size="sm"
                      className="h-9 gap-1.5 bg-orange-600 text-xs text-white hover:bg-orange-700 disabled:opacity-60"
                      disabled={d?.saving}
                      onClick={() => void qcLockPeriod()}
                      title="Lock all your assigned members for the week and send to the manager"
                    >
                      <Lock className="h-3.5 w-3.5" /> Lock &amp; send to manager
                    </Button>
                  </motion.div>
                </>
              )
            ) : statusReadOnly ? (
              <Button
                size="sm"
                variant="outline"
                className="h-9 gap-1.5 text-xs"
                onClick={() => {
                  unlockValues(key);
                  void setStatus(key, 'draft');
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Reopen
              </Button>
            ) : editLocked ? (
              <>
                <Button size="sm" variant="outline" className="h-9 gap-1.5 text-xs" onClick={() => unlockValues(key)}>
                  <Unlock className="h-3.5 w-3.5" /> Unlock
                </Button>
                <motion.div whileTap={reduceMotion ? undefined : { scale: 0.96 }}>
                  <Button
                    size="sm"
                    className="h-9 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
                    onClick={() => void submitToPayroll(key)}
                    title={toFill > 0 ? `${toFill} ${toFill === 1 ? 'person has' : 'people have'} a formula bonus still to fill` : undefined}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> Submit to Payroll
                  </Button>
                </motion.div>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" className="h-9 gap-1.5 text-xs" disabled={d?.saving} onClick={() => void saveDept(key)}>
                  <Save className="h-3.5 w-3.5" /> {d?.saving ? 'Saving…' : 'Save draft'}
                </Button>
                <motion.div whileTap={reduceMotion ? undefined : { scale: 0.96 }}>
                  <Button
                    size="sm"
                    className="h-9 gap-1.5 bg-zinc-900 text-xs text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    disabled={d?.saving || !hasAnyBonus || allMembers.length === 0}
                    onClick={() => void lockValues(key)}
                    title="Lock these values to enable Submit to Payroll"
                  >
                    <Lock className="h-3.5 w-3.5" /> {d?.saving ? 'Saving…' : 'Lock values'}
                  </Button>
                </motion.div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Crossfade the open department's panel when the manager moves between
  // departments (the header arrows or the focus-mode rail) so the swap reads as
  // a page turn rather than a hard cut. `mode="wait"` keeps only one panel
  // mounted at a time; `initial={false}` skips the fade on the first open (the
  // overlay's own entrance covers that) and only animates subsequent switches.
  // Opacity-only — never a transform — so the table's sticky columns survive.
  const renderAnimatedPanel = (key: string) => (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={key}
        className="flex h-full min-h-0 w-full flex-col"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: EASE }}
      >
        {renderPanel(key)}
      </motion.div>
    </AnimatePresence>
  );

  // The side panel never goes below the original 880px base, and extends wider
  // for column-heavy departments. The responsive max-width on the panel still
  // caps it so its left edge never slides over the HRIS sidebar (220px) behind.
  const openColCount = (() => {
    if (!openId) return 0;
    const common = commonByDept.get(openId) ?? []; // normal + team-effort columns
    const hasIndiv = (individualByDept.get(openId)?.size ?? 0) > 0;
    return common.length + (hasIndiv ? 1 : 0);
  })();
  const drawerWidthPx = Math.min(1500, Math.max(880, 280 + openColCount * 150));

  // -- Overlay (drawer / focus), portalled to escape transformed ancestors -------

  const overlay =
    mounted
      ? createPortal(
          // Always-mounted portal so AnimatePresence can play the exit
          // animation before the overlay leaves the tree.
          <AnimatePresence>
            {openId && (
              <motion.button
                key="kpi-scrim"
                type="button"
                aria-label="Close calculator"
                onClick={close}
                className="fixed inset-0 z-[60] cursor-default bg-zinc-950/55 dark:bg-black/70"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.42, ease: EASE }}
              />
            )}
            {openId &&
              (mode === 'focus' ? (
                <motion.div
                  key="kpi-focus"
                  ref={panelRef}
                  tabIndex={-1}
                  role="dialog"
                  aria-modal="true"
                  aria-label={`${DEPARTMENTS.find((d) => d.key === openId)?.name ?? openId} KPI calculator`}
                  className="fixed inset-0 z-[61] flex bg-white outline-none dark:bg-[#0b0e15]"
                  initial={reduceMotion ? false : { opacity: 0, scale: 1.012 }}
                  animate={{ opacity: 1, scale: 1, x: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { x: '100%' }}
                  transition={{ duration: 0.55, ease: EASE }}
                >
                    {/* Department rail */}
                    <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200/80 bg-zinc-50/60 dark:border-zinc-800 dark:bg-[#0a0d13] md:flex">
                      <div className="flex-none border-b border-zinc-200/80 px-4 py-3.5 dark:border-zinc-800">
                        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-400">KPI Calculator</p>
                        <p className="mt-0.5 text-sm font-bold text-zinc-900 dark:text-zinc-100">Departments</p>
                      </div>
                      <div className="min-h-0 flex-1 overflow-auto p-2">
                        {visibleDeptKeys.map((k) => {
                          const st = state[k];
                          const on = k === openId;
                          const c = deptColor(k);
                          const sub = deptTotal(k, st);
                          const ready = st?.status === 'ready' || st?.status === 'locked';
                          return (
                            <button
                              key={k}
                              type="button"
                              onClick={() => open(k)}
                              className={cn(
                                'mb-1 flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
                                on
                                  ? 'border-zinc-300 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900'
                                  : 'border-transparent hover:bg-white/70 dark:hover:bg-zinc-900/50',
                              )}
                            >
                              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: c }} aria-hidden />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12.5px] font-medium text-zinc-800 dark:text-zinc-100">
                                  {DEPARTMENTS.find((d) => d.key === k)?.name ?? k}
                                </span>
                                <span className="block font-mono text-[10px] text-zinc-400">{fmtTotals(sub)}</span>
                              </span>
                              {ready ? (
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
                              ) : closingSoon ? (
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </aside>

                    <div className="min-w-0 flex-1" style={{ borderTop: `3px solid ${deptColor(openId)}` }}>
                      {renderAnimatedPanel(openId)}
                    </div>
                  </motion.div>
              ) : mode === 'modal' ? (
                <motion.div
                  key="kpi-modal"
                  ref={panelRef}
                  tabIndex={-1}
                  role="dialog"
                  aria-modal="true"
                  aria-label={`${DEPARTMENTS.find((d) => d.key === openId)?.name ?? openId} KPI calculator`}
                  className="fixed left-1/2 top-1/2 z-[61] flex h-[88vh] max-h-[860px] w-[min(1120px,94vw)] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none dark:border-zinc-800 dark:bg-[#0b0e15]"
                  style={{ borderTop: `3px solid ${deptColor(openId)}` }}
                  initial={reduceMotion ? false : { x: '-50%', y: '-48%', scale: 0.96, opacity: 0 }}
                  animate={{ x: '-50%', y: '-50%', scale: 1, opacity: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { x: '-50%', y: '-48%', scale: 0.97, opacity: 0 }}
                  transition={{ duration: 0.48, ease: EASE }}
                >
                  {renderAnimatedPanel(openId)}
                </motion.div>
              ) : (
                <motion.div
                  key="kpi-drawer"
                  ref={panelRef}
                  tabIndex={-1}
                  role="dialog"
                  aria-modal="true"
                  aria-label={`${DEPARTMENTS.find((d) => d.key === openId)?.name ?? openId} KPI calculator`}
                  className="fixed inset-y-0 right-0 z-[61] flex max-w-[calc(100vw_-_1.5rem)] flex-col shadow-2xl outline-none md:max-w-[calc(100vw_-_220px_-_1.5rem)]"
                  style={{ width: `${drawerWidthPx}px`, borderTop: `3px solid ${deptColor(openId)}` }}
                  initial={reduceMotion ? false : { x: '100%' }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { x: '100%' }}
                  transition={{ type: 'tween', duration: 0.52, ease: EASE }}
                >
                  {renderAnimatedPanel(openId)}
                </motion.div>
              ))}
          </AnimatePresence>,
          document.body,
        )
      : null;

  // -- Submit confirmation (centered modal), portalled above the overlay --------

  const submitOverlay = mounted
    ? createPortal(
        <AnimatePresence>
          {submit && (
            <SubmitModal
              key="kpi-submit-modal"
              kind={submit.kind}
              phase={submit.phase}
              deptName={DEPARTMENTS.find((d) => d.key === submit.key)?.name ?? submit.key}
              msg={submit.msg}
              reduce={!!reduceMotion}
              qc={isQc}
              onClose={() => submit.phase !== 'sending' && setSubmit(null)}
              onRetry={() => void (submit.kind === 'lock' ? lockValues(submit.key) : isQc ? qcLockPeriod() : submitToPayroll(submit.key))}
            />
          )}
        </AnimatePresence>,
        document.body,
      )
    : null;

  // -- Landing -------------------------------------------------------------------

  if (!ready) {
    return (
      <KpiCalculatorLoading
        variant="departments"
        title={
          isElevated
            ? 'All Departments'
            : visibleDeptKeys.length === 1
              ? (DEPARTMENTS.find((d) => d.key === visibleDeptKeys[0])?.name ?? 'Department')
              : 'My Departments'
        }
        cards={Math.max(visibleDeptKeys.length, isElevated ? 6 : 1)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      {/* Header + controls */}
      <div className="sticky top-0 z-10 border-b border-zinc-200/80 bg-white/85 px-4 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-[#0d1117]/85 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400 dark:text-zinc-500">
              KPI Calculator &middot; Departments
            </p>
            <h2 className="mt-0.5 text-[18px] font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              {isElevated
                ? 'All Departments'
                : visibleDeptKeys.length === 1
                  ? DEPARTMENTS.find((d) => d.key === visibleDeptKeys[0])?.name
                  : 'My Departments'}
            </h2>
            <div className="mt-2">
              <WeekPicker
                value={weekStart}
                weekEnd={weekEnd}
                options={weekOptions}
                currentWeekStart={currentWeekStart}
                onChange={selectWeek}
              />
            </div>
          </div>
          <div className="flex items-stretch gap-2.5">
            <motion.div
              className="flex flex-col justify-center rounded-xl border border-emerald-200/80 bg-gradient-to-b from-emerald-50 to-white px-3.5 py-2 text-right dark:border-emerald-900/40 dark:from-emerald-950/30 dark:to-transparent"
              initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: EASE }}
            >
              <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-emerald-600/80 dark:text-emerald-400/80">
                Projected · week
              </div>
              <div className="tabular-nums font-mono text-xl font-bold leading-none text-emerald-700 dark:text-emerald-300">
                {fmtTotals(grandTotal)}
              </div>
            </motion.div>
            <div className="flex flex-col justify-center rounded-xl border border-zinc-200 bg-zinc-50/80 px-3.5 py-2 text-right dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-400">Headcount</div>
              <div className="flex items-center justify-end gap-1 text-zinc-700 dark:text-zinc-200">
                <Users className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                <span className="tabular-nums font-mono text-xl font-bold leading-none">{totalPeople}</span>
              </div>
            </div>
          </div>
        </div>

        {isLiveWeek ? (
          <DeadlineBanner
            weekStart={weekStart}
            weekEnd={weekEnd}
            daysLeft={daysLeft}
            overdue={overdue}
            readyCount={readyCount}
            total={totalDepts}
          />
        ) : (
          <PastWeekBanner
            weekStart={weekStart}
            weekEnd={weekEnd}
            liveWeekStart={currentWeekStart}
            liveWeekEnd={currentWeekStart ? weekEndFromStart(currentWeekStart) : ''}
            onJumpToLive={() => currentWeekStart && selectWeek(currentWeekStart)}
          />
        )}

        {/* Calculators toolbar: search + open-as toggle */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400 sm:inline">
              Department calculators
            </span>
            {visibleDeptKeys.length > 1 && (
              <div className="relative min-w-0 max-w-[260px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                <input
                  type="search"
                  value={deptSearch}
                  onChange={(e) => setDeptSearch(e.target.value)}
                  placeholder="Search departments…"
                  className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs text-zinc-900 outline-none transition-colors focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100"
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void manualRefresh()}
              disabled={refreshing}
              title="Reload bonuses (also updates live as other scorers edit)"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Open as</span>
            <ViewSwitch mode={mode} onChange={setMode} />
          </div>
        </div>
      </div>

      {/* Department cards */}
      <motion.div
        className={cn(
          'relative grid gap-3.5 px-4 py-4 sm:px-6',
          // QC mode keeps the calculator cards left-aligned (a focused work
          // surface); the manager landing centers a lone card as before.
          filteredDeptKeys.length <= 1
            ? isQc
              ? 'mr-auto w-full max-w-3xl grid-cols-1'
              : 'mx-auto w-full max-w-3xl grid-cols-1'
            : 'grid-cols-1 lg:grid-cols-2',
        )}
        initial={reduceMotion ? false : 'hidden'}
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } } }}
      >
        {/* popLayout pops a filtered-out card from flow so the rest glide into
            their new positions; each card's `layout` prop drives that reflow as
            the search narrows or clears. */}
        <AnimatePresence mode="popLayout">
          {filteredDeptKeys.map((key) => {
            const v = buildDeptView(key);
            return (
              <DeptSummaryCard
                key={key}
                name={v.dept?.name ?? key}
                desc={DEPT_DESCRIPTION[key] ?? ''}
                color={v.color}
                monogram={deptAbbrevByKey[key] ?? initials(v.dept?.name ?? key)}
                headcount={v.allMembers.length}
                entered={v.entered}
                status={v.d?.status ?? 'draft'}
                warn={closingSoon && !v.readOnly}
                dirty={!!v.d?.dirty}
                projected={v.total}
                toFill={v.toFill}
                hasAnyBonus={v.hasAnyBonus}
                loading={!v.d?.loaded}
                isOpen={openId === key}
                reduce={!!reduceMotion}
                onOpen={() => open(key)}
              />
            );
          })}
        </AnimatePresence>
      </motion.div>

      {filteredDeptKeys.length === 0 && (
        <div className="mx-4 mb-6 rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-400 dark:border-zinc-700 sm:mx-6">
          No departments match “{deptSearch}”.
        </div>
      )}

      {overlay}
      {submitOverlay}
    </div>
  );
}

// -- Bits -----------------------------------------------------------------------

/** At-a-glance "is everyone scored?" gauge. A ring fills to entered / total and
 *  the core flips between three states: a check once every member in the
 *  department has at least one KPI applied, an amber warning when someone's
 *  applied bonus is still missing a required input, or the running count while
 *  it's being filled in. The big variant anchors the open panel's toolbar; the
 *  small one rides each landing card so a manager can sweep the grid and spot
 *  which departments are fully scored. The ring animates via stroke-dashoffset
 *  (never a transform) so it stays safe beside the table's sticky columns. */
function CompletionGauge({
  entered,
  total,
  toFill,
  size = 'lg',
  reduce,
}: {
  entered: number;
  total: number;
  toFill: number;
  size?: 'lg' | 'sm';
  reduce?: boolean;
}) {
  const lg = size === 'lg';
  const pct = total > 0 ? Math.min(1, entered / total) : 0;
  const allIn = total > 0 && entered >= total;
  const complete = allIn && toFill === 0;
  const tone: 'emerald' | 'amber' | 'sky' | 'zinc' = complete
    ? 'emerald'
    : toFill > 0
      ? 'amber'
      : entered > 0
        ? 'sky'
        : 'zinc';
  const palette = {
    emerald: { ring: '#10b981', track: 'rgba(16,185,129,0.16)', text: 'text-emerald-600 dark:text-emerald-400' },
    amber: { ring: '#f59e0b', track: 'rgba(245,158,11,0.18)', text: 'text-amber-600 dark:text-amber-400' },
    sky: { ring: '#0ea5e9', track: 'rgba(14,165,233,0.16)', text: 'text-sky-600 dark:text-sky-400' },
    zinc: { ring: '#a1a1aa', track: 'rgba(161,161,170,0.20)', text: 'text-zinc-400' },
  }[tone];
  const dim = lg ? 48 : 28;
  const stroke = lg ? 5 : 3.25;
  const r = (dim - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const title = complete
    ? `All ${total} ${total === 1 ? 'person' : 'people'} scored`
    : `${entered} of ${total} scored${toFill > 0 ? ` · ${toFill} still to fill` : ''}`;

  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="relative shrink-0" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} className="-rotate-90" aria-hidden>
          <circle cx={dim / 2} cy={dim / 2} r={r} fill="none" stroke={palette.track} strokeWidth={stroke} />
          <motion.circle
            cx={dim / 2}
            cy={dim / 2}
            r={r}
            fill="none"
            stroke={palette.ring}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circ}
            initial={reduce ? false : { strokeDashoffset: circ }}
            animate={{ strokeDashoffset: circ * (1 - pct) }}
            transition={{ duration: 0.65, ease: EASE }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center">
          {complete ? (
            <Check className={cn(lg ? 'h-5 w-5' : 'h-3.5 w-3.5', palette.text)} strokeWidth={3} aria-hidden />
          ) : allIn && toFill > 0 ? (
            <AlertTriangle className={cn(lg ? 'h-4 w-4' : 'h-3 w-3', palette.text)} aria-hidden />
          ) : (
            <span className={cn('font-mono font-bold tabular-nums', lg ? 'text-[11px]' : 'text-[8.5px]', palette.text)}>
              {entered}
              <span className="opacity-50">/{total}</span>
            </span>
          )}
        </span>
      </div>
      <div className="leading-tight">
        <div className={cn('font-mono font-semibold', lg ? 'text-[12px]' : 'text-[10.5px]', palette.text)}>
          {complete ? 'All scored' : toFill > 0 ? `${toFill} to fill` : `${entered}/${total} scored`}
        </div>
        {lg && (
          <div className="font-mono text-[9px] uppercase tracking-wide text-zinc-400">
            {complete ? 'every member has a KPI' : 'employees entered'}
          </div>
        )}
      </div>
    </div>
  );
}

/** Landing card: a department's at-a-glance summary. Opens the calculator. */
function DeptSummaryCard({
  name,
  desc,
  color,
  monogram,
  headcount,
  entered,
  status,
  warn,
  dirty,
  projected,
  toFill,
  hasAnyBonus,
  loading,
  isOpen,
  reduce,
  onOpen,
}: {
  name: string;
  desc: string;
  color: string;
  monogram: string;
  headcount: number;
  entered: number;
  status: BonusStatus;
  warn: boolean;
  dirty: boolean;
  projected: Money;
  toFill: number;
  hasAnyBonus: boolean;
  loading: boolean;
  isOpen: boolean;
  reduce: boolean;
  onOpen: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      layout="position"
      variants={{
        hidden: { opacity: 0, y: 8, scale: 0.98 },
        show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.32, ease: EASE } },
      }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95, transition: { duration: 0.18, ease: EASE } }}
      whileHover={reduce ? undefined : { y: -3 }}
      whileTap={reduce ? undefined : { scale: 0.995 }}
      className={cn(
        'group relative flex items-center gap-3.5 overflow-hidden rounded-2xl border bg-white p-3.5 text-left shadow-sm transition-shadow hover:shadow-lg dark:bg-zinc-900/40',
        isOpen ? 'border-transparent' : 'border-zinc-200/90 dark:border-zinc-800',
      )}
      style={isOpen ? { boxShadow: `0 0 0 2px ${color}` } : undefined}
    >
      <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: color }} aria-hidden />

      {/* Abbreviation tile */}
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl ring-1 ring-black/5 dark:ring-white/10">
        <div
          className="absolute inset-0 flex items-center justify-center font-mono text-lg font-bold"
          style={{ backgroundColor: hexA(color, 0.14), color }}
          aria-hidden
        >
          {monogram}
        </div>
        <div className="absolute bottom-1 left-1 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-white/90 backdrop-blur-sm">
          <Users className="h-2.5 w-2.5" aria-hidden />
          {loading ? (
            <Skeleton className="h-2 w-3.5 bg-white/40 dark:bg-white/40" />
          ) : (
            <span className="tabular-nums font-mono text-[10px]">{headcount}</span>
          )}
        </div>
      </div>

      {/* Identity + status */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{name}</span>
          <HeroBadge status={status} warn={warn} />
          {dirty && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
              title="Unsaved changes"
              aria-hidden
            />
          )}
        </div>
        <p className="mt-0.5 line-clamp-1 text-[12px] leading-snug text-zinc-500 dark:text-zinc-400">{desc}</p>
        {hasAnyBonus && headcount > 0 && !loading && (
          <div className="mt-1.5">
            <CompletionGauge entered={entered} total={headcount} toFill={toFill} size="sm" reduce={reduce} />
          </div>
        )}
      </div>

      {/* Projected + open affordance */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="text-right">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-zinc-400">Projected</div>
          {loading ? (
            <Skeleton className="ml-auto mt-1 h-4 w-16" />
          ) : (
            <div className="tabular-nums font-mono text-base font-bold leading-none text-emerald-600 dark:text-emerald-400">
              {fmtTotals(projected)}
            </div>
          )}
        </div>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-400 transition-colors group-hover:border-zinc-300 group-hover:text-zinc-600 dark:border-zinc-700 dark:group-hover:border-zinc-600 dark:group-hover:text-zinc-300">
          <ChevronRight className="h-4 w-4" aria-hidden />
        </span>
      </div>
    </motion.button>
  );
}

/** Labeled numeric inputs for a formula bonus's variables. One tidy field per
 *  variable (uppercase label over a centered number box), wrapping neatly. The
 *  whole group reveals when its bonus is ticked on; each input has an animated
 *  focus ring, selects its contents on focus, and an empty required value gets
 *  an amber cue so it's obvious what's still "to fill". `accent` matches the
 *  column's identity (emerald for common, violet for team / individual). */
function VarFields({
  vars,
  values,
  onChange,
  disabled,
  ownerLabel,
  accent = 'emerald',
}: {
  vars: string[];
  values: Record<string, string> | undefined;
  onChange: (varName: string, value: string) => void;
  disabled?: boolean;
  ownerLabel: string;
  accent?: 'emerald' | 'violet';
}) {
  const reduce = useReducedMotion();
  const ring =
    accent === 'violet'
      ? 'focus:border-violet-400 focus:ring-violet-300/45 dark:focus:border-violet-500 dark:focus:ring-violet-500/30'
      : 'focus:border-emerald-400 focus:ring-emerald-300/45 dark:focus:border-emerald-500 dark:focus:ring-emerald-500/30';
  return (
    <motion.div
      className="flex flex-wrap gap-x-2 gap-y-1.5 pt-1"
      initial={reduce ? false : { opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE }}
    >
      {vars.map((vn) => {
        const v = values?.[vn] ?? '';
        const empty = !String(v).trim();
        return (
          <label key={vn} className="group/field flex flex-col gap-0.5">
            <span className="pl-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-wider text-zinc-500 transition-colors group-focus-within/field:text-zinc-800 dark:text-zinc-400 dark:group-focus-within/field:text-zinc-100">
              {vn}
            </span>
            <input
              type="number"
              inputMode="decimal"
              aria-label={`${vn} — ${ownerLabel}`}
              disabled={disabled}
              value={v}
              placeholder="0"
              onChange={(e) => onChange(vn, e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              className={cn(
                'h-7 w-[64px] rounded-md border bg-white px-1.5 text-center text-[11.5px] tabular-nums text-zinc-900 outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-zinc-300 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-900/70 dark:text-zinc-100 dark:placeholder:text-zinc-700',
                ring,
                empty && !disabled
                  ? 'border-amber-300/80 dark:border-amber-700/50'
                  : 'border-zinc-200 dark:border-zinc-700',
              )}
            />
          </label>
        );
      })}
    </motion.div>
  );
}

/** Shimmer placeholder that mirrors the per-person table while a department's
 *  saved values load. The column count comes from the already-loaded catalog,
 *  so the skeleton lines up with the real grid that replaces it (no layout
 *  shift). A small per-element animation delay gives the pulse a gentle wave. */
function DeptTableSkeleton({ rows, cols }: { rows: number; cols: number }) {
  const nameW = [124, 96, 142, 108, 88, 132, 100, 116, 92, 120];
  return (
    <div className="px-3 py-2.5 sm:px-4" aria-busy="true" aria-label="Loading values">
      {/* Column header strip */}
      <div className="mb-1 flex items-center gap-3 border-b border-zinc-100 px-1 pb-3 dark:border-zinc-800/60">
        <Skeleton className="h-2.5 w-14" />
        <div className="ml-auto flex items-center gap-5">
          {Array.from({ length: Math.max(0, cols) }).map((_, i) => (
            <Skeleton key={i} className="h-2.5 w-16" />
          ))}
          <Skeleton className="h-2.5 w-12" />
        </div>
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-3 border-b border-zinc-50 py-3 last:border-0 dark:border-zinc-800/40"
        >
          <Skeleton className="h-6 w-6 shrink-0 rounded-full" style={{ animationDelay: `${r * 70}ms` }} />
          <Skeleton className="h-3.5 shrink-0" style={{ width: nameW[r % nameW.length], animationDelay: `${r * 70}ms` }} />
          <div className="ml-auto flex items-center gap-5">
            {Array.from({ length: Math.max(0, cols) }).map((_, c) => (
              <Skeleton key={c} className="h-4 w-14" style={{ animationDelay: `${r * 70 + c * 45}ms` }} />
            ))}
            <Skeleton className="h-4 w-16" style={{ animationDelay: `${r * 70 + cols * 45}ms` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Centered loading/confirmation modal for the two committing actions: locking
 *  a department's values, and submitting them to payroll. Blurs and dims the
 *  calculator behind it so the focus is the modal. Shows a live "sending" state,
 *  then a success (or error) confirmation, instead of a fire-and-forget toast.
 *  Owns its own Escape/scrim close once it's past sending. Portalled by parent. */
function SubmitModal({
  kind,
  phase,
  deptName,
  msg,
  onClose,
  onRetry,
  reduce,
  qc = false,
}: {
  kind: 'lock' | 'submit';
  phase: 'sending' | 'done' | 'error';
  deptName: string;
  msg?: string;
  onClose: () => void;
  onRetry: () => void;
  reduce: boolean;
  /** QC officer mode: the "submit" action locks + sends to the manager, not payroll. */
  qc?: boolean;
}) {
  useEffect(() => {
    if (phase === 'sending') return; // can't dismiss mid-action
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  const dept = <span className="font-semibold text-zinc-700 dark:text-zinc-300">{deptName}</span>;
  const copy = {
    sendingTitle: kind === 'lock' ? 'Locking values…' : qc ? 'Sending to manager…' : 'Sending to Payroll…',
    sendingBody:
      kind === 'lock' ? (
        <>Freezing {dept}&rsquo;s values so they&rsquo;re ready to submit.</>
      ) : qc ? (
        <>Locking your assigned members and notifying the manager to review. Please keep this window open.</>
      ) : (
        <>Submitting {dept}&rsquo;s values to Accounting. Please keep this window open.</>
      ),
    doneTitle: kind === 'lock' ? 'Values locked' : qc ? 'Sent to manager' : 'Submitted to Payroll',
    doneBody:
      kind === 'lock' ? (
        <>{dept} is locked. Submit to Payroll when you&rsquo;re ready.</>
      ) : qc ? (
        <>Locked. The manager has been notified to review your scores.</>
      ) : (
        <>{dept} is ready. Accounting can see it in the Payroll Wizard.</>
      ),
    errorTitle: kind === 'lock' ? 'Couldn’t lock' : 'Couldn’t submit',
  };
  const DoneIcon = kind === 'lock' ? Lock : Check;

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label={kind === 'lock' ? 'Lock values' : 'Submit to payroll'}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.24, ease: EASE }}
    >
      {/* Scrim blurs + dims the calculator so the modal is the only focus. */}
      <button
        type="button"
        aria-label="Close"
        disabled={phase === 'sending'}
        onClick={phase === 'sending' ? undefined : onClose}
        className="absolute inset-0 cursor-default bg-zinc-950/45 backdrop-blur-md disabled:cursor-default dark:bg-black/65"
      />
      <motion.div
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-[#0e1117]"
        initial={reduce ? false : { opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 4 }}
        transition={{ duration: 0.32, ease: EASE }}
      >
        <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
          {phase === 'sending' && (
            <>
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-950/40">
                <Loader2 className="h-7 w-7 animate-spin text-emerald-600 dark:text-emerald-400" aria-hidden />
              </span>
              <div className="text-base font-bold text-zinc-900 dark:text-zinc-100">{copy.sendingTitle}</div>
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{copy.sendingBody}</p>
            </>
          )}
          {phase === 'done' && (
            <>
              <motion.span
                className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950/50"
                initial={reduce ? false : { scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 320, damping: 18 }}
              >
                <DoneIcon className="h-7 w-7 text-emerald-600 dark:text-emerald-400" strokeWidth={kind === 'lock' ? 2.5 : 3} aria-hidden />
              </motion.span>
              <div className="text-base font-bold text-zinc-900 dark:text-zinc-100">{copy.doneTitle}</div>
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{copy.doneBody}</p>
              <Button size="sm" className="mt-1 h-8 bg-emerald-600 text-xs text-white hover:bg-emerald-700" onClick={onClose}>
                Done
              </Button>
            </>
          )}
          {phase === 'error' && (
            <>
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/50">
                <AlertTriangle className="h-7 w-7 text-red-600 dark:text-red-400" aria-hidden />
              </span>
              <div className="text-base font-bold text-zinc-900 dark:text-zinc-100">{copy.errorTitle}</div>
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{msg ?? 'Something went wrong.'}</p>
              <div className="mt-1 flex gap-2">
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onClose}>
                  Close
                </Button>
                <Button size="sm" className="h-8 bg-emerald-600 text-xs text-white hover:bg-emerald-700" onClick={onRetry}>
                  Try again
                </Button>
              </div>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/** The three ways the calculator can open, shared by the landing "Open as"
 *  toggle and the in-panel switcher so a manager can move between them from
 *  any view. */
const VIEW_MODES: { mode: OpenMode; label: string; Icon: typeof PanelRight }[] = [
  { mode: 'drawer', label: 'Side panel', Icon: PanelRight },
  { mode: 'modal', label: 'Modal', Icon: AppWindow },
  { mode: 'focus', label: 'Full screen', Icon: Maximize2 },
];

/** Segmented control to switch between Side panel / Modal / Full screen.
 *  `compact` drops the labels (used in the tight in-panel header). */
function ViewSwitch({ mode, onChange, compact }: { mode: OpenMode; onChange: (m: OpenMode) => void; compact?: boolean }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60">
      {VIEW_MODES.map(({ mode: m, label, Icon }) => {
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
              'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
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

/** Small ghost icon button used in the calculator panel header. */
function PanelIconButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:disabled:hover:bg-zinc-900/60 dark:disabled:hover:text-zinc-400"
    >
      {children}
    </button>
  );
}

/** Sky chip flagging a non-PHP (USD/COP) bonus. For a flat bonus it shows the
 *  native amount (e.g. "$X" / "COP$X"); for a formula it shows the currency code
 *  (the result varies with inputs). The peso figures in the grid are the
 *  FX-converted amounts that get paid; this chip explains why a "$50" bonus
 *  appears as a peso total. Renders nothing for PHP bonuses so the common case
 *  stays uncluttered. */
function BonusCurrencyTag({ bonus, fx }: { bonus: BonusDef; fx: FxRates }) {
  const currency = bonus.currency ?? 'PHP';
  if (currency === 'PHP') return null;
  const sym = CURRENCY_SYMBOL[currency] ?? '';
  const digits = currency === 'COP' ? 0 : 2;
  const label =
    bonus.kind === 'flat'
      ? `${sym}${nativeFlatAmount(bonus).toLocaleString(CURRENCY_LOCALE[currency] ?? 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
      : currency;
  const phpEquiv = phpPerUnit(currency, fx);
  return (
    <span
      className="inline-flex w-fit items-center gap-0.5 rounded bg-sky-100 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"
      title={`${currency} bonus — paid in PHP, converted at ${PESO}${phpEquiv.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 5 })}/${sym}1`}
    >
      {label}
    </span>
  );
}

/** Compact flat/formula indicator for a bonus column header. */
function KindDot({ kind }: { kind: BonusDef['kind'] }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide',
        kind === 'flat'
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
          : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
      )}
      title={kind === 'flat' ? 'Flat amount' : 'Formula bonus'}
    >
      {kind === 'flat' ? 'flat' : 'ƒ(x)'}
    </span>
  );
}

/** "Live" pulse pill — marks the week accounting is currently dispatching. */
function LiveBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      Live
    </span>
  );
}

/** Format a Mon–Sun week as "Jun 9 – Jun 15". */
function fmtWeek(startIso: string, endIso: string): string {
  if (!startIso) return '—';
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const s = new Date(sy!, sm! - 1, sd!);
  const sL = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (!endIso) return `${sL}, ${sy}`;
  const [ey, em, ed] = endIso.split('-').map(Number);
  const e = new Date(ey!, em! - 1, ed!);
  const eL = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${sL} – ${eL}`;
}

/**
 * Week navigator: prev/next arrows step through uploaded Hubstaff weeks and a
 * dropdown lists them all, marking the live (currently-dispatched) week and
 * offering a one-tap jump back to it.
 */
function WeekPicker({
  value,
  weekEnd,
  options,
  currentWeekStart,
  onChange,
}: {
  value: string;
  weekEnd: string;
  options: { start: string; end: string }[];
  currentWeekStart: string | null;
  onChange: (start: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // options are sorted newest-first, so a higher index is an older week.
  const idx = options.findIndex((o) => o.start === value);
  const isLive = currentWeekStart != null && value === currentWeekStart;
  const hasOlder = idx >= 0 && idx < options.length - 1;
  const hasNewer = idx > 0;

  return (
    <div ref={ref} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Older week"
        disabled={!hasOlder}
        onClick={() => hasOlder && onChange(options[idx + 1]!.start)}
        className="rounded-md border border-zinc-200 bg-white p-1 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-left transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:bg-zinc-800/70"
      >
        <CalendarDays className="h-3.5 w-3.5 text-zinc-400" />
        <span className="text-[12.5px] font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
          {fmtWeek(value, weekEnd)}
        </span>
        {isLive ? (
          <LiveBadge />
        ) : (
          <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            Past
          </span>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 text-zinc-400 transition-transform', open && 'rotate-180')} />
      </button>

      <button
        type="button"
        aria-label="Newer week"
        disabled={!hasNewer}
        onClick={() => hasNewer && onChange(options[idx - 1]!.start)}
        className="rounded-md border border-zinc-200 bg-white p-1 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="absolute left-9 top-full z-30 mt-1.5 w-64 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                Pay weeks
              </span>
              {currentWeekStart && !isLive && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(currentWeekStart);
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
                >
                  <Zap className="h-2.5 w-2.5" /> Jump to live
                </button>
              )}
            </div>
            <ul className="max-h-72 overflow-y-auto py-1">
              {options.length === 0 ? (
                <li className="px-3 py-3 text-center text-[11px] text-zinc-400">No uploaded weeks yet.</li>
              ) : (
                options.map((o) => {
                  const selected = o.start === value;
                  const live = currentWeekStart != null && o.start === currentWeekStart;
                  return (
                    <li key={o.start}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(o.start);
                          setOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors',
                          selected ? 'bg-emerald-50/70 dark:bg-emerald-950/30' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-3.5 w-3.5 shrink-0 items-center justify-center',
                            selected ? 'text-emerald-600 dark:text-emerald-400' : 'text-transparent',
                          )}
                        >
                          <Check className="h-3.5 w-3.5" strokeWidth={3} />
                        </span>
                        <span
                          className={cn(
                            'flex-1 tabular-nums',
                            selected ? 'font-semibold text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-300',
                          )}
                        >
                          {fmtWeek(o.start, o.end)}
                        </span>
                        {live && <LiveBadge />}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Shown in place of the deadline banner while viewing a non-live (past) week. */
function PastWeekBanner({
  weekStart,
  weekEnd,
  liveWeekStart,
  liveWeekEnd,
  onJumpToLive,
}: {
  weekStart: string;
  weekEnd: string;
  liveWeekStart: string | null;
  liveWeekEnd: string;
  onJumpToLive: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-indigo-300/70 bg-indigo-50 px-3 py-2 text-xs text-indigo-900 dark:border-indigo-800/60 dark:bg-indigo-950/40 dark:text-indigo-200">
      <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
      <span className="font-semibold">Viewing the week of {fmtWeek(weekStart, weekEnd)}.</span>
      <span className="opacity-80">
        Not the current payroll week{liveWeekStart ? ` (${fmtWeek(liveWeekStart, liveWeekEnd)})` : ''} — edits here apply to this past period.
      </span>
      {liveWeekStart && (
        <button
          type="button"
          onClick={onJumpToLive}
          className="ml-auto inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-indigo-700 transition-colors hover:bg-white dark:bg-black/30 dark:text-indigo-200 dark:hover:bg-black/50"
        >
          <Zap className="h-3 w-3" /> Jump to live
        </button>
      )}
    </div>
  );
}

function DeadlineBanner({
  weekStart,
  weekEnd,
  daysLeft,
  overdue,
  readyCount,
  total,
}: {
  weekStart: string;
  weekEnd: string;
  daysLeft: number;
  overdue: boolean;
  readyCount: number;
  total: number;
}) {
  const draft = total - readyCount;
  const done = draft === 0;
  const tier: 'done' | 'critical' | 'warn' | 'info' = done
    ? 'done'
    : overdue || daysLeft <= 1
      ? 'critical'
      : daysLeft <= 3
        ? 'warn'
        : 'info';
  const styles: Record<'done' | 'critical' | 'warn' | 'info', string> = {
    done: 'border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200',
    info: 'border-sky-300/70 bg-sky-50 text-sky-800 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-200',
    warn: 'border-amber-300/80 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200',
    critical: 'border-red-300/80 bg-red-50 text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200',
  };
  const Icon = done ? CheckCircle2 : tier === 'info' ? Clock : AlertTriangle;
  const fmt = (iso: string) => {
    const [y, m, dd] = iso.split('-').map(Number);
    return new Date(y!, m! - 1, dd!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const countdown = overdue ? 'payroll window closing' : daysLeft <= 0 ? 'due today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
  return (
    <div className={cn('mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-xs', styles[tier])}>
      <Icon className={cn('h-4 w-4 shrink-0', tier === 'critical' && !done && 'animate-pulse')} aria-hidden />
      <span className="font-semibold">
        {done ? 'All departments submitted for this week.' : `${draft} of ${total} department${total === 1 ? '' : 's'} not yet submitted.`}
      </span>
      <span className="opacity-80">
        Week {fmt(weekStart)} &ndash; {fmt(weekEnd)} &middot; feeds this week&rsquo;s payroll{done ? '' : ` · ${countdown}`}
      </span>
      <span className="ml-auto rounded-full bg-white/70 px-2 py-0.5 font-mono text-[10px] font-semibold dark:bg-black/30">
        {readyCount}/{total} ready
      </span>
    </div>
  );
}

function HeroBadge({ status, warn }: { status: BonusStatus; warn?: boolean }) {
  const map: Record<BonusStatus, { label: string; cls: string; icon?: React.ReactNode }> = {
    draft: warn
      ? { label: 'Action needed', cls: 'bg-amber-100 text-amber-700 ring-1 ring-amber-300/70 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-700/50', icon: <AlertTriangle className="h-3 w-3" /> }
      : { label: 'Draft', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400', icon: <Sparkles className="h-3 w-3" /> },
    ready: { label: 'Ready', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300', icon: <CheckCircle2 className="h-3 w-3" /> },
    locked: { label: 'Locked', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300', icon: <Lock className="h-3 w-3" /> },
  };
  const s = map[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
        s.cls,
      )}
    >
      {s.icon}
      {s.label}
    </span>
  );
}
