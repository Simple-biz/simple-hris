'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveFirstName } from '@/lib/name/first-name';
import {
  AlertCircle,
  CalendarDays,
  ChevronDown,
  Loader2,
  CheckCircle2,
  XCircle,
  Info,
  Laptop,
  RefreshCw,
  CircleHelp,
  Sparkles,
  Receipt,
} from 'lucide-react';
import { motion } from 'motion/react';
import ProfileCompletionCard from './ProfileCompletionCard';
import { PayStubModal } from '@/components/paystub/PayStubModal';
import { ConnectionStatusBanner } from '@/components/ConnectionStatusBanner';
import { cleanErrorMessage, looksLikeHtmlError } from '@/lib/clean-error-message';
import type { ResourceStatus } from '@/hooks/useResilientResource';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import {
  resolveSystemBonuses,
  isDeptEligible,
  type SystemBonus,
  type ResolvedSystemBonuses,
} from '@/lib/payment-catalog/system-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { isFinalPabWeek as gateIsFinalPabWeek } from '@/lib/payroll/dispatch-bonuses';
import {
  OFFICIAL_USD_TO_PHP_RATE,
  effectiveUsdToPhpRateFromStored,
} from '@/lib/fx/usd-php';
import {
  phpHourlyPayFromSeconds,
  roundWorkedHoursForPay,
  splitRegularOvertimeSeconds,
} from '@/lib/payroll/money-php';
import {
  buildOrphanageHoursIndex,
  orphanageHoursByCoveredDate,
  orphanageCoversDay,
  type OrphanageHoursIndex,
} from '@/lib/payroll/orphanage-pab-coverage';
import {
  groupDateColumnsByCalendarDay,
  pickPreferredHubstaffColumn,
  getCurrentPabMonth,
  inferPabMonthFromColumns,
  filterColumnGroupsByPabRange,
  parseColDate,
  parseDateRangeFromFilename,
  payWeekFromUploadStart,
  buildPabCalendarWeeks,
  pabDateKey,
  resolveCanonicalColumnsToIso,
  resolveCanonicalColumnsToPayWeek,
  columnsAreAllCanonical,
} from '@/lib/hubstaff/calendar-column-dedupe';
import type { PabCalendarDay } from '@/lib/hubstaff/calendar-column-dedupe';
import { periodLabelFromFilename } from '@/lib/hubstaff/period-label';
import { usePabPeriodSettings } from '@/hooks/usePabPeriodSettings';
import {
  resolvePabMonthFromColumns,
  resolvePabRangeForMonth,
} from '@/lib/pab-period-settings';
import {
  disputeGrantsPabForgiveness,
  isOrphanageStyleReason,
} from '@/lib/supabase/pab-day-disputes';
import { parseUsHolidaysList, getEnabledHolidayMap } from '@/lib/us-holidays';
import HiddenValue from './HiddenValue';
import GiftShippingCard, { type GiftShippingState } from './GiftShippingCard';
import { Bell, Eye, EyeOff, Gift, Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseHMS(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) return parseInt(hms[1], 10) * 3600 + parseInt(hms[2], 10) * 60 + parseInt(hms[3], 10);
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return parseInt(hm[1], 10) * 3600 + parseInt(hm[2], 10) * 60;
  const dec = parseFloat(s);
  return Number.isFinite(dec) ? Math.round(dec * 3600) : 0;
}

function secondsToDisplay(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Full calendar date for PAB range labels (locale: en-US). */
function formatPabCalendarDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Compact label for a source CSV. Input filenames look like
 * `simple-biz_daily_report_2026-05-03_to_2026-05-09.csv` (manual export) or
 * `simple-biz_api_sync_2026-07-05_to_2026-07-11.csv` (live Hubstaff sync) —
 * both surface as "Jul 5 - 11, 2026" via the shared pay-period formatter, so
 * this selector, the Payroll Wizard, and the Accounting Overview all render
 * the same label for the same batch. Falls back to the raw filename for
 * anything without an embedded date range.
 */
function formatSourceFileLabel(file: string): string {
  return periodLabelFromFilename(file);
}

const DAY_NAMES: Record<string, { label: string; order: number; weekday: boolean }> = {
  mon: { label: 'Mon', order: 1, weekday: true },
  tue: { label: 'Tue', order: 2, weekday: true },
  wed: { label: 'Wed', order: 3, weekday: true },
  thu: { label: 'Thu', order: 4, weekday: true },
  fri: { label: 'Fri', order: 5, weekday: true },
  sat: { label: 'Sat', order: 6, weekday: false },
  sun: { label: 'Sun', order: 0, weekday: false },
};

const NON_DATE_COLS = new Set([
  'id',
  'email',
  'member',
  'total worked',
  'activity',
  'organization',
  'time zone',
  'job type',
  'job title',
  'work email',
  'personal email',
  'employee id',
  'tax info',
  'location',
  'date added',
  'spent total',
  'currency',
]);

/** Stable weekday columns from Supabase (matches hubstaff-hours-db Pass 3). */
const CANONICAL_WEEKDAY_COLS: Record<string, { label: string; order: number; weekday: boolean }> = {
  sunday: { label: 'Sun', order: 0, weekday: false },
  monday: { label: 'Mon', order: 1, weekday: true },
  tuesday: { label: 'Tue', order: 2, weekday: true },
  wednesday: { label: 'Wed', order: 3, weekday: true },
  thursday: { label: 'Thu', order: 4, weekday: true },
  friday: { label: 'Fri', order: 5, weekday: true },
  saturday: { label: 'Sat', order: 6, weekday: false },
};

function colDayPrefix(col: string): { label: string; order: number; weekday: boolean } | null {
  const trimmed = col.trim();
  const canon = CANONICAL_WEEKDAY_COLS[trimmed.toLowerCase()];
  if (canon) return canon;
  const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.exec(trimmed);
  return m ? DAY_NAMES[m[1].toLowerCase()] ?? null : null;
}

function isDateCol(col: string): boolean {
  const lower = col.trim().toLowerCase();
  if (NON_DATE_COLS.has(lower)) return false;
  if (CANONICAL_WEEKDAY_COLS[lower]) return true;
  if (colDayPrefix(col)) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(col.trim());
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DayHours {
  col: string;
  label: string;
  seconds: number;
  weekday: boolean;
  order: number;
}

/** The wizard's published per-employee figures (payroll.wizard.final_pay.<file>). */
interface PayrollFinalEntry {
  final: number;
  regularPay: number | null;
  otPay: number | null;
  regularHours: number;
  otHours: number;
  totalHours: number;
  initial: number | null;
  /** ₱100 weekly MESA contribution withheld this run (0 when none). Older snapshots
   *  predate this field — treat `undefined` as "unknown", falling back to the
   *  client-side membership-based estimate. */
  mesaDeduction?: number | null;
  /** Accounting-approved MESA emergency disbursement folded into `final` this run
   *  (0 when none). Surfaced as its own payout line so it never silently inflates
   *  the headline take-home. */
  mesaDisbursement?: number | null;
  /** Exact dispatched bonus breakdown (added 2026-07-18). The Employee Pay Stubs
   *  tab reads these to itemize a recovered week's statement exactly; the dashboard
   *  doesn't need them. Older snapshots omit them. */
  perfectAttendanceBonus?: number | null;
  techBonus?: number | null;
  otherBonuses?: number | null;
  adjustment?: number | null;
  orphanagePay?: number | null;
}

interface EmployeeDashboardProps {
  employeeEmail: string;
  /** Drives the "finish your profile" nudge — true when no photo is on file. */
  needsPhoto?: boolean;
  /** True when bank / payout details are not filled in yet. */
  needsBank?: boolean;
  /** True when the employee has not added Skill Sets content yet. */
  needsSkillSet?: boolean;
  /** Jump to the Profile tab so the employee can fill in what's missing. */
  onNavigateToProfile?: (target?: 'overview' | 'payment' | 'skillsets') => void;
  /** Jump to the Notifications tab. */
  onNavigateToNotifications?: () => void;
  /** Unread notification count — drives the bell badge in the dashboard header. */
  unreadNotifications?: number;
}

/** Align with mapHubstaffHoursRow / PayrollWizard so rows match after Supabase sync. */
const HUBSTAFF_EMAIL_KEYS = [
  'Email',
  'email',
  'Work Email',
  'work_email',
  'user_email',
] as const;

function collectHubstaffRowEmails(r: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = s?.trim();
    if (t) seen.add(t);
  };
  for (const k of HUBSTAFF_EMAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(r, k)) add(String(r[k]));
  }
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(r)) {
    lower.set(k.toLowerCase(), v);
  }
  for (const alias of ['work email', 'personal email', 'work_email', 'personal_email']) {
    const v = lower.get(alias);
    if (v != null) add(String(v));
  }
  return [...seen];
}

function hubstaffRowMatchesEmployee(
  r: Record<string, unknown>,
  employeeNorms: string | string[],
): boolean {
  const set = Array.isArray(employeeNorms) ? new Set(employeeNorms) : new Set([employeeNorms]);
  return collectHubstaffRowEmails(r).some((e) => {
    const n = normEmail(e);
    return n ? set.has(n) : false;
  });
}

function getFieldFromRow(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  const lowerToKey = new Map<string, string>();
  for (const rk of Object.keys(row)) {
    lowerToKey.set(rk.toLowerCase(), rk);
  }
  for (const k of keys) {
    const rk = lowerToKey.get(k.toLowerCase());
    if (rk) {
      const v = row[rk];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  return undefined;
}

function getTotalWorkedRaw(row: Record<string, unknown>): unknown {
  return getFieldFromRow(row, [
    'Total worked',
    'total worked',
    'total_worked',
    'Hours',
    'hours',
    'decimal_hours',
  ]);
}

/** ISO YYYY-MM-DD → Sun=0 … Sat=6 in UTC (matches Hubstaff / hubstaff-hours-db). */
function isoDateToUtcDow(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo, d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.getUTCDay();
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const EMPLOYEE_MESSAGES: { heading: (name: string) => string; body: string }[] = [
  {
    heading: (name) => `Welcome back, ${name} — your work keeps this company moving. ✦`,
    body: "Track your hours, check your pay estimates, and keep your Perfect Attendance streak alive. Everything you need is right here.",
  },
  {
    heading: (name) => `Hi ${name} — consistency is your superpower. ✦`,
    body: "Every hour you log and every shift you show up for adds up. Your dashboard has the full picture — hours, pay, and attendance all in one place.",
  },
  {
    heading: (name) => `Good to see you, ${name} — keep showing up. ✦`,
    body: "Your effort is measured here, recognized, and rewarded. Check your current estimates and make sure everything looks right.",
  },
  {
    heading: (name) => `Hey ${name} — great work starts with knowing where you stand. ✦`,
    body: "Review your hours, estimated pay, and PAB status below. Reach out to your manager if anything looks off.",
  },
  {
    heading: (name) => `Welcome, ${name} — every shift counts and so do you. ✦`,
    body: "Your hours, bonuses, and attendance are tracked transparently here. Keep it going — you're doing great.",
  },
];

/** One-off "special transfers" sent to this employee from the People tab. Self-
 *  scoped — the endpoint resolves identity from the session, the `email` is just
 *  a hint. Renders nothing until there's at least one transfer. */
interface EmployeeSpecialTransferRow {
  note: string | null;
  amount_php: number | null;
  paid_at: string | null;
  period_start: string | null;
  status: string | null;
}

function EmployeeSpecialTransfers({ employeeEmail }: { employeeEmail: string | null }) {
  const [rows, setRows] = useState<EmployeeSpecialTransferRow[]>([]);
  useEffect(() => {
    if (!employeeEmail) return;
    let alive = true;
    fetch(`/api/people/special-transfers?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { transfers?: EmployeeSpecialTransferRow[] } | null) => {
        if (alive && j?.transfers) setRows(j.transfers);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [employeeEmail]);

  if (rows.length === 0) return null;
  const peso = (n: number | null) =>
    n == null ? '—' : `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <Card className="shrink-0 border-violet-200/80 dark:border-violet-900/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-violet-500" /> Special transfers
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {rows.map((t, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-3 rounded-lg border border-violet-100 bg-violet-50/50 px-3 py-2 text-[13px] dark:border-violet-900/30 dark:bg-violet-950/20"
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-zinc-800 dark:text-zinc-100">{t.note || 'Special transfer'}</div>
              <div className="text-[11px] text-zinc-400">{t.paid_at ?? t.period_start ?? ''}</div>
            </div>
            <div className="shrink-0 font-semibold text-zinc-900 dark:text-zinc-100">{peso(t.amount_php)}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function EmployeeDashboard({ employeeEmail, needsPhoto = false, needsBank = false, needsSkillSet = false, onNavigateToProfile, onNavigateToNotifications, unreadNotifications = 0 }: EmployeeDashboardProps) {
  const [loading, setLoading] = useState(true);
  const [employeeStartDate, setEmployeeStartDate] = useState<Date | null>(null);
  // The time-of-day greeting depends on the viewer's LOCAL hour, which only
  // exists on the client. Computing it during SSR uses the server's timezone
  // (UTC on Vercel) and mismatches the browser (Manila, UTC+8) → React #418
  // hydration error. Render a stable greeting on the server + first client
  // paint, then switch to the time-based one after mount.
  const [greetingReady, setGreetingReady] = useState(false);
  useEffect(() => { setGreetingReady(true); }, []);
  // Shared mask state for the hero pay values (Take-Home, Regular, Overtime).
  // Default hidden on every mount so passers-by see masked amounts; one click
  // on the eye next to Take-Home reveals all three together.
  const [payValuesRevealed, setPayValuesRevealed] = useState(false);
  /** All normalized emails known for this employee (login + work + personal). */
  const [aliasEmails, setAliasEmails] = useState<string[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [rate, setRate] = useState<EmployeeHourlyRateRow | null>(null);
  // Rate history for the inline PAB Calendar badge — fetched once per email
  // change so the per-day rate is shown as an emerald-ringed pill on the day
  // a rate change took effect, and as a faint label on every other day.
  const [rateHistory, setRateHistory] = useState<Array<{
    effectiveFrom: Date;
    regularRate: number | null;
    otRate: number | null;
  }>>([]);
  const [usdToPhpRate, setUsdToPhpRate] = useState(OFFICIAL_USD_TO_PHP_RATE);
  const [dataError, setDataError] = useState<string | null>(null);
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [manualFileSelect, setManualFileSelect] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const sourceMenuRef = useRef<HTMLDivElement | null>(null);
  // Pay-week files this employee can open a stub for (paid + emailed). Drives the
  // "Open Paystubs" button beside the selector; the modal itself is session-scoped.
  const [paidPaystubWeeks, setPaidPaystubWeeks] = useState<Set<string>>(new Set());
  const [paystubModalFile, setPaystubModalFile] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/employee/paystub', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { weeks: [] }))
      .then((json: { weeks?: string[] }) => {
        if (!cancelled) setPaidPaystubWeeks(new Set(json.weeks ?? []));
      })
      .catch(() => {
        /* button just stays disabled if we can't load the paid-week list */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!sourceMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(e.target as Node)) {
        setSourceMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSourceMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [sourceMenuOpen]);
  const [fileLoading, setFileLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Connection health for the essentials load — drives the ConnectionStatusBanner so
  // a dead/unreachable Supabase shows the UI (with last-known data) + a Retry, instead
  // of a wiped shell or a raw error dump. `lastLoadedAt` gates stale-vs-hard-error.
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [essentialsError, setEssentialsError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /** Merged row for this employee across ALL uploaded CSVs — used for full-month PAB. */
  const [pabMergedRow, setPabMergedRow] = useState<Record<string, unknown> | null>(null);
  const [pabMergedColumns, setPabMergedColumns] = useState<string[]>([]);
  const [pabMergeLoading, setPabMergeLoading] = useState(false);
  /** Accumulated pay breakdown across every source file for this employee. */
  const [allTimeTotalSeconds, setAllTimeTotalSeconds] = useState(0);
  const [allTimeRegularSec, setAllTimeRegularSec] = useState(0);
  const [allTimeOtSec, setAllTimeOtSec] = useState(0);

  const pabPeriodSettings = usePabPeriodSettings();

  const email = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();

  /**
   * Per-employee final pay published by the Payroll Wizard for the selected file
   * (`payroll.wizard.final_pay.<file>`, written when accounting locks the Additions
   * step / dispatches). When present, the hero "Estimated Take-Home" shows this exact
   * figure — incl. KPI/dept bonuses, the accounting Adj. delta, Orphanage pay, and
   * MESA deduction/disbursement — instead of the client-side auto-estimate.
   */
  const [payrollFinal, setPayrollFinal] = useState<PayrollFinalEntry | null>(null);
  const fetchPayrollFinal = useCallback(async (signal?: AbortSignal) => {
    if (!selectedFile || selectedFile === '__all__') { setPayrollFinal(null); return; }
    try {
      const res = await fetch(
        `/api/app-settings?key=${encodeURIComponent(`payroll.wizard.final_pay.${selectedFile}`)}`,
        { cache: 'no-store', signal },
      );
      const json = await res.json();
      if (signal?.aborted) return;
      if (!json?.value) { setPayrollFinal(null); return; }
      const data = JSON.parse(json.value) as { finals?: Record<string, PayrollFinalEntry> };
      const finals = data.finals ?? {};
      const candidates = [email, ...aliasEmails]
        .map((e) => e?.trim().toLowerCase())
        .filter(Boolean) as string[];
      let found: PayrollFinalEntry | null = null;
      for (const c of candidates) {
        const entry = finals[c];
        if (entry && typeof entry.final === 'number') { found = entry; break; }
      }
      setPayrollFinal(found);
    } catch {
      if (!signal?.aborted) setPayrollFinal(null);
    }
  }, [selectedFile, email, aliasEmails]);

  // Read the wizard's published final, and keep it current while accounting edits
  // live (snapshot is debounce-written by the wizard): refetch on mount, on window
  // focus, and on a light interval.
  useEffect(() => {
    const ctrl = new AbortController();
    void fetchPayrollFinal(ctrl.signal);
    const onFocus = () => void fetchPayrollFinal();
    window.addEventListener('focus', onFocus);
    const id = window.setInterval(() => void fetchPayrollFinal(), 30_000);
    return () => { ctrl.abort(); window.removeEventListener('focus', onFocus); window.clearInterval(id); };
  }, [fetchPayrollFinal]);

  /**
   * The viewer's own approved MESA emergency disbursement — used only to annotate the
   * separate payout card with its reason/explanation. The amount paid this run comes
   * from the wizard snapshot (`mesaDisbursementPhp`), not this; this is best-effort
   * context. Self-scoped: `/api/mesa-requests?email=` resolves identity server-side.
   */
  const [mesaDisbursementInfo, setMesaDisbursementInfo] = useState<{
    reason: string | null;
    explanation: string | null;
    amount: number | null;
  } | null>(null);
  useEffect(() => {
    if (!email) { setMesaDisbursementInfo(null); return; }
    let cancelled = false;
    fetch(
      `/api/mesa-requests?email=${encodeURIComponent(email)}&request_type=disbursement&status=approved`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { rows?: Array<{ disbursement_reason: string | null; explanation: string | null; amount_needed: number | null; dispatched_at?: string | null }> } | null) => {
        if (cancelled) return;
        const rows = j?.rows ?? [];
        // Prefer one still awaiting dispatch (the one a payroll run would pay out).
        const pick = rows.find((r) => r.dispatched_at == null) ?? rows[0];
        setMesaDisbursementInfo(
          pick
            ? { reason: pick.disbursement_reason, explanation: pick.explanation, amount: pick.amount_needed }
            : null,
        );
      })
      .catch(() => { if (!cancelled) setMesaDisbursementInfo(null); });
    return () => { cancelled = true; };
  }, [email]);

  // Fetch the viewer's rate history once per email change. Powers the per-day
  // rate badge on the inline PAB Calendar in the Overview tab.
  useEffect(() => {
    let cancelled = false;
    if (!email) {
      setRateHistory([]);
      return;
    }
    fetch(`/api/employee-rate-history?email=${encodeURIComponent(email)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { rows?: Array<{ regular_rate: string | null; ot_rate: string | null; effective_from: string }> }) => {
        if (cancelled) return;
        const parsed: typeof rateHistory = [];
        for (const r of j.rows ?? []) {
          const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.effective_from ?? '');
          if (!m) continue;
          const num = (s: string | null) => {
            if (s == null) return null;
            const v = parseFloat(String(s).replace(/,/g, ''));
            return Number.isFinite(v) ? v : null;
          };
          parsed.push({
            effectiveFrom: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
            regularRate: num(r.regular_rate),
            otRate: num(r.ot_rate),
          });
        }
        parsed.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
        setRateHistory(parsed);
      })
      .catch(() => { if (!cancelled) setRateHistory([]); });
    return () => { cancelled = true; };
  }, [email]);

  // Resolve the rate row effective on a given calendar date. Caller passes the
  // local-time Date for the cell. Marks `isFlipDay` so the badge can highlight
  // the exact day a mid-cycle rate change took effect.
  const resolveDayRate = React.useCallback(
    (date: Date): { reg: number | null; ot: number | null; isFlipDay: boolean } => {
      const t = date.getTime();
      for (let i = 0; i < rateHistory.length; i += 1) {
        const row = rateHistory[i];
        if (row.effectiveFrom.getTime() <= t) {
          const isFlipDay = row.effectiveFrom.getTime() === t && i < rateHistory.length - 1;
          return { reg: row.regularRate, ot: row.otRate, isFlipDay };
        }
      }
      return { reg: null, ot: null, isFlipDay: false };
    },
    [rateHistory],
  );

  const fmtDayRate = React.useCallback((n: number | null): string => {
    if (n == null) return '—';
    return '₱' + n.toLocaleString('en-PH', { maximumFractionDigits: 0 });
  }, []);

  const [myDisputes, setMyDisputes] = useState<import('@/lib/supabase/pab-day-disputes').PabDayDisputeRow[]>([]);
  /** TEMPORARY orphanage → PAB coverage (see orphanage-pab-coverage.ts): this
   *  employee's locked-in orphanage hours per week, indexed for date lookup.
   *  AUTO mode — the hours alone forgive short weekdays in their coverage
   *  window; the raw rows are kept for the "Orphanage – Visits" panel. */
  const [orphanageHoursIndex, setOrphanageHoursIndex] = useState<OrphanageHoursIndex>(new Map());
  const [orphanageHourRows, setOrphanageHourRows] = useState<{ source_file: string | null; hours: number }[]>([]);
  /** Live per-day tracked seconds (ISO date → sec) from the Hubstaff API for the
   *  trailing two weeks — fills today/this week on the PAB calendar before
   *  accounting ingests the batch. Null when the deployment has no Hubstaff API
   *  credentials (overlay disabled). Mirrors EmployeeMyHours' overlay. */
  const [liveHours, setLiveHours] = useState<{ days: Record<string, number>; asOf: string } | null>(null);
  // Holiday map: ISO "YYYY-MM-DD" -> holiday name (only enabled holidays when master toggle is on)
  const [usHolidayDates, setUsHolidayDates] = useState<Map<string, string>>(new Map());
  const [holidayModal, setHolidayModal] = useState<{ name: string; date: string } | null>(null);
  /** Mobile: PAB rules, bonus status, and pay numbers live in this sheet (charts stay on the main view). */
  const [mobileHelpOpen, setMobileHelpOpen] = useState(false);
  /** Master-list profile fields used to prefill the gift-shipping form. */
  const [profileForShipping, setProfileForShipping] = useState<{
    name: string | null;
    personalEmail: string | null;
    workEmail: string | null;
    department: string | null;
  }>({ name: null, personalEmail: null, workEmail: null, department: null });
  /** PAB + Tech amounts + per-department allowlist (Payment Catalog System Bonuses). */
  const [sysBonusCfg, setSysBonusCfg] = useState<ResolvedSystemBonuses>(() => resolveSystemBonuses([]));

  /** Gift-shipping dialog control — both the inline card CTA and the header
   *  bell icon flip this flag. */
  const [giftDialogOpen, setGiftDialogOpen] = useState(false);
  /** State summary emitted by GiftShippingCard so the bell can show a badge. */
  const [giftState, setGiftState] = useState<GiftShippingState>({
    status: 'none',
    milestoneMonths: null,
    needsAction: false,
  });

  // Fetch the employee's master row once to get their start_date
  // (used to gate Tech Bonus on the 30-day-of-service requirement).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/employees?email=${encodeURIComponent(email)}`, { cache: 'no-store' });
        const json = (await res.json()) as {
          employees?: {
            name?: string | null;
            work_email?: string | null;
            personal_email?: string | null;
            start_date?: string | null;
            department?: string | null;
          }[];
        };
        if (cancelled) return;
        // Server already filtered to this employee; just take the first row.
        const me = (json.employees ?? [])[0];
        const aliases = new Set<string>([email]);
        if (me) {
          const we = normEmail(me.work_email ?? '');
          const pe = normEmail(me.personal_email ?? '');
          if (we) aliases.add(we);
          if (pe) aliases.add(pe);
          setProfileForShipping({
            name: me.name ?? null,
            personalEmail: pe ?? we ?? null,
            workEmail: we ?? null,
            department: me.department ?? null,
          });
        }
        setAliasEmails([...aliases]);
        if (!me?.start_date) {
          setEmployeeStartDate(null);
          return;
        }
        const d = new Date(me.start_date);
        setEmployeeStartDate(isNaN(d.getTime()) ? null : d);
      } catch {
        if (!cancelled) {
          setEmployeeStartDate(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email]);

  /**
   * Live overlay: this person's real tracked time straight from the Hubstaff API
   * (server-cached ~3 min org-wide). Uploaded batches stay authoritative — the
   * overlay only fills days the batches don't cover yet (today / this week).
   * Mirrors EmployeeMyHours so the Overview PAB calendar and My Hours agree.
   */
  const fetchLiveHours = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/hubstaff-hours?live=1&email=${encodeURIComponent(email)}&_=${Date.now()}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as {
        configured?: boolean;
        days?: Record<string, number>;
        asOf?: string;
        error?: string | null;
      };
      if (!res.ok || !json.configured || json.error) {
        // Unconfigured or transiently failing — keep whatever overlay we had.
        if (!json.configured) setLiveHours(null);
        return;
      }
      setLiveHours({ days: json.days ?? {}, asOf: json.asOf ?? new Date().toISOString() });
    } catch {
      /* transient — the next poll retries */
    }
  }, [email]);

  useEffect(() => {
    void fetchLiveHours();
    const id = window.setInterval(() => void fetchLiveHours(), 180_000);
    const onFocus = () => void fetchLiveHours();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchLiveHours]);

  // Load rates, exchange rate, and source file list on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDataError(null);
      setEssentialsError(null);
      try {
        const [ratesRes, fxRes, filesRes, holidaysRes, sysBonusRes] = await Promise.all([
          fetch(`/api/employee-hourly-rates?email=${encodeURIComponent(email)}`, { cache: 'no-store' }),
          fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
          fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, { cache: 'no-store' }),
          fetch('/api/app-settings?keys=us_holidays_enabled,us_holidays_list', { cache: 'no-store' }),
          fetch('/api/payment-catalog/system-bonuses', { cache: 'no-store' }),
        ]);

        const ratesJson = (await ratesRes.json()) as {
          rows?: EmployeeHourlyRateRow[];
          error?: string | null;
        };
        const fxJson = (await fxRes.json()) as { value: string | null };
        const filesJson = (await filesRes.json()) as { files?: string[]; error?: string | null };
        const holidaysJson = (await holidaysRes.json()) as { values: Record<string, string | null>; error?: string | null };
        const sysBonusJson = (await sysBonusRes.json().catch(() => ({ bonuses: [] }))) as { bonuses?: SystemBonus[] };
        if (cancelled) return;

        setSysBonusCfg(resolveSystemBonuses(sysBonusJson.bonuses ?? []));

        const hVals = holidaysJson.values;
        const holidayList = parseUsHolidaysList(hVals['us_holidays_list'] ?? null);
        const holidayEnabled = (hVals['us_holidays_enabled'] ?? 'false') === 'true';
        setUsHolidayDates(getEnabledHolidayMap(holidayList, holidayEnabled));

        setUsdToPhpRate(effectiveUsdToPhpRateFromStored(fxJson.value));

        if (ratesJson.error) {
          if (looksLikeHtmlError(String(ratesJson.error))) {
            setEssentialsError(cleanErrorMessage(ratesJson.error));
          } else {
            setDataError(cleanErrorMessage(ratesJson.error));
          }
        }
        // Server already filtered to this employee.
        const myRate = (ratesJson.rows ?? [])[0];
        if (myRate) setRate(myRate);

        const files = filesJson.files ?? [];
        setSourceFiles(files);
        setLastLoadedAt(Date.now());
        if (files.length > 0) {
          setSelectedFile(files[0]); // latest (API returns newest-first)
        } else {
          // No source files — fall back to loading all data
          await loadHoursData(null, cancelled);
        }
      } catch (e) {
        if (!cancelled) {
          // Connection/essentials failure → surface via the ConnectionStatusBanner and
          // KEEP last-known data (don't wipe `row`, don't dump the raw error into the
          // red box) so the dashboard stays usable during a Supabase outage.
          setEssentialsError(cleanErrorMessage(e, 'Failed to load dashboard data'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, aliasEmails, reloadKey]);

  // Load hours data for the selected source file
  const loadHoursData = React.useCallback(
    async (file: string | null, cancelled?: boolean, aliasOverride?: string[]) => {
    const emailsForMatch = aliasOverride ?? (aliasEmails.length ? aliasEmails : [email]);
    try {
      // Server-side email filter shrinks the response from the full weekly
      // roster to one row — pass any of the matched aliases (work/personal).
      const emailParam = `&email=${encodeURIComponent(emailsForMatch[0] ?? email)}`;
      const url = file
        ? `/api/hubstaff-hours?source_file=${encodeURIComponent(file)}${emailParam}&_=${Date.now()}`
        : `/api/hubstaff-hours?_=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      const json = (await res.json()) as {
        columns?: string[] | null;
        rows?: Record<string, unknown>[] | null;
        error?: string | null;
      };
      if (cancelled) return;

      if (!res.ok || json.error) {
        // A Supabase/Cloudflare outage can arrive as a raw HTML error page in
        // json.error — route those to the ConnectionStatusBanner (with Retry)
        // rather than dumping the whole page into the red card.
        if (!res.ok || looksLikeHtmlError(String(json.error ?? ''))) {
          setEssentialsError(cleanErrorMessage(json.error, `Hours request failed (${res.status})`));
        } else {
          setDataError(cleanErrorMessage(json.error, `Hours request failed (${res.status})`));
        }
        setRow(null);
      } else if (json.columns && json.rows) {
        setColumns(json.columns);
        const myRow = json.rows.find((r) => hubstaffRowMatchesEmployee(r, emailsForMatch));

        if (myRow) {
          const dateCols = json.columns.filter(isDateCol);
          const allEmpty =
            dateCols.length === 0 ||
            dateCols.every((c) => {
              const v = myRow[c];
              return v == null || String(v).trim() === '';
            });

          if (allEmpty) {
            try {
              const fbRes = await fetch('/api/app-settings?key=hubstaff_daily_breakdown', {
                cache: 'no-store',
              });
              const fbJson = (await fbRes.json()) as { value: string | null };
              if (fbJson.value) {
                const { dateCols: savedCols, daily } = JSON.parse(fbJson.value) as {
                  dateCols: string[];
                  daily: Record<string, Record<string, string | null>>;
                };
                const dayData = daily[email];
                if (dayData && savedCols?.length) {
                  const merged = { ...myRow, ...dayData };
                  const mergedCols = [...new Set([...json.columns, ...savedCols])];
                  setColumns(mergedCols);
                  setRow(merged);
                } else {
                  setRow(myRow);
                }
              } else {
                setRow(myRow);
              }
            } catch {
              setRow(myRow);
            }
          } else {
            setRow(myRow);
          }
        } else {
          setRow(null);
        }
      } else {
        setRow(null);
      }
    } catch (e) {
      if (!cancelled) {
        setDataError(cleanErrorMessage(e, 'Failed to load hours'));
        setRow(null);
      }
    }
    },
    [email, aliasEmails],
  );

  // Reload hours when the selected file changes (skip for "All Time")
  useEffect(() => {
    if (selectedFile === null || selectedFile === '__all__') return;
    let cancelled = false;
    setFileLoading(true);
    setDataError(null);
    loadHoursData(selectedFile, false).finally(() => {
      if (!cancelled) setFileLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedFile, loadHoursData]);

  // Fetch ALL source files and merge this employee's daily columns for full-month PAB.
  // The server does the fan-out and ships just this employee's row per file
  // (see app/api/hubstaff-hours/route.ts `merge_all` mode). Canonical weekday
  // columns are still resolved client-side because the resolver depends on the
  // filename's embedded date range — the merge endpoint preserves source_file
  // tagging so we can resolve per row here.
  useEffect(() => {
    if (sourceFiles.length === 0) {
      setPabMergeLoading(false);
      setPabMergedRow(null);
      setPabMergedColumns([]);
      setAllTimeTotalSeconds(0);
      setAllTimeRegularSec(0);
      setAllTimeOtSec(0);
      return;
    }
    let cancelled = false;
    setPabMergeLoading(true);
    const emailForServer = (aliasEmails.length ? aliasEmails[0] : email);
    (async () => {
      try {
        const res = await fetch(
          `/api/hubstaff-hours?merge_all=1&email=${encodeURIComponent(emailForServer)}&_=${Date.now()}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as {
          columns?: string[] | null;
          perFile?: { source_file: string; row: Record<string, unknown> | null }[] | null;
        };
        if (cancelled) return;

        const allCols = new Set<string>(json.columns ?? []);
        let merged: Record<string, unknown> = {};
        let found = false;
        let cumulativeSeconds = 0;
        let cumulativeRegSec = 0;
        let cumulativeOtSec = 0;

        for (const { source_file: file, row: myRow } of json.perFile ?? []) {
          if (!myRow) continue;
          found = true;

          const tw = getTotalWorkedRaw(myRow);
          let fileSec = 0;
          if (tw != null && String(tw).trim() !== '') {
            fileSec = parseHMS(tw);
          } else {
            // Fallback: sum all date columns in this row (matches per-file fileSeconds logic)
            for (const [k, v] of Object.entries(myRow)) {
              if (isDateCol(k)) fileSec += parseHMS(v);
            }
          }
          if (fileSec > 0) {
            cumulativeSeconds += fileSec;
            const fileHrs = roundWorkedHoursForPay(fileSec / 3600);
            const split = splitRegularOvertimeSeconds(fileHrs);
            cumulativeRegSec += split.regularSec;
            cumulativeOtSec += split.otSec;
          }

          const rowCols = Object.keys(myRow);
          const needsResolve = columnsAreAllCanonical(rowCols);
          const resolved = needsResolve ? resolveCanonicalColumnsToIso(myRow, file) : myRow;

          for (const col of Object.keys(resolved)) allCols.add(col);
          merged = { ...merged, ...resolved };
        }

        if (cancelled) return;
        setPabMergedColumns([...allCols]);
        setPabMergedRow(found ? merged : null);
        setAllTimeTotalSeconds(cumulativeSeconds);
        setAllTimeRegularSec(cumulativeRegSec);
        setAllTimeOtSec(cumulativeOtSec);
      } catch {
        // PAB degrades gracefully — falls back to single-file check
      } finally {
        if (!cancelled) setPabMergeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceFiles, email, aliasEmails]);

  // Hogan (HSL) keeps Mon–Sun weeks; all other departments use Sun–Sat.
  const isHsl = (profileForShipping.department ?? '').trim().toLowerCase() === 'hsl';

  const isAllTime = selectedFile === '__all__';

  // Compute daily hours breakdown (one bar per calendar day — dedupe ISO vs Mon 3/24 vs monday…)
  //
  // A single Hubstaff upload runs Sun→Sun (8 days) when consecutive weeks overlap.
  // The pay week kept depends on department: HSL = Mon→Sun (drops the leading Sunday),
  // everyone else = Sun→Sat (drops the trailing Sunday). For a single-file view we:
  //   1. determine that 7-day window,
  //   2. resolve canonical weekday columns (sunday/monday/…) to the window's ISO dates so
  //      the lone "sunday" slot lands on THIS department's Sunday (leading for non-HSL,
  //      trailing for HSL) instead of the generic last-wins trailing Sunday,
  //   3. clamp ISO-dated days to the window.
  // All-time view is a multi-week rollup, so it is never clamped or re-resolved.
  const dailyHours = useMemo<DayHours[]>(() => {
    if (!row) return [];

    // 1. Department pay-week window for this upload.
    let payWindow: { start: Date; end: Date } | null = null;
    if (!isAllTime) {
      const isoDates = columns
        .map((c) => parseColDate(c))
        .filter((d): d is Date => d !== null);
      if (isoDates.length > 0) {
        const uploadStart = isoDates.reduce((m, d) => (d.getTime() < m.getTime() ? d : m), isoDates[0]);
        payWindow = payWeekFromUploadStart(uploadStart, isHsl);
      } else if (selectedFile && selectedFile !== '__all__') {
        const range = parseDateRangeFromFilename(selectedFile);
        if (range) payWindow = payWeekFromUploadStart(range.start, isHsl);
      }
    }

    // 2. Resolve canonical-only columns onto the window's ISO dates.
    let effRow: Record<string, unknown> = row;
    let effCols = columns;
    if (payWindow && columnsAreAllCanonical(columns)) {
      effRow = resolveCanonicalColumnsToPayWeek(row, payWindow);
      effCols = Object.keys(effRow);
    }

    const dateCols = effCols.filter(isDateCol);
    const groups = groupDateColumnsByCalendarDay(dateCols, effCols);
    const mapped = groups
      .map((group): { day: DayHours; date: Date | null } | null => {
        const col = pickPreferredHubstaffColumn(group);
        const seconds = Math.max(
          ...group.map((c) => {
            const raw =
              getFieldFromRow(effRow, [c]) ??
              (Object.prototype.hasOwnProperty.call(effRow, c) ? effRow[c] : undefined);
            return parseHMS(raw);
          }),
        );
        const prefix = colDayPrefix(col);
        if (prefix) {
          return {
            day: { col, label: prefix.label, seconds, weekday: prefix.weekday, order: prefix.order },
            date: parseColDate(col),
          };
        }
        const iso = col.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
          const dow = isoDateToUtcDow(iso);
          if (dow === null) return null;
          const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return {
            day: { col, label: labels[dow], seconds, weekday: dow >= 1 && dow <= 5, order: dow },
            date: parseColDate(col),
          };
        }
        return null;
      })
      .filter((x): x is { day: DayHours; date: Date | null } => x !== null);

    // 3. Clamp dated days to the pay week. Undated days (unresolved canonical) are kept.
    let kept = mapped;
    if (payWindow) {
      const lo = payWindow.start.getTime();
      const hi = payWindow.end.getTime();
      kept = mapped.filter((m) => {
        if (!m.date) return true;
        const t = new Date(m.date.getFullYear(), m.date.getMonth(), m.date.getDate()).getTime();
        return t >= lo && t <= hi;
      });
    }

    return kept.map((m) => m.day).sort((a, b) => a.order - b.order);
  }, [row, columns, isAllTime, isHsl, selectedFile]);

  // Compute pay — per-file values.
  // Single-file view: sum the (pay-week-clamped) per-day hours so the total
  // matches the breakdown and excludes the overlap day dropped per department.
  // The file's "Total worked" aggregate covers the full Sun→Sun span, so it's
  // only trusted for the all-time rollup where no clamp applies.
  const fileSeconds = useMemo(() => {
    if (!row) return 0;
    if (!isAllTime) return dailyHours.reduce((s, d) => s + d.seconds, 0);
    const tw = getTotalWorkedRaw(row);
    if (tw != null && String(tw).trim() !== '') return parseHMS(tw);
    return dailyHours.reduce((s, d) => s + d.seconds, 0);
  }, [row, dailyHours, isAllTime]);

  const parseRate = (v: string | null | undefined): number | null => {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const regularRate = parseRate(rate?.regular_rate);
  const otRate = parseRate(rate?.ot_rate);

  // Switch between per-file and all-time totals.
  // All-time uses pre-split regular/OT (each file split independently at 40h).
  const totalSeconds = isAllTime ? allTimeTotalSeconds : fileSeconds;
  const regularSecComputed = isAllTime ? allTimeRegularSec : splitRegularOvertimeSeconds(roundWorkedHoursForPay(fileSeconds / 3600)).regularSec;
  const otSecComputed = isAllTime ? allTimeOtSec : splitRegularOvertimeSeconds(roundWorkedHoursForPay(fileSeconds / 3600)).otSec;
  const regularPayComputed =
    regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSecComputed) : null;
  const otPayComputed =
    otSecComputed > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSecComputed) : null) : 0;

  // For the current period, prefer the wizard's published Regular/OT/hours so the
  // breakdown reconciles exactly with the Estimated Take-Home (same hour basis —
  // incl. the cross-upload boundary Sunday the wizard merges in). All-time and the
  // no-snapshot case fall back to the client-side computation.
  const wizardSnap = (!isAllTime && payrollFinal) ? payrollFinal : null;
  const totalHours = wizardSnap ? wizardSnap.totalHours : roundWorkedHoursForPay(totalSeconds / 3600);
  const regularHours = wizardSnap ? wizardSnap.regularHours : regularSecComputed / 3600;
  const otHours = wizardSnap ? wizardSnap.otHours : otSecComputed / 3600;
  const regularPay = wizardSnap ? wizardSnap.regularPay : regularPayComputed;
  const otPay = wizardSnap ? wizardSnap.otPay : otPayComputed;
  const totalPay = wizardSnap
    ? wizardSnap.initial
    : (regularPayComputed != null && otPayComputed != null
        ? Math.round((regularPayComputed + otPayComputed) * 100) / 100
        : null);

  /**
   * Full-month daily hours for PAB: uses merged data from ALL uploaded CSVs.
   * Falls back to single-file dailyHours if merged data isn't available.
   */
  const pabDailyHours = useMemo<DayHours[]>(() => {
    const useSelected = !!selectedFile && selectedFile !== '__all__';
    // Hours always come from merged data so every day in the PAB period fills.
    const pabRow = pabMergedRow ?? row;
    const pabCols = pabMergedColumns.length > 0 ? pabMergedColumns : columns;
    if (!pabRow) return [];
    const dateCols = pabCols.filter(isDateCol);
    let groups = groupDateColumnsByCalendarDay(dateCols, pabCols);
    const manualPab = pabPeriodSettings.validManualRange;
    if (manualPab) {
      groups = filterColumnGroupsByPabRange(groups, pabCols, manualPab.start, manualPab.end);
    } else if (!useSelected) {
      // Default view: use the EXACT PAB period the Payroll Wizard is evaluating
      // (its active month + saved start/end), so the employee's calendar always
      // matches Accounting.
      const { start, end } = pabPeriodSettings.activeRange;
      groups = filterColumnGroupsByPabRange(groups, pabCols, start, end);
    } else {
      // Manual file browse: PAB month inferred from the selected file. Override
      // windows claim their dates first (so a CSV inside May's Jun–Jul override
      // resolves to May), then that month's explicit window bounds the groups.
      const pabMonth =
        resolvePabMonthFromColumns(pabCols, pabPeriodSettings.overrides)
        ?? inferPabMonthFromColumns(pabCols);
      if (pabMonth) {
        const { start, end } = resolvePabRangeForMonth(pabMonth.year, pabMonth.month, pabPeriodSettings.overrides);
        groups = filterColumnGroupsByPabRange(groups, pabCols, start, end);
      }
    }
    return groups
      .map((group) => {
        const col = pickPreferredHubstaffColumn(group);
        const seconds = Math.max(
          ...group.map((c) => {
            const raw =
              getFieldFromRow(pabRow, [c]) ??
              (Object.prototype.hasOwnProperty.call(pabRow, c) ? pabRow[c] : undefined);
            return parseHMS(raw);
          }),
        );
        const prefix = colDayPrefix(col);
        if (prefix) {
          return { col, label: prefix.label, seconds, weekday: prefix.weekday, order: prefix.order };
        }
        const iso = col.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
          const dow = isoDateToUtcDow(iso);
          if (dow === null) return null;
          const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return { col, label: labels[dow], seconds, weekday: dow >= 1 && dow <= 5, order: dow };
        }
        return null;
      })
      .filter((x): x is DayHours => x !== null)
      .sort((a, b) => {
        // Sort chronologically by parsed date; fall back to day-of-week order
        const da = parseColDate(a.col);
        const db = parseColDate(b.col);
        if (da && db) return da.getTime() - db.getTime();
        return a.order - b.order;
      });
  }, [pabMergedRow, pabMergedColumns, row, columns, selectedFile, manualFileSelect, pabPeriodSettings.validManualRange, pabPeriodSettings.overrides, pabPeriodSettings.activeRange]);

  /** PAB month + date range for display.
   * Default: latest PAB period in merged CSV data (or today if none).
   * When user manually picks a CSV: use that file's inferred period. */
  const pabMonthRange = useMemo(() => {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const manual = pabPeriodSettings.validManualRange;
    if (manual) {
      const { start, end } = manual;
      return {
        year: start.getFullYear(),
        month: start.getMonth(),
        start,
        end,
        monthName: monthNames[start.getMonth()] ?? '',
      };
    }
    const useSelected = !!selectedFile && selectedFile !== '__all__';
    if (!useSelected) {
      // Default view: mirror the EXACT PAB period the Payroll Wizard is evaluating
      // (active month + its saved start/end). This is the authoritative source — the
      // employee's calendar must match Accounting, not a locally re-derived month.
      const { year, month } = pabPeriodSettings.activeMonthResolved;
      const { start, end } = pabPeriodSettings.activeRange;
      return { year, month, start, end, monthName: monthNames[month] ?? '' };
    }
    // Manual file browse: derive the PAB month from the selected file (resolving
    // canonical columns to ISO when needed), honoring that month's saved override.
    let selCols = columns;
    if (row && columns.length > 0 && columnsAreAllCanonical(columns)) {
      const resolved = resolveCanonicalColumnsToIso(row, selectedFile!);
      selCols = Object.keys(resolved);
    }
    const mergedCols = pabMergedColumns.length > 0 ? pabMergedColumns : columns;
    const ovs = pabPeriodSettings.overrides;
    const pabMonth = selCols?.length
      ? (resolvePabMonthFromColumns(selCols, ovs)
          ?? inferPabMonthFromColumns(selCols)
          ?? getCurrentPabMonth())
      : (resolvePabMonthFromColumns(mergedCols, ovs) ?? getCurrentPabMonth());
    if (!pabMonth) return null;
    const { start, end } = resolvePabRangeForMonth(pabMonth.year, pabMonth.month, ovs);
    return { ...pabMonth, start, end, monthName: monthNames[pabMonth.month] ?? '' };
  }, [pabMergedColumns, columns, row, selectedFile, manualFileSelect, pabPeriodSettings.validManualRange, pabPeriodSettings.overrides, pabPeriodSettings.activeMonthResolved, pabPeriodSettings.activeRange]);

  const fetchMyDisputes = useCallback(() => {
    if (!pabMonthRange || !email) return;
    const s = pabMonthRange.start;
    const e = pabMonthRange.end;
    const from = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
    const to = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`;
    fetch(`/api/pab-disputes?email=${encodeURIComponent(email)}&from=${from}&to=${to}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { rows: import('@/lib/supabase/pab-day-disputes').PabDayDisputeRow[] }) => {
        setMyDisputes(json.rows ?? []);
      })
      .catch(() => setMyDisputes([]));
  }, [pabMonthRange, email]);

  // TEMPORARY orphanage → PAB coverage (AUTO mode): load this employee's
  // locked-in orphanage hours (session-scoped); short weekdays inside each
  // week's coverage window are topped up to 7h automatically.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/employee/orphanage-hours', { cache: 'no-store', signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : { rows: [] }))
      .then((json: { rows?: { source_file: string | null; hours: number }[] }) => {
        const rows = json.rows ?? [];
        setOrphanageHourRows(rows);
        setOrphanageHoursIndex(
          buildOrphanageHoursIndex(
            rows.map((r) => ({ sourceFile: r.source_file, email, hours: r.hours })),
          ),
        );
      })
      .catch(() => { setOrphanageHourRows([]); setOrphanageHoursIndex(new Map()); });
    return () => ctrl.abort();
  }, [email]);

  useEffect(() => { fetchMyDisputes(); }, [fetchMyDisputes]);

  const refreshDashboard = useCallback(async () => {
    setDataError(null);
    setRefreshing(true);
    try {
      const [empRes, ratesRes, fxRes, filesRes] = await Promise.all([
        fetch(`/api/employees?email=${encodeURIComponent(email)}`, { cache: 'no-store' }),
        fetch(`/api/employee-hourly-rates?email=${encodeURIComponent(email)}`, { cache: 'no-store' }),
        fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
        fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, { cache: 'no-store' }),
      ]);

      const empJson = (await empRes.json()) as {
        employees?: {
          work_email?: string | null;
          personal_email?: string | null;
          start_date?: string | null;
          department?: string | null;
        }[];
      };
      const me = (empJson.employees ?? [])[0];
      const aliasSet = new Set<string>([email]);
      if (me) {
        const we = normEmail(me.work_email ?? '');
        const pe = normEmail(me.personal_email ?? '');
        if (we) aliasSet.add(we);
        if (pe) aliasSet.add(pe);
      }
      const aliases = [...aliasSet];
      setAliasEmails((prev) =>
        prev.length === aliases.length && prev.every((a, i) => a === aliases[i]) ? prev : aliases,
      );
      if (!me?.start_date) {
        setEmployeeStartDate(null);
      } else {
        const d = new Date(me.start_date);
        setEmployeeStartDate(Number.isNaN(d.getTime()) ? null : d);
      }

      const ratesJson = (await ratesRes.json()) as {
        rows?: EmployeeHourlyRateRow[];
        error?: string | null;
      };
      const fxJson = (await fxRes.json()) as { value: string | null };
      const filesJson = (await filesRes.json()) as { files?: string[]; error?: string | null };

      setUsdToPhpRate(effectiveUsdToPhpRateFromStored(fxJson.value));

      if (ratesJson.error) {
        if (looksLikeHtmlError(String(ratesJson.error))) {
          setEssentialsError(cleanErrorMessage(ratesJson.error));
        } else {
          setDataError(cleanErrorMessage(ratesJson.error));
        }
      }
      const myRate = (ratesJson.rows ?? [])[0];
      if (myRate) setRate(myRate);

      const files = filesJson.files ?? [];
      setSourceFiles(files);

      let nextSelected = selectedFile;
      if (nextSelected && nextSelected !== '__all__' && !files.includes(nextSelected)) {
        nextSelected = files.length > 0 ? files[0] : null;
        setSelectedFile(nextSelected);
      }

      const fileArg = nextSelected === '__all__' || nextSelected === null ? null : nextSelected;

      setFileLoading(true);
      try {
        await loadHoursData(fileArg, false, aliases);
      } finally {
        setFileLoading(false);
      }

      fetchMyDisputes();
      void fetchLiveHours();
    } catch (e) {
      setDataError(cleanErrorMessage(e, 'Failed to refresh dashboard'));
    } finally {
      setRefreshing(false);
    }
  }, [email, selectedFile, loadHoursData, fetchMyDisputes, fetchLiveHours]);

  const disputesByDate = useMemo(() => {
    const map = new Map<string, import('@/lib/supabase/pab-day-disputes').PabDayDisputeRow>();
    for (const d of myDisputes) map.set(d.dispute_date, d);
    return map;
  }, [myDisputes]);

  /** PAB calendar grid: one row per Mon–Fri work week in the PAB range. */
  const pabCalendar = useMemo<PabCalendarDay[][] | null>(() => {
    if (!pabMonthRange) return null;
    const useSelected = !!selectedFile && selectedFile !== '__all__';
    // Always use merged data for hours lookup so every week in the derived
    // PAB period is populated, regardless of which file drives the period.
    const pabRow = pabMergedRow ?? row;
    const pabCols = pabMergedColumns.length > 0 ? pabMergedColumns : columns;

    // Live Hubstaff overlay map (ISO date → seconds), built up front — also used
    // when no batch rows exist yet (e.g. a new hire's first week) so today still
    // shows live tracked time instead of a bare placeholder.
    const liveMap = new Map<string, number>();
    if (liveHours) {
      for (const [isoDate, sec] of Object.entries(liveHours.days)) {
        if (!sec || sec <= 0) continue;
        const [y, m, day] = isoDate.split('-').map(Number);
        if (!y || !m || !day) continue;
        liveMap.set(`${y}-${m}-${day}`, sec);
      }
    }

    // When we have a month range but no row/cols yet, still render empty weeks
    // (placeholders with 0h) instead of looping the skeleton forever.
    if (!pabRow || !pabCols.length) {
      const empty = buildPabCalendarWeeks(pabMonthRange.start, pabMonthRange.end, liveMap);
      if (empty.length === 0) return null;
      if (liveMap.size === 0) return [empty[0]];
      // Live data exists — show every week that has started, mirroring the trim below.
      const n = new Date();
      const tMid = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
      const started = empty.filter((week) => {
        const firstDay = week[0]?.date;
        if (!firstDay) return false;
        return new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate()).getTime() <= tMid;
      });
      return started.length > 0 ? started : [empty[0]];
    }

    // Build date → seconds lookup directly from grouped columns + raw row data.
    // We try ALL columns in each group so that canonical names ("monday") get
    // resolved via their calendar-day key even if parseColDate doesn't recognise them.
    const hoursByDateKey = new Map<string, number>();
    const dateCols = pabCols.filter(isDateCol);
    const groups = groupDateColumnsByCalendarDay(dateCols, pabCols);
    for (const group of groups) {
      // Find a parseable date from any column in the group
      let d: Date | null = null;
      for (const c of group) {
        d = parseColDate(c);
        if (d) break;
      }
      if (!d) continue;
      // Max seconds across the group
      let maxS = 0;
      for (const c of group) {
        const raw = getFieldFromRow(pabRow, [c])
          ?? (Object.prototype.hasOwnProperty.call(pabRow, c) ? pabRow[c] : undefined);
        maxS = Math.max(maxS, parseHMS(raw));
      }
      const key = pabDateKey(d);
      hoursByDateKey.set(key, Math.max(hoursByDateKey.get(key) ?? 0, maxS));
    }

    // Live Hubstaff overlay: real tracked time for the trailing window. `max` keeps
    // the uploaded batch authoritative once it lands (it may include manual edits),
    // while filling days no batch covers yet — i.e. today and the current week.
    for (const [key, sec] of liveMap) {
      hoursByDateKey.set(key, Math.max(hoursByDateKey.get(key) ?? 0, sec));
    }

    // Apply approved dispute override_hours as a SET (replaces Hubstaff hours for that day).
    // `null` override = floor-drop only (no hour change). `0` = intentional zero-out. `>0` = replace.
    // Override writes apply to the exact dispute_date only; day-after forgiveness for orphanage
    // visits happens via the synthetic disputesByDate entry below (no hours change on day+1).
    // Note: dispute_date is ISO "YYYY-MM-DD" but hoursByDateKey uses pabDateKey ("YYYY-M-D", no
    // zero-padding). Convert before writing or the override silently falls through.
    for (const d of myDisputes) {
      if (!disputeGrantsPabForgiveness(d)) continue;
      const set = d.override_hours;
      if (set == null || set < 0) continue;
      const [y, m, day] = d.dispute_date.split('-').map(Number);
      if (!y || !m || !day) continue;
      const key = `${y}-${m}-${day}`;
      hoursByDateKey.set(key, set * 3600);
    }

    // Build a set of pabDateKey strings for enabled holiday weekdays so we can
    // force passes=true after the calendar is built without touching the hours.
    const holidayKeySet = new Set<string>();
    for (const [isoDate] of usHolidayDates) {
      const [y, m, d] = isoDate.split('-').map(Number);
      if (!y || !m || !d) continue;
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 0 || dow === 6) continue;
      holidayKeySet.add(`${y}-${m}-${d}`);
    }

    const rawWeeks = buildPabCalendarWeeks(pabMonthRange.start, pabMonthRange.end, hoursByDateKey);
    // Apply holiday forgiveness: preserve actual seconds but force passes=true.
    const weeks = rawWeeks.map(week =>
      week.map(day => {
        const key = pabDateKey(day.date);
        if (!holidayKeySet.has(key)) return day;
        return { ...day, passes: true };
      }),
    );

    // Manual file selection: show the full range for that file's period.
    if (useSelected) return weeks;

    // Trim to weeks that have elapsed so far: hide future weeks with no data yet.
    // Find the latest date that actually has logged hours (>0)
    let latest: Date | null = null;
    for (const [key, secs] of hoursByDateKey) {
      if (secs <= 0) continue;
      const [y, m, d] = key.split('-').map(Number);
      if (!y || !m || !d) continue;
      const dt = new Date(y, m - 1, d);
      if (!latest || dt.getTime() > latest.getTime()) latest = dt;
    }
    const today = new Date();
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const cutoff = latest ?? todayMid;

    const trimmed = weeks.filter((week) => {
      const firstDay = week[0]?.date;
      if (!firstDay) return false;
      const weekStart = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate());
      return weekStart.getTime() <= cutoff.getTime();
    });
    return trimmed.length > 0 ? trimmed : weeks.slice(0, 1);
  }, [pabMonthRange, pabMergedRow, pabMergedColumns, row, columns, selectedFile, manualFileSelect, myDisputes, usHolidayDates, liveHours]);

  /** PAB: every expected weekday in the PAB period must be ≥ 7 h. */
  const pabWeekdayHours = pabDailyHours.filter((d) => d.weekday);
  const allPabDays = pabCalendar?.flat() ?? [];

  /**
   * TEMPORARY orphanage → PAB coverage (AUTO mode, see orphanage-pab-coverage.ts):
   * weekdays whose REAL tracked time + the orphanage hours recorded in the
   * Payroll Wizard reach 7h. Window = the hours' file week + the week before
   * (hours land one payroll run after the visit). Keys are pabDateKey format.
   * The calendar keeps the honest tracked time and renders these days as
   * forgiven; eligibility below treats them as passing.
   */
  const orphanageCoveredKeys = useMemo<Set<string>>(() => {
    const covered = new Set<string>();
    if (!orphanageHoursIndex.size || !pabCalendar) return covered;
    const secByKey = new Map<string, number>();
    for (const d of pabCalendar.flat()) secByKey.set(pabDateKey(d.date), d.seconds);
    for (const [isoDate, orphHours] of orphanageHoursByCoveredDate(orphanageHoursIndex, email)) {
      const [y, m, dd] = isoDate.split('-').map(Number);
      if (!y || !m || !dd) continue;
      const key = `${y}-${m}-${dd}`; // pabDateKey format (unpadded)
      const sec = secByKey.get(key);
      if (sec == null) continue; // date not on this calendar view
      if (sec < 7 * 3600 && orphanageCoversDay(sec, orphHours)) covered.add(key);
    }
    return covered;
  }, [orphanageHoursIndex, email, pabCalendar]);

  /**
   * TEMPORARY orphanage → PAB coverage (AUTO mode): the employee's locked-in
   * orphanage hours per pay week + any weekday in that week's coverage window
   * (file week + week before) that is STILL short of 7h after the top-up —
   * covered days already render as 7h on the calendar, so what remains short is
   * exactly what the hours could NOT rescue. Surfaced as the "Orphanage –
   * Visits" panel below the calendar.
   */
  const orphanageVisitSummary = useMemo(() => {
    const days = pabCalendar?.flat() ?? [];
    const out: { id: string; weekLabel: string; hours: number; stillShort: { label: string; workedH: number }[] }[] = [];
    for (const r of orphanageHourRows) {
      const hours = Number(r.hours);
      if (!(hours > 0) || !r.source_file) continue;
      const range = parseDateRangeFromFilename(r.source_file);
      if (!range) continue;
      const winStart = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() - 7);
      const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const stillShort = days
        .filter((d) =>
          d.date >= winStart && d.date <= range.end &&
          d.date.getDay() >= 1 && d.date.getDay() <= 5 &&
          d.hasData && !d.passes && d.seconds < 7 * 3600 &&
          // Covered days keep their real (short) hours but count as forgiven —
          // only list days the orphanage hours could NOT rescue.
          !orphanageCoveredKeys.has(pabDateKey(d.date)),
        )
        .map((d) => ({ label: fmt(d.date), workedH: Math.round((d.seconds / 3600) * 100) / 100 }));
      out.push({ id: r.source_file, weekLabel: `${fmt(range.start)} – ${fmt(range.end)}`, hours, stillShort });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }, [orphanageHourRows, pabCalendar, orphanageCoveredKeys]);

  /** Is the current PAB period still in progress? (today ≤ period end, viewing default period) */
  const isPabPeriodInProgress = useMemo(() => {
    if (!pabMonthRange) return false;
    const useSelected = !!selectedFile && selectedFile !== '__all__';
    if (useSelected) return false; // historical file — not pending
    const today = new Date();
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const endT = new Date(
      pabMonthRange.end.getFullYear(),
      pabMonthRange.end.getMonth(),
      pabMonthRange.end.getDate(),
    ).getTime();
    return t <= endT;
  }, [pabMonthRange, selectedFile, manualFileSelect]);

  /**
   * Pure calendar check — true while today falls inside the displayed PAB
   * period's Mon–end window, regardless of whether the user is viewing a
   * specific weekly file. Used for status wording ("Still in Progress" vs
   * "Not met") so the label tracks the real-world month, not the file view.
   */
  const isPabPeriodInProgressByCalendar = useMemo(() => {
    if (!pabMonthRange) return false;
    const today = new Date();
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const endT = new Date(
      pabMonthRange.end.getFullYear(),
      pabMonthRange.end.getMonth(),
      pabMonthRange.end.getDate(),
    ).getTime();
    return t <= endT;
  }, [pabMonthRange]);

  /** Elapsed weekdays where hours were logged but fell below the 7h threshold — hard disqualifications.
   *  Strictly BEFORE today: with the live Hubstaff overlay, today always carries partial
   *  hours while it's still in progress — it only counts once the day has ended. */
  const pabViolations = useMemo<PabCalendarDay[]>(() => {
    const days = pabCalendar?.flat() ?? [];
    const today = new Date();
    const todayT = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    return days.filter((d) => {
      const dT = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate()).getTime();
      return dT < todayT && d.hasData && !d.passes;
    });
  }, [pabCalendar]);

  const isPAEligible =
    !isPabPeriodInProgress && allPabDays.length > 0 &&
    // TEMP orphanage coverage: covered days count as passing (see orphanageCoveredKeys).
    allPabDays.every((d) => d.passes || orphanageCoveredKeys.has(pabDateKey(d.date)));

  const perfectAttendanceBonusStatus = useMemo<
    'eligible' | 'not_eligible' | 'pending' | 'unknown'
  >(() => {
    if (!row && !pabMergedRow) return 'unknown';
    const days = pabCalendar?.flat();
    if (!days || days.length === 0) return 'unknown';
    // Any elapsed sub-7h weekday disqualifies the whole month immediately,
    // even while the period is still in progress.
    if (pabViolations.length > 0) return 'not_eligible';
    if (isPabPeriodInProgress) return 'pending';
    return days.every((d) => d.passes) ? 'eligible' : 'not_eligible';
  }, [row, pabMergedRow, pabCalendar, isPabPeriodInProgress, pabViolations]);

  /** Number of PAB-eligible months (currently 1 month evaluated). Pending periods don't count. */
  const pabEligibleCount = isPAEligible ? 1 : 0;

  /**
   * Selected weekly file's range. Prefer parsing the filename (`..._YYYY-MM-DD_to_YYYY-MM-DD.csv`)
   * and fall back to scanning the file's date columns so non-standard filenames still work.
   */
  const selectedFileWeek = useMemo(() => {
    if (!selectedFile || selectedFile === '__all__') return null;
    const fromName = parseDateRangeFromFilename(selectedFile);
    if (fromName) return fromName;
    // Fallback: derive from the selected file's date columns.
    let earliest: Date | null = null;
    let latest: Date | null = null;
    for (const c of columns) {
      const d = parseColDate(c);
      if (!d) continue;
      if (!earliest || d.getTime() < earliest.getTime()) earliest = d;
      if (!latest || d.getTime() > latest.getTime()) latest = d;
    }
    return earliest && latest ? { start: earliest, end: latest } : null;
  }, [selectedFile, columns]);

  /** PAB month containing this file's Monday — used to gate weekly bonuses. */
  const weekPabRange = useMemo(() => {
    if (pabPeriodSettings.validManualRange) {
      const { start, end } = pabPeriodSettings.validManualRange;
      return {
        pabMonth: { year: start.getFullYear(), month: start.getMonth() },
        start,
        end,
      };
    }
    if (!selectedFileWeek) return null;
    const ws = selectedFileWeek.start;
    // The week's OWNING Monday. Hubstaff weeks start Sunday → the Monday is the next
    // day (matches non-HSL Sun–Sat and HSL Mon–Sun, which drops the leading Sunday).
    // Walking *back* from a Sunday wrongly pulled e.g. the May 31–Jun 6 week into May.
    // Mirrors `member-monthly-pay.ts` and the wizard's `weekPabMonth`.
    const dow = ws.getDay();
    const mon =
      dow === 0
        ? new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 1)
        : new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() - (dow - 1));
    const range = resolvePabRangeForMonth(mon.getFullYear(), mon.getMonth(), pabPeriodSettings.overrides);
    return { pabMonth: { year: mon.getFullYear(), month: mon.getMonth() }, start: range.start, end: range.end };
  }, [selectedFileWeek, pabPeriodSettings.validManualRange, pabPeriodSettings.overrides]);

  /**
   * When viewing a specific weekly file, PAB attaches only to the ONE week that
   * CONTAINS the PAB period end (shared gate — same rule as the Payroll Wizard,
   * which is the source of truth). The old `weekEnd >= periodEnd` check kept
   * PAB on every week after the payout week.
   */
  const isFinalPabWeekForSelected = useMemo(() => {
    if (!selectedFileWeek || !weekPabRange) return false;
    return gateIsFinalPabWeek(selectedFileWeek.start, selectedFileWeek.end, weekPabRange.end);
  }, [selectedFileWeek, weekPabRange]);

  /**
   * Total PAB bonus in PHP. Rules:
   *  - Must be eligible (period concluded with all weekdays ≥7h).
   *  - Explicit all-time view: full monthly total (reflects what already posted to the employee).
   *  - Weekly file view: only on the final week of that file's PAB month.
   *  - Otherwise (file selected but week can't be derived, or nothing selected): 0 — never
   *    fall back to showing the monthly total on an arbitrary week.
   */
  // No rates row in Supabase → US / paid externally / unseeded. Hide PH-side
  // bonuses so the dashboard doesn't advertise amounts the paystub won't pay.
  const hasRates = !!(
    rate &&
    (parseRate(rate.regular_rate) != null || parseRate(rate.ot_rate) != null)
  );

  // PAB + Tech amounts + this employee's dept eligibility (Payment Catalog).
  const myDeptKey = normalizeDeptToKey(profileForShipping.department ?? null);
  const pabBonusPhpAmt = sysBonusCfg.pab.amountPHP;
  const techBonusPhpAmt = sysBonusCfg.tech.amountPHP;
  const pabDeptOk = isDeptEligible(sysBonusCfg.pab, myDeptKey);
  const techDeptOk = isDeptEligible(sysBonusCfg.tech, myDeptKey);

  const pabBonusAmount = useMemo(() => {
    if (!hasRates) return 0;
    if (!isPAEligible) return 0;
    if (!pabDeptOk) return 0;
    if (isAllTime) return pabEligibleCount * pabBonusPhpAmt;
    if (selectedFileWeek) return isFinalPabWeekForSelected ? pabBonusPhpAmt : 0;
    return 0;
  }, [hasRates, isPAEligible, pabDeptOk, pabBonusPhpAmt, isAllTime, selectedFileWeek, isFinalPabWeekForSelected, pabEligibleCount]);

  /**
   * Tech Bonus rules:
   *  - Paid in the 3rd Mon–Sun week of the salary-date's month, where week 1 =
   *    the week CONTAINING the 1st (a partial leading week counts as week 1, so
   *    week 1's Monday may fall in the previous month); week 3 starts 14 days
   *    later. Salary Tuesday must land inside that week.
   *    (e.g. Mar 2026 → salary Tue Mar 10 paying period Mar 2–8;
   *    May 2026 → salary Tue May 12; Jul 2026 → salary Tue Jul 14 paying Jul 6–12).
   *  - Employee must have completed 30 days of service from their start_date.
   *
   *  All-time view uses the most recently dispatched pay period's salary date
   *  for the week check (and always honors the 30-day requirement); weekly
   *  view uses the selected file's pay period.
   */
  const isTechnologyBonusActive = useMemo(() => {
    // 30-day service gate — same for all views.
    if (!employeeStartDate) return false;
    const eligibleFrom = new Date(
      employeeStartDate.getFullYear(),
      employeeStartDate.getMonth(),
      employeeStartDate.getDate() + 30,
    );
    // Reference Monday of the pay-period week.
    // - Weekly view → the selected file's week start (already a Monday).
    // - All-time view → Monday of the most recently dispatched pay period
    //   (i.e. the Monday whose salary Tuesday = Mon + 8 has already arrived).
    const refMonday = (() => {
      if (selectedFileWeek) {
        const s = selectedFileWeek.start;
        return new Date(s.getFullYear(), s.getMonth(), s.getDate());
      }
      const today = new Date();
      // Most recent past Tuesday (or today if today is Tuesday).
      const dow = today.getDay(); // Sun=0..Sat=6
      const daysBackToTue = (dow - 2 + 7) % 7;
      const lastTuesday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBackToTue);
      // Salary Tuesday = pay-period Monday + 8, so Monday = lastTuesday − 8.
      return new Date(lastTuesday.getFullYear(), lastTuesday.getMonth(), lastTuesday.getDate() - 8);
    })();
    if (refMonday.getTime() < eligibleFrom.getTime()) return false;

    // Salary Date = the Tuesday after the pay-period Sunday (refMonday + 8).
    // Tech bonus fires when salary date falls in the 3rd Mon–Sun week of its
    // month — week 1 = the week containing the 1st (partial leading week counts).
    const salaryDate = new Date(refMonday.getFullYear(), refMonday.getMonth(), refMonday.getDate() + 8);
    const first = new Date(salaryDate.getFullYear(), salaryDate.getMonth(), 1);
    const dow = first.getDay();
    // Rule B: week 1 = the week CONTAINING the 1st → Monday on/before the 1st
    // (may be in the previous month). Days back to that Monday: Mon=1→0, … Sun=0→6.
    const daysBackToMon = (dow + 6) % 7;
    const firstMon = new Date(first.getFullYear(), first.getMonth(), first.getDate() - daysBackToMon);
    const thirdWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 14);
    const fourthWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 21);
    const t = salaryDate.getTime();
    return t >= thirdWeekMon.getTime() && t < fourthWeekMon.getTime();
  }, [employeeStartDate, selectedFileWeek]);

  const technologyBonusAmount = isTechnologyBonusActive && hasRates && techDeptOk ? techBonusPhpAmt : 0;

  const MESA_DEDUCTION_PHP = 100;
  const isMesaMember = !!rate?.mesa_member;
  // Auto-estimate path (no published payroll snapshot): only enrolled members are
  // charged the ₱100 contribution, and there is no disbursement to surface yet.
  const mesaDeductionAmount = isMesaMember && totalPay != null ? MESA_DEDUCTION_PHP : 0;

  // Client-side auto-estimate (initial + PAB + Tech − MESA). Used as the fallback.
  const autoTakeHomePhp =
    totalPay != null ? totalPay + pabBonusAmount + technologyBonusAmount - mesaDeductionAmount : null;
  // When the Payroll Wizard has published a final for this employee + file, that
  // exact figure is the authoritative pay (matches what accounting will pay). All-time
  // view has no single payroll final, so it always uses the auto-estimate.
  const takeHomeFromPayroll = !isAllTime && payrollFinal != null;

  // MESA contribution + emergency disbursement actually applied this run.
  //  - Published snapshot → trust the wizard's figures. It deducts the ₱100 whenever
  //    there's a disbursement OR active membership, independent of the dashboard's
  //    possibly-stale `mesa_member` flag — so this surfaces the deduction even when
  //    the rate-row flag hasn't flipped (e.g. opt-in still pending).
  //  - Snapshots written before this field exists → fall back to the membership estimate.
  //  - Auto-estimate path → membership estimate; disbursements only appear once payroll runs.
  const mesaDeductionPhp = takeHomeFromPayroll
    ? (payrollFinal!.mesaDeduction ?? mesaDeductionAmount)
    : mesaDeductionAmount;
  const mesaDisbursementPhp = takeHomeFromPayroll ? (payrollFinal!.mesaDisbursement ?? 0) : 0;

  // Headline take-home = what payroll deposits MINUS the one-off emergency payout, so a
  // disbursement reads as a separate windfall instead of silently inflating regular pay.
  const takeHomePhp = takeHomeFromPayroll
    ? payrollFinal!.final - mesaDisbursementPhp
    : autoTakeHomePhp;
  // Total cash hitting the account this run (headline + the emergency payout).
  const totalDepositedPhp = takeHomeFromPayroll
    ? payrollFinal!.final
    : (autoTakeHomePhp != null ? autoTakeHomePhp + mesaDisbursementPhp : null);

  // Whether to surface the weekly MESA contribution indicator (the "−₱100" rail row).
  // Broader than an actual per-run deduction so a member reliably sees it: a flagged
  // member, a real deduction this run, a disbursement folded in, OR an approved
  // disbursement on file — the rate-row `mesa_member` flag can lag (e.g. opt-in still
  // pending), and we don't want the contribution to silently disappear in that gap.
  const isMesaParticipant =
    isMesaMember || mesaDeductionPhp > 0 || mesaDisbursementPhp > 0 || mesaDisbursementInfo != null;
  const mesaContributionPhp = mesaDeductionPhp > 0 ? mesaDeductionPhp : MESA_DEDUCTION_PHP;

  /** True when the NEXT pay-period week (refMonday + 7) is the tech bonus week. */
  const isTechBonusNextWeek = useMemo(() => {
    if (isTechnologyBonusActive) return false;
    if (!employeeStartDate) return false;
    const eligibleFrom = new Date(
      employeeStartDate.getFullYear(),
      employeeStartDate.getMonth(),
      employeeStartDate.getDate() + 30,
    );
    const refMonday = (() => {
      if (selectedFileWeek) {
        const s = selectedFileWeek.start;
        return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7);
      }
      const today = new Date();
      const dow = today.getDay();
      const daysBackToMon = (dow + 6) % 7;
      const thisMon = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBackToMon);
      return new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() + 7);
    })();
    if (refMonday.getTime() < eligibleFrom.getTime()) return false;
    const salaryDate = new Date(refMonday.getFullYear(), refMonday.getMonth(), refMonday.getDate() + 8);
    const first = new Date(salaryDate.getFullYear(), salaryDate.getMonth(), 1);
    const dow = first.getDay();
    // Rule B: week 1 = the week CONTAINING the 1st → Monday on/before the 1st.
    const daysBackToMon = (dow + 6) % 7;
    const firstMon = new Date(first.getFullYear(), first.getMonth(), first.getDate() - daysBackToMon);
    const thirdWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 14);
    const fourthWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 21);
    const t = salaryDate.getTime();
    return t >= thirdWeekMon.getTime() && t < fourthWeekMon.getTime();
  }, [isTechnologyBonusActive, employeeStartDate, selectedFileWeek]);

  /**
   * True when the PAB month's tech bonus week is already past relative to the
   * current reference point (selected file week start, or today for all-time).
   *
   * Old approach: checked if the current file's salary date (fileStart+8) was past
   * week 4 of its own month. Bug: the May 25–31 file has salary date June 2 which
   * is NOT past June's week 4 yet → showed "Locked" even though May's tech bonus
   * was already paid. Fix: compare the reference Monday directly against the PAB
   * month's week3Mon — once we're in a week that starts after week3Mon, the bonus
   * has already been dispatched.
   */
  const isTechBonusWeekPast = useMemo(() => {
    if (isTechnologyBonusActive) return false;
    if (!employeeStartDate) return false;
    const eligibleFrom = new Date(
      employeeStartDate.getFullYear(),
      employeeStartDate.getMonth(),
      employeeStartDate.getDate() + 30,
    );
    // Reference Monday: file week start, or this week's Monday for all-time view.
    const refMonday = (() => {
      if (selectedFileWeek) {
        const s = selectedFileWeek.start;
        return new Date(s.getFullYear(), s.getMonth(), s.getDate());
      }
      const today = new Date();
      const daysBackToMon = (today.getDay() + 6) % 7;
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBackToMon);
    })();
    if (refMonday.getTime() < eligibleFrom.getTime()) return false;
    // Compute week3Mon for the PAB month (fall back to refMonday's month when no range yet).
    const yr = pabMonthRange ? pabMonthRange.start.getFullYear() : refMonday.getFullYear();
    const mo = pabMonthRange ? pabMonthRange.start.getMonth() : refMonday.getMonth();
    const first = new Date(yr, mo, 1);
    // Rule B: week 1 = the week CONTAINING the 1st → Monday on/before the 1st.
    const daysBackToMon = (first.getDay() + 6) % 7;
    const firstMon = new Date(yr, mo, 1 - daysBackToMon);
    const week3Mon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 14);
    // "Past" once the current file week starts strictly after the tech bonus week's Monday.
    return refMonday.getTime() > week3Mon.getTime();
  }, [isTechnologyBonusActive, employeeStartDate, selectedFileWeek, pabMonthRange]);

  /**
   * Calendar-anchored "tech bonus pays this week" — independent of the
   * selected file. Looks at today's Mon–Sun window: the salary Tuesday of
   * this week pays for the prior pay-period Monday (thisWeekMon − 7). If
   * that salary date is the 3rd-week tech date, return it for display.
   */
  const techBonusSalaryThisWeek = useMemo<Date | null>(() => {
    if (!employeeStartDate) return null;
    const eligibleFrom = new Date(
      employeeStartDate.getFullYear(),
      employeeStartDate.getMonth(),
      employeeStartDate.getDate() + 30,
    );
    const today = new Date();
    const dow = today.getDay();
    const daysBackToMon = (dow + 6) % 7;
    const thisWeekMon = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBackToMon);
    const payPeriodMon = new Date(thisWeekMon.getFullYear(), thisWeekMon.getMonth(), thisWeekMon.getDate() - 7);
    if (payPeriodMon.getTime() < eligibleFrom.getTime()) return null;
    const salaryDate = new Date(payPeriodMon.getFullYear(), payPeriodMon.getMonth(), payPeriodMon.getDate() + 8);
    const first = new Date(salaryDate.getFullYear(), salaryDate.getMonth(), 1);
    const fdow = first.getDay();
    // Rule B: week 1 = the week CONTAINING the 1st → Monday on/before the 1st.
    const week1Back = (fdow + 6) % 7;
    const firstMon = new Date(first.getFullYear(), first.getMonth(), first.getDate() - week1Back);
    const thirdMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 14);
    const fourthMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 21);
    const t = salaryDate.getTime();
    return t >= thirdMon.getTime() && t < fourthMon.getTime() ? salaryDate : null;
  }, [employeeStartDate]);

  /** 30-day service status for Tech Bonus eligibility (independent of week gating). */
  const techServiceStatus = useMemo<
    | { state: 'eligible'; eligibleFrom: Date }
    | { state: 'pending'; eligibleFrom: Date; daysRemaining: number }
    | { state: 'unknown' }
  >(() => {
    if (!employeeStartDate) return { state: 'unknown' };
    const eligibleFrom = new Date(
      employeeStartDate.getFullYear(),
      employeeStartDate.getMonth(),
      employeeStartDate.getDate() + 30,
    );
    const today = new Date();
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (todayMid.getTime() >= eligibleFrom.getTime()) {
      return { state: 'eligible', eligibleFrom };
    }
    const daysRemaining = Math.ceil(
      (eligibleFrom.getTime() - todayMid.getTime()) / (24 * 60 * 60 * 1000),
    );
    return { state: 'pending', eligibleFrom, daysRemaining };
  }, [employeeStartDate]);

  const maxBarSeconds = Math.max(...dailyHours.map((d) => d.seconds), 8 * 3600);

  /** Derive the ISO "YYYY-MM-DD" for a dailyHours bar row so we can check holiday map. */
  const barIsoDate = (day: DayHours): string | null => {
    // ISO column — direct hit
    if (/^\d{4}-\d{2}-\d{2}$/.test(day.col.trim())) return day.col.trim();
    // "Mon 5/25" style — parseColDate extracts the exact date; no week-start dependency
    const parsed = parseColDate(day.col);
    if (parsed) {
      return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    }
    // Bare canonical name ("monday") — iterate the file's date range to build dow→ISO
    if (!selectedFileWeek) return null;
    const datesByDow: Record<number, string> = {};
    const cur = new Date(selectedFileWeek.start.getFullYear(), selectedFileWeek.start.getMonth(), selectedFileWeek.start.getDate());
    const endT = selectedFileWeek.end.getTime();
    while (cur.getTime() <= endT) {
      datesByDow[cur.getDay()] = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
      cur.setDate(cur.getDate() + 1);
    }
    return datesByDow[day.order] ?? null;
  };

  const renderPabBonusStatusRows = () => {
    if (!row) return null;
    return (
      <>
        <div className="flex flex-col gap-2 rounded-lg border border-zinc-200/90 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/40 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex min-w-0 flex-1 gap-3">
            <div
              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                perfectAttendanceBonusStatus === 'eligible'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : perfectAttendanceBonusStatus === 'not_eligible'
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                    : perfectAttendanceBonusStatus === 'pending'
                      ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
                      : 'bg-zinc-200/80 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
              }`}
            >
              {perfectAttendanceBonusStatus === 'eligible' ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : perfectAttendanceBonusStatus === 'not_eligible' ? (
                <XCircle className="h-4 w-4" />
              ) : perfectAttendanceBonusStatus === 'pending' ? (
                <CalendarDays className="h-4 w-4" />
              ) : (
                <Info className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-zinc-900 dark:text-white">
                Monthly period Perfect Attendance Bonus ·{' '}
                {formatPHP(pabBonusPhpAmt).replace(/\.\d{2}$/, '')}
              </p>
              {pabMonthRange && (
                <p className="flex items-start gap-1 text-[10px] leading-relaxed text-indigo-600 dark:text-indigo-400">
                  <CalendarDays className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    <span className="font-semibold">
                      {pabMonthRange.monthName} {pabMonthRange.year}
                    </span>
                    {' · '}
                    <span className="font-medium">Start</span> {formatPabCalendarDate(pabMonthRange.start)}
                    {' · '}
                    <span className="font-medium">End</span> {formatPabCalendarDate(pabMonthRange.end)}
                    {' · '}
                    {pabWeekdayHours.length} Mon–Fri day{pabWeekdayHours.length !== 1 ? 's' : ''} in this PAB month
                  </span>
                </p>
              )}
              {perfectAttendanceBonusStatus === 'eligible' && (
                <p className="text-xs text-emerald-700 dark:text-emerald-400">
                  Eligible: each Mon–Fri in the PAB date range above is logged at 7 hours or more.
                </p>
              )}
              {perfectAttendanceBonusStatus === 'not_eligible' && (
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                  No longer Eligible for PAB, Try again next month
                  {pabViolations.length > 0 && (
                    <>
                      {' — '}
                      <span className="font-normal">
                        violated on{' '}
                        {pabViolations.map((v) => formatPabCalendarDate(v.date)).join(', ')}
                      </span>
                    </>
                  )}
                </p>
              )}
              {perfectAttendanceBonusStatus === 'pending' && (
                <p className="text-xs text-indigo-700 dark:text-indigo-300">
                  This PAB period is still in progress — eligibility and bonus will be finalized once all Mon–Fri days
                  have elapsed. Not yet included in the pay summary.
                </p>
              )}
              {perfectAttendanceBonusStatus === 'unknown' && (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Can&apos;t evaluate monthly PAB: need Mon–Fri daily hours in the merged Hubstaff uploads. If this
                  persists, ask your team to re-upload the CSVs.
                </p>
              )}
            </div>
          </div>
          <Badge
            variant="outline"
            className={
              perfectAttendanceBonusStatus === 'eligible'
                ? 'shrink-0 border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                : perfectAttendanceBonusStatus === 'not_eligible'
                  ? 'shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-300'
                  : perfectAttendanceBonusStatus === 'pending'
                    ? 'shrink-0 border-indigo-500/40 bg-indigo-500/10 text-indigo-800 dark:text-indigo-300'
                    : 'shrink-0 border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
            }
          >
            {perfectAttendanceBonusStatus === 'eligible'
              ? 'Eligible'
              : perfectAttendanceBonusStatus === 'not_eligible'
                ? 'Not eligible'
                : perfectAttendanceBonusStatus === 'pending'
                  ? 'In progress'
                  : 'Unknown'}
          </Badge>
        </div>

        <div
          className={`flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 ${
            techServiceStatus.state === 'pending'
              ? 'border-amber-200/80 bg-amber-50/40 dark:border-amber-900/40 dark:bg-amber-950/20'
              : 'border-zinc-200/90 bg-white/80 dark:border-zinc-800 dark:bg-zinc-900/40'
          }`}
        >
          <div className="flex min-w-0 flex-1 gap-2">
            <div
              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                techServiceStatus.state === 'pending'
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
              }`}
            >
              <Laptop className="h-4 w-4" />
            </div>
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs font-medium text-zinc-900 dark:text-white">
                Technology Bonus · {formatPHP(techBonusPhpAmt).replace(/\.\d{2}$/, '')}
              </p>
              {techServiceStatus.state === 'pending' ? (
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  Not eligible yet. You need 30 days of service before your first Tech Bonus — you&apos;ll become eligible
                  on{' '}
                  <span className="font-semibold">
                    {techServiceStatus.eligibleFrom.toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>{' '}
                  ({techServiceStatus.daysRemaining} day{techServiceStatus.daysRemaining === 1 ? '' : 's'} to go). The
                  bonus is paid on the 3rd paycheck of the month.
                </p>
              ) : techServiceStatus.state === 'eligible' ? (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  You&apos;re past your 30-day service mark. ₱1,850 is paid on the 3rd paycheck of each month to help
                  cover your technology expenses (equipment, internet).
                </p>
              ) : (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Paid on the 3rd paycheck of each month, but only after 30 days of service. Your start date isn&apos;t on
                  file yet — please contact your coordinator.
                </p>
              )}
            </div>
          </div>
          <Badge
            variant="outline"
            className={`shrink-0 ${
              techServiceStatus.state === 'pending'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:border-amber-500/30 dark:text-amber-300'
                : techServiceStatus.state === 'eligible'
                  ? 'border-sky-500/35 bg-sky-500/10 text-sky-900 dark:border-sky-500/30 dark:text-sky-300'
                  : 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400'
            }`}
          >
            {techServiceStatus.state === 'pending'
              ? `Pending · ${techServiceStatus.daysRemaining}d left`
              : techServiceStatus.state === 'eligible'
                ? 'Eligible'
                : 'Start date unknown'}
          </Badge>
        </div>
      </>
    );
  };

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="box-border flex h-full min-h-0 flex-col gap-2 overflow-y-auto overscroll-y-contain bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-3 py-2 [scrollbar-gutter:stable] sm:px-4 sm:py-3 md:px-5 lg:gap-3 lg:py-3 dark:bg-none dark:bg-[#0d1117]"
      >
        {/* Hero card — mirrors the real gradient hero (orbs, eyebrow, greeting, pay-week chip). */}
        <div className="relative shrink-0 overflow-hidden rounded-3xl border border-orange-100/80 bg-gradient-to-br from-stone-50 via-orange-50/35 to-blue-50/25 px-5 pt-5 pb-16 shadow-[0_12px_32px_-16px_rgba(255,138,76,0.12)] sm:px-6 sm:pt-6 lg:px-7 dark:border-orange-900/30 dark:from-zinc-950 dark:via-orange-950/15 dark:to-blue-950/15">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl">
            <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-orange-300/30 blur-3xl dark:bg-orange-500/15" />
            <div className="absolute -right-20 top-12 h-64 w-64 rounded-full bg-rose-300/25 blur-3xl dark:bg-rose-500/15" />
          </div>
          <div className="relative">
            <div className="flex flex-wrap items-start justify-between gap-3">
              {/* Eyebrow pill with live loading dots */}
              <div className="inline-flex items-center gap-2 self-start rounded-full border border-orange-200/80 bg-stone-50/70 px-4 py-1.5 backdrop-blur-md dark:border-orange-900/40 dark:bg-orange-950/30">
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    className="h-1.5 w-1.5 rounded-full bg-orange-400 dark:bg-orange-500"
                    animate={{ opacity: [0.25, 1, 0.25], scale: [0.75, 1, 0.75] }}
                    transition={{ duration: 1.2, delay: i * 0.2, repeat: Infinity, ease: 'easeInOut' }}
                  />
                ))}
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-orange-700/80 dark:text-orange-300/80">
                  Loading dashboard…
                </span>
              </div>
              {/* Action buttons (desktop) */}
              <div className="hidden shrink-0 items-center gap-2 lg:flex">
                <div className="h-8 w-20 animate-pulse rounded-md bg-zinc-200/80 dark:bg-zinc-800/80" />
                <div className="h-8 w-20 animate-pulse rounded-md bg-zinc-200/80 dark:bg-zinc-800/80" />
              </div>
            </div>
            {/* Greeting + accent rule + welcome body */}
            <div className="mt-3 h-7 w-56 animate-pulse rounded-md bg-zinc-200 sm:h-8 sm:w-72 dark:bg-zinc-800" />
            <div className="mt-1.5 h-[2px] w-16 rounded-full bg-gradient-to-r from-orange-500 to-rose-500 dark:from-orange-400 dark:to-rose-400" />
            <div className="mt-2 space-y-1.5">
              <div className="h-3 w-full max-w-2xl animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
              <div className="h-3 w-2/3 max-w-md animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
            </div>
            {/* Pay-week selector chip */}
            <div className="mt-3 flex w-56 max-w-full items-center gap-2.5 rounded-xl border border-orange-200/80 bg-white/80 py-1.5 pl-2 pr-3 shadow-sm backdrop-blur-md dark:border-orange-900/40 dark:bg-zinc-900/70">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-orange-100 dark:bg-orange-950/50" />
              <div className="flex-1 space-y-1">
                <div className="h-2 w-14 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                <div className="h-3 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              </div>
            </div>
          </div>
        </div>

        {/* Stat strip — overlaps the hero's bottom edge (7 cells: PAB period, hours, reg/OT, hourly, PAB, tech, MESA) */}
        <div className="relative z-10 -mt-11 mx-3 grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-2xl border border-orange-200/70 bg-orange-200/50 shadow-xl ring-1 ring-black/5 sm:mx-6 sm:grid-cols-4 lg:grid-cols-7 dark:border-orange-900/40 dark:bg-zinc-800/70 dark:shadow-2xl dark:ring-black/40">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="bg-stone-50 px-4 py-2.5 dark:bg-zinc-900">
              <div className="h-2 w-12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="mt-1.5 h-3.5 w-16 animate-pulse rounded bg-zinc-200/80 dark:bg-zinc-800/80" style={{ animationDelay: `${i * 70}ms` }} />
            </div>
          ))}
        </div>

        {/* Pay statement — estimated take-home + 4-col data ribbon (Regular / OT / PAB / Tech) */}
        <div className="mt-1 shrink-0 border-l-2 border-emerald-500/80 pl-4 lg:pl-5 dark:border-emerald-400/70">
          <div className="h-2.5 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-2 flex items-baseline gap-3">
            <div className="h-10 w-52 animate-pulse rounded-md bg-zinc-200 sm:h-12 sm:w-64 lg:h-14 lg:w-72 dark:bg-zinc-800" />
            <div className="h-4 w-24 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
          </div>
          <div className="mt-2 h-2.5 w-72 max-w-full animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
          <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-zinc-200/80 pt-4 sm:grid-cols-4 sm:gap-x-6 dark:border-zinc-800/80">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="h-2.5 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-5 w-20 animate-pulse rounded bg-zinc-200/80 dark:bg-zinc-800/80" style={{ animationDelay: `${i * 80}ms` }} />
                <div className="h-2 w-24 animate-pulse rounded bg-zinc-200/50 dark:bg-zinc-800/50" />
              </div>
            ))}
          </div>
        </div>

        {/* Daily Hours chart + PAB calendar — side-by-side on lg+ */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 pb-4 lg:flex-row lg:gap-4">
          {/* Daily Hours chart card */}
          <div className="flex min-h-[20rem] flex-1 flex-col rounded-2xl border border-orange-100/80 bg-gradient-to-br from-white to-blue-50/20 p-3 shadow-md ring-1 ring-orange-500/5 dark:border-blue-950/60 dark:from-blue-950/20 dark:to-blue-950/5 dark:ring-blue-950/30 lg:min-h-0 lg:rounded-xl lg:shadow-sm lg:ring-0">
            <div className="mb-3 h-3.5 w-36 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="flex-1 space-y-2">
              {Array.from({ length: 7 }, (_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="h-3 w-9 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-5 flex-1 animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800/70" style={{ animationDelay: `${i * 70}ms` }} />
                  <div className="h-3 w-10 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                </div>
              ))}
            </div>
          </div>
          {/* PAB Calendar card — mirrors the real card chrome (indigo gradient,
              week-number col + M/T/W/T/F headers + 5 week rows of h-10 cells) so
              it doesn't reflow when the real calendar swaps in. */}
          <div className="flex min-h-[16rem] flex-1 flex-col rounded-2xl border border-indigo-100/80 bg-gradient-to-br from-white to-indigo-50/20 p-3 ring-1 ring-indigo-500/5 dark:border-indigo-950/60 dark:from-indigo-950/20 dark:to-indigo-950/5 dark:ring-indigo-950/30 lg:min-h-0 lg:rounded-xl lg:ring-0">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="flex flex-col gap-1">
                <div className="h-3 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-2.5 w-40 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
              </div>
              <div className="h-6 w-6 shrink-0 animate-pulse rounded-md bg-indigo-100/70 dark:bg-indigo-950/40" />
            </div>
            <div className="flex flex-1 flex-col gap-0">
              <div className="mb-0.5 grid grid-cols-[1.25rem_repeat(5,1fr)] gap-0.5">
                <div />
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="mx-auto h-2 w-2.5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                ))}
              </div>
              {Array.from({ length: 5 }, (_, wi) => (
                <div key={wi} className="mb-0.5 grid grid-cols-[1.25rem_repeat(5,1fr)] items-stretch gap-0.5">
                  <div className="flex items-center justify-end">
                    <div className="h-2 w-1.5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                  {Array.from({ length: 5 }, (_, di) => (
                    <div
                      key={di}
                      className="h-10 animate-pulse rounded-md border border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900/30"
                      style={{ animationDelay: `${(wi * 5 + di) * 35}ms` }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>
    );
  }

  const _welcomeMsg = EMPLOYEE_MESSAGES[Math.floor(Date.now() / 86400000) % EMPLOYEE_MESSAGES.length]!;
  // Prefer the employee's real name (already fetched into profileForShipping)
  // so the greeting shows their actual first name, not the email local part.
  const _greeting = resolveFirstName({ name: profileForShipping.name, email });
  // Time-of-day greeting — stable "Welcome" until mounted (see greetingReady).
  const _nowHour = new Date().getHours();
  const _timeGreeting = !greetingReady
    ? 'Welcome'
    : _nowHour < 12 ? 'Good morning' : _nowHour < 18 ? 'Good afternoon' : 'Good evening';

  // Connection health for the ConnectionStatusBanner: 'stale' = we have loaded before
  // but the essentials refresh failed (show last-known + reconnecting); 'error' = the
  // very first load failed (nothing to show yet). 'ready' hides the banner.
  const connectionStatus: ResourceStatus = essentialsError
    ? lastLoadedAt != null
      ? 'stale'
      : 'error'
    : 'ready';

  return (
    <div className="box-border flex h-full min-h-0 flex-col gap-2 overflow-y-auto overscroll-y-contain bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-3 py-2 [scrollbar-gutter:stable] [@media(max-height:900px)]:gap-1.5 sm:px-4 sm:py-3 md:px-5 lg:gap-3 lg:py-3 dark:bg-none dark:bg-[#0d1117]">
      {(connectionStatus === 'stale' || connectionStatus === 'error') && (
        <ConnectionStatusBanner
          status={connectionStatus}
          lastUpdatedAt={lastLoadedAt}
          error={essentialsError}
          onRetry={() => setReloadKey((k) => k + 1)}
          className="mb-1 shrink-0"
        />
      )}
      {/* ── Hero intro card — soft gradient hero, matching the Accounting view ── */}
      <motion.header
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className={`relative shrink-0 rounded-3xl border border-orange-100/80 bg-gradient-to-br from-stone-50 via-orange-50/35 to-blue-50/25 px-5 pt-5 pb-16 shadow-[0_12px_32px_-16px_rgba(255,138,76,0.12)] sm:px-6 sm:pt-6 lg:px-7 dark:border-orange-900/30 dark:from-zinc-950 dark:via-orange-950/15 dark:to-blue-950/15 ${sourceMenuOpen ? 'z-30' : ''}`}
      >
        {/* Decorative orbs — pure dopamine */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.9 }}
            className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-orange-300/30 blur-3xl dark:bg-orange-500/15"
          />
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.1, delay: 0.1 }}
            className="absolute -right-20 top-12 h-64 w-64 rounded-full bg-rose-300/25 blur-3xl dark:bg-rose-500/15"
          />
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.3, delay: 0.2 }}
            className="absolute bottom-0 left-1/3 h-56 w-56 rounded-full bg-blue-300/20 blur-3xl dark:bg-blue-500/15"
          />
        </div>

        <div className="relative">
          {/* Eyebrow + actions row — absorbed from the old Overview header */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="inline-flex items-center gap-2 self-start rounded-full border border-orange-200/80 bg-stone-50/70 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-orange-700 backdrop-blur-md dark:border-orange-900/40 dark:bg-orange-950/30 dark:text-orange-300">
              <Sparkles className="h-3 w-3 shrink-0" />
              Employee
              {pabMonthRange ? (
                <>
                  <span className="mx-0.5 text-orange-400/70 dark:text-orange-500/50">/</span>
                  {pabMonthRange.monthName} {pabMonthRange.year}
                </>
              ) : null}
            </div>
            {/* Mobile action buttons */}
            <div className="flex shrink-0 items-center gap-1.5 lg:hidden">
              {giftState.status !== 'none' && (
                <GiftBellButton
                  state={giftState}
                  onClick={() => setGiftDialogOpen(true)}
                />
              )}
              {onNavigateToNotifications && (
                <NotificationBellButton
                  unreadCount={unreadNotifications}
                  onClick={onNavigateToNotifications}
                />
              )}
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 rounded-full border-zinc-200 bg-white/90 text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-300"
                title="PAB rules, bonuses & pay snapshot"
                aria-label="Open PAB and bonus help"
                onClick={() => setMobileHelpOpen(true)}
              >
                <CircleHelp className="size-4.5" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 rounded-full border-zinc-200 bg-white/90 dark:border-zinc-800 dark:bg-zinc-900/70"
                disabled={refreshing}
                onClick={() => void refreshDashboard()}
                aria-label="Refresh dashboard data"
              >
                {refreshing ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="size-4" aria-hidden />
                )}
              </Button>
            </div>
            {/* Desktop action buttons */}
            <div className="hidden shrink-0 items-center gap-2 lg:flex">
              {giftState.status !== 'none' && (
                <GiftBellButton state={giftState} onClick={() => setGiftDialogOpen(true)} />
              )}
              {onNavigateToNotifications && (
                <NotificationBellButton
                  unreadCount={unreadNotifications}
                  onClick={onNavigateToNotifications}
                />
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-zinc-200 bg-white/70 text-xs font-medium text-zinc-700 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:border-zinc-700"
                disabled={refreshing}
                onClick={() => void refreshDashboard()}
                aria-label="Refresh dashboard data"
              >
                {refreshing ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="size-3.5" aria-hidden />
                )}
                Refresh
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-zinc-200 bg-white/70 text-xs font-medium text-zinc-700 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:border-zinc-700"
                title="PAB rules, bonuses & pay snapshot — click to read"
                aria-label="Open PAB and bonus help"
                onClick={() => setMobileHelpOpen(true)}
              >
                <CircleHelp className="size-3.5" aria-hidden />
                Details
              </Button>
            </div>
          </div>

          <h1 className="mt-3 text-balance text-xl font-semibold tracking-tight text-zinc-700 sm:text-2xl dark:text-zinc-200">
            {_greeting ? (
              <>
                {_timeGreeting},{' '}
                <span className="bg-gradient-to-r from-orange-600 to-rose-500 bg-clip-text font-semibold text-transparent dark:from-orange-400 dark:to-rose-400">
                  {_greeting}
                </span>
                .
              </>
            ) : (
              <>{_timeGreeting}.</>
            )}
          </h1>
          {/* Accent rule — orange→rose hairline under the greeting */}
          <div className="mt-1.5 h-[2px] w-16 rounded-full bg-gradient-to-r from-orange-500 to-rose-500 dark:from-orange-400 dark:to-rose-400" />
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            {_welcomeMsg.body}
          </p>

          {/* Pay-week selector — which weekly Hubstaff upload drives the numbers above */}
          {sourceFiles.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div ref={sourceMenuRef} className="relative inline-block max-w-full">
              <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={sourceMenuOpen}
                onClick={() => setSourceMenuOpen((o) => !o)}
                className="group flex max-w-full items-center gap-2.5 rounded-xl border border-orange-200/80 bg-white/80 py-1.5 pl-2 pr-3 text-left shadow-sm backdrop-blur-md transition-colors hover:border-orange-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/40 dark:border-orange-900/40 dark:bg-zinc-900/70 dark:hover:border-orange-800/70"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-100 to-amber-100 text-orange-600 dark:from-orange-950/60 dark:to-amber-950/40 dark:text-orange-300">
                  <CalendarDays className="h-4 w-4" aria-hidden />
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-orange-600/80 dark:text-orange-400/80">
                    Pay Week
                  </span>
                  <span className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
                    {selectedFile === null || selectedFile === '__all__'
                      ? 'All time · combined'
                      : formatSourceFileLabel(selectedFile)}
                  </span>
                </span>
                {fileLoading ? (
                  <Loader2 className="ml-0.5 h-4 w-4 shrink-0 animate-spin text-orange-500" aria-hidden />
                ) : (
                  <ChevronDown
                    className={`ml-0.5 h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-200 dark:text-zinc-500 ${sourceMenuOpen ? 'rotate-180' : ''}`}
                    aria-hidden
                  />
                )}
              </button>
              {sourceMenuOpen && (
                <motion.div
                  role="listbox"
                  initial={{ opacity: 0, y: -4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  style={{ transformOrigin: 'top' }}
                  className="absolute left-0 top-full z-30 mt-2 max-h-[15rem] w-[17rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-xl ring-1 ring-black/5 dark:border-zinc-700 dark:bg-zinc-900 dark:ring-black/40"
                >
                  <div className="px-2.5 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
                    Select a pay week
                  </div>
                  {[{ value: '__all__', label: 'All time · combined', latest: false }, ...[...sourceFiles].sort((a, b) => {
                    const da = parseDateRangeFromFilename(a)?.start ?? new Date(0);
                    const db = parseDateRangeFromFilename(b)?.start ?? new Date(0);
                    return db.getTime() - da.getTime();
                  }).map((file, i) => ({
                    value: file,
                    label: formatSourceFileLabel(file),
                    latest: i === 0,
                  }))].map((opt) => {
                    const isSel = (opt.value === '__all__' && (selectedFile === null || selectedFile === '__all__'))
                      || opt.value === selectedFile;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="option"
                        aria-selected={isSel}
                        onClick={() => {
                          setSelectedFile(opt.value);
                          setManualFileSelect(true);
                          setSourceMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors ${isSel ? 'bg-orange-50 font-medium text-orange-700 dark:bg-orange-950/40 dark:text-orange-300' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/70'}`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{opt.label}</span>
                          {opt.latest && (
                            <span className="shrink-0 rounded-full bg-orange-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-orange-600 dark:bg-orange-950/50 dark:text-orange-300">
                              Latest
                            </span>
                          )}
                        </span>
                        {isSel && <CheckCircle2 className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" aria-hidden />}
                      </button>
                    );
                  })}
                </motion.div>
              )}
              </div>
              {/* Open the emailed pay statement for the selected paid week */}
              {(() => {
                const canOpen =
                  selectedFile != null &&
                  selectedFile !== '__all__' &&
                  paidPaystubWeeks.has(selectedFile);
                return (
                  <button
                    type="button"
                    disabled={!canOpen}
                    onClick={() => selectedFile && setPaystubModalFile(selectedFile)}
                    title={canOpen ? 'Open your pay statement for this week' : 'Available once your pay for this week has been sent'}
                    className="group inline-flex shrink-0 items-center gap-2 rounded-xl border border-emerald-200/80 bg-white/80 py-1.5 pl-2 pr-3.5 text-left text-[13px] font-medium text-emerald-700 shadow-sm backdrop-blur-md transition-colors hover:border-emerald-300 hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-900/40 dark:bg-zinc-900/70 dark:text-emerald-300 dark:hover:border-emerald-800/70 dark:hover:bg-emerald-950/30"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-100 to-teal-100 text-emerald-600 dark:from-emerald-950/60 dark:to-teal-950/40 dark:text-emerald-300">
                      <Receipt className="h-4 w-4" aria-hidden />
                    </span>
                    Open Paystubs
                  </button>
                );
              })()}
            </div>
          )}
        </div>
      </motion.header>

      {/* Live stat strip — overlaps the hero's bottom edge: pay period, hours, rates, bonus status */}
      {row && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
          className="relative z-10 -mt-11 mx-3 grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-2xl border border-orange-200/70 bg-orange-200/50 shadow-xl ring-1 ring-black/5 sm:mx-6 sm:grid-cols-4 lg:grid-cols-7 dark:border-orange-900/40 dark:bg-zinc-800/70 dark:shadow-2xl dark:ring-black/40"
        >
          {pabMonthRange && (
            <div className="bg-stone-50 px-4 py-2.5 dark:bg-zinc-900">
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-orange-600/90 dark:text-orange-400/90">PAB Period</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                {pabMonthRange.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                <span className="mx-1 text-zinc-300 dark:text-zinc-600">–</span>
                {pabMonthRange.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </div>
            </div>
          )}
          <div className="bg-stone-50 px-4 py-2.5 dark:bg-zinc-900">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">Hours</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-900 dark:text-white">{totalHours.toFixed(2)}<span className="text-zinc-400">h</span></div>
          </div>
          <div className="bg-stone-50 px-4 py-2.5 dark:bg-zinc-900">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">Reg / OT</div>
            <div className="mt-0.5 text-sm tabular-nums text-zinc-700 dark:text-zinc-300">{regularHours.toFixed(1)}<span className="text-zinc-400">h</span> <span className="text-zinc-300 dark:text-zinc-700">/</span> {otHours.toFixed(1)}<span className="text-zinc-400">h</span></div>
          </div>
          <div className="bg-stone-50 px-4 py-2.5 dark:bg-zinc-900">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">Hourly</div>
            <div className="mt-0.5 text-sm tabular-nums text-zinc-700 dark:text-zinc-300">{regularRate != null ? formatPHP(regularRate) : '—'}</div>
          </div>
          <div className="bg-stone-50 px-4 py-2.5 dark:bg-zinc-900">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-indigo-600 dark:text-indigo-400">PAB</div>
            <div className="mt-0.5">
              {pabMergeLoading ? (
                <span className="text-[12px] font-medium text-zinc-400 dark:text-zinc-500">Loading…</span>
              ) : (
                <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${
                  perfectAttendanceBonusStatus === 'eligible'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : perfectAttendanceBonusStatus === 'pending'
                      ? 'text-indigo-700 dark:text-indigo-300'
                      : perfectAttendanceBonusStatus === 'not_eligible'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-zinc-500 dark:text-zinc-500'
                }`}>
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                    perfectAttendanceBonusStatus === 'eligible'
                      ? 'bg-emerald-500'
                      : perfectAttendanceBonusStatus === 'pending'
                        ? 'bg-indigo-500 animate-pulse'
                        : perfectAttendanceBonusStatus === 'not_eligible'
                          ? 'bg-amber-500'
                          : 'bg-zinc-400'
                  }`} />
                  {perfectAttendanceBonusStatus === 'eligible'
                    ? 'Eligible'
                    : perfectAttendanceBonusStatus === 'pending'
                      ? 'In progress'
                      : perfectAttendanceBonusStatus === 'not_eligible'
                        ? (isPabPeriodInProgressByCalendar ? 'In Progress' : 'Not met')
                        : 'Unknown'}
                </span>
              )}
            </div>
          </div>
          <div className="bg-stone-50 px-4 py-2.5 dark:bg-zinc-900">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-sky-600 dark:text-sky-400">Tech</div>
            <div className="mt-0.5">
              {loading || pabMergeLoading ? (
                <span className="text-[12px] font-medium text-zinc-400 dark:text-zinc-500">Loading…</span>
              ) : (
                <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${
                  isTechnologyBonusActive
                    ? 'text-sky-700 dark:text-sky-300'
                    : techServiceStatus.state === 'pending'
                      ? 'text-amber-700 dark:text-amber-400'
                      : techBonusSalaryThisWeek
                        ? 'text-sky-700 dark:text-sky-300'
                        : isTechBonusNextWeek
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : isTechBonusWeekPast
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-zinc-500 dark:text-zinc-500'
                }`}>
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                    isTechnologyBonusActive
                      ? 'bg-sky-500'
                      : techServiceStatus.state === 'pending'
                        ? 'bg-amber-500'
                        : techBonusSalaryThisWeek
                          ? 'bg-sky-500'
                          : isTechBonusNextWeek
                            ? 'bg-emerald-500'
                            : isTechBonusWeekPast
                              ? 'bg-emerald-500'
                              : 'bg-zinc-400'
                  }`} />
                  {isTechnologyBonusActive
                    ? 'Unlocked'
                    : techServiceStatus.state === 'pending'
                      ? `${techServiceStatus.daysRemaining}d to go`
                      : techBonusSalaryThisWeek
                        ? 'Paid this Week'
                        : isTechBonusNextWeek
                          ? 'Next Week'
                          : isTechBonusWeekPast
                            ? 'Paid'
                            : 'Locked'}
                </span>
              )}
            </div>
          </div>
          {isMesaParticipant ? (
            <div className="bg-teal-50/70 px-4 py-2.5 dark:bg-teal-950/30">
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-teal-700/80 dark:text-teal-500/80">MESA</div>
              <div className="mt-0.5 text-sm font-medium tabular-nums text-teal-800 dark:text-teal-300">−{formatPHP(mesaContributionPhp)}</div>
            </div>
          ) : (
            <div className="hidden bg-stone-50 lg:block dark:bg-zinc-900" aria-hidden />
          )}
        </motion.div>
      )}

      {/* Profile setup nudge — photo, payout, and Skill Sets. Hidden when complete. */}
      {onNavigateToProfile && (
        <ProfileCompletionCard
          needsPhoto={needsPhoto}
          needsBank={needsBank}
          needsSkillSet={needsSkillSet}
          onGoToProfile={onNavigateToProfile}
        />
      )}

      {/* One-off special transfers sent from the People tab (hidden when none). */}
      <EmployeeSpecialTransfers employeeEmail={employeeEmail} />

      {/* Gift Tracker — 6-month milestone shipping form notification.
          Externally controlled so the header bell icon can also open the modal. */}
      <GiftShippingCard
        personalEmail={profileForShipping.personalEmail ?? email}
        startDate={employeeStartDate}
        prefill={{
          name: profileForShipping.name,
          workEmail: profileForShipping.workEmail,
          department: profileForShipping.department,
        }}
        dialogOpen={giftDialogOpen}
        onDialogOpenChange={setGiftDialogOpen}
        onStateChange={setGiftState}
      />

      <div className="flex min-w-0 flex-col gap-2 overflow-x-clip pb-2 lg:min-h-0 lg:grow lg:gap-3">
      {dataError && (
        <Card className="shrink-0 border-red-200 bg-red-50/50 dark:border-red-500/20 dark:bg-red-950/20">
          <CardContent className="flex items-center gap-3 py-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-800 dark:text-red-300">{cleanErrorMessage(dataError)}</p>
          </CardContent>
        </Card>
      )}

      {!row && !dataError && !fileLoading ? (
        <Card className="min-h-0 flex-1 overflow-y-auto border-amber-200 bg-amber-50/50 dark:border-amber-500/20 dark:bg-amber-950/20">
          <CardContent className="flex items-center gap-3 py-4 sm:py-6">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              No hours data found for <span className="font-mono font-medium">{email}</span>. Your hours will appear
              here once your manager uploads Hubstaff data. Use the same work email as in Hubstaff, or
              ensure your email is listed under Work Email or Personal Email in hourly rates.
            </p>
          </CardContent>
        </Card>
      ) : !row ? null : (
        <div className="flex shrink-0 flex-col gap-3 lg:min-h-0 lg:grow lg:gap-4">
          {/* Pay statement — the estimated take-home figure with its per-line breakdown ribbon (stat rail moved to the hero card) */}
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="shrink-0"
          >
            {/* Hero pay block */}
            <div className="relative min-w-0 border-l-2 border-emerald-500/80 pl-4 lg:pl-5 dark:border-emerald-400/70">
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
                Estimated Take-Home
              </p>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {totalPay != null ? (
                  <HiddenValue
                    revealed={payValuesRevealed}
                    className="flex-wrap items-baseline gap-x-3 gap-y-1"
                    mask={
                      <>
                        <span className="break-words text-[2.25rem] font-bold tabular-nums leading-none tracking-tight text-zinc-400 sm:text-4xl lg:text-5xl dark:text-zinc-600">
                          ₱•••••••••
                        </span>
                        <span className="text-xs tabular-nums text-zinc-400 sm:text-sm dark:text-zinc-600">
                          ≈ $••••• USD
                        </span>
                      </>
                    }
                  >
                    {(pabMergeLoading || perfectAttendanceBonusStatus === 'pending') ? (
                      <span className="flex items-baseline gap-3">
                        <span className="inline-block h-10 w-52 animate-pulse rounded-md bg-zinc-200 sm:h-12 sm:w-64 lg:h-14 lg:w-72 dark:bg-zinc-800" />
                        <span className="inline-block h-4 w-24 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                      </span>
                    ) : (
                      <>
                        <span
                          className="break-words text-[2.25rem] font-bold tabular-nums leading-none tracking-tight text-zinc-900 sm:text-4xl lg:text-5xl dark:text-white"
                          title={takeHomeFromPayroll ? 'Final pay confirmed by payroll' : formatPHP(takeHomePhp ?? 0)}
                        >
                          {formatPHP(takeHomePhp ?? 0)}
                        </span>
                        <span className="text-xs tabular-nums text-zinc-500 sm:text-sm dark:text-zinc-500">
                          ≈ ${(((takeHomePhp ?? 0)) / usdToPhpRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                        </span>
                      </>
                    )}
                  </HiddenValue>
                ) : (
                  <span className="break-words text-[2.25rem] font-bold tabular-nums leading-none tracking-tight text-zinc-900 sm:text-4xl lg:text-5xl dark:text-white">
                    —
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                  {totalPay != null
                    ? `${isAllTime ? 'All uploads · combined' : 'Selected upload'}${pabMonthRange ? ` · PAB ${pabMonthRange.monthName} ${pabMonthRange.year}` : ''} · FX ${formatPHP(usdToPhpRate)}/USD`
                    : 'Pending rate assignment — your hourly rate has not been set yet.'}
                </p>
                {totalPay != null && (
                  <button
                    type="button"
                    onClick={() => setPayValuesRevealed(!payValuesRevealed)}
                    aria-pressed={payValuesRevealed}
                    aria-label={payValuesRevealed ? 'Hide pay amounts' : 'Reveal pay amounts'}
                    title={payValuesRevealed ? 'Hide pay amounts' : 'Reveal pay amounts'}
                    className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    {payValuesRevealed ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
                  </button>
                )}
              </div>

              {/* Data ribbon */}
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-zinc-200/80 pt-3 sm:grid-cols-4 sm:gap-x-6 dark:border-zinc-800/80">
                <div className="min-w-0">
                  <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                    Regular
                  </dt>
                  <dd
                    className="mt-1 break-words text-base font-medium tabular-nums leading-tight text-zinc-900 sm:text-lg dark:text-white"
                    title={regularPay != null ? formatPHP(regularPay) : undefined}
                  >
                    {regularPay != null ? (
                      <HiddenValue
                        revealed={payValuesRevealed}
                        mask={<span className="text-zinc-400 dark:text-zinc-600">₱••••••••</span>}
                      >
                        {formatPHP(regularPay)}
                      </HiddenValue>
                    ) : (
                      '—'
                    )}
                  </dd>
                  <p className="mt-0.5 text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                    {regularHours.toFixed(2)}h
                    {regularRate != null ? ` · ${formatPHP(regularRate)}/h` : ''}
                  </p>
                </div>
                <div className="min-w-0">
                  <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                    Overtime
                  </dt>
                  <dd
                    className="mt-1 break-words text-base font-medium tabular-nums leading-tight text-zinc-900 sm:text-lg dark:text-white"
                    title={otPay != null ? formatPHP(otPay) : undefined}
                  >
                    {otPay != null ? (
                      <HiddenValue
                        revealed={payValuesRevealed}
                        mask={<span className="text-zinc-400 dark:text-zinc-600">₱••••••••</span>}
                      >
                        {formatPHP(otPay)}
                      </HiddenValue>
                    ) : otHours > 0 ? (
                      '—'
                    ) : (
                      <HiddenValue
                        revealed={payValuesRevealed}
                        mask={<span className="text-zinc-400 dark:text-zinc-600">₱••••</span>}
                      >
                        {formatPHP(0)}
                      </HiddenValue>
                    )}
                  </dd>
                  <p className="mt-0.5 text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                    {otHours > 0
                      ? `${otHours.toFixed(2)}h${otRate != null ? ` · ${formatPHP(otRate)}/h` : ''}`
                      : 'No overtime'}
                  </p>
                </div>
                <div className="min-w-0">
                  <dt className={`text-[10px] font-medium uppercase tracking-[0.14em] ${pabBonusAmount > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-zinc-500 dark:text-zinc-500'}`}>
                    PAB Bonus
                  </dt>
                  <dd
                    className={`mt-1 break-words text-base font-medium tabular-nums leading-tight sm:text-lg ${
                      pabBonusAmount > 0
                        ? 'text-indigo-700 dark:text-indigo-300'
                        : perfectAttendanceBonusStatus === 'pending'
                          ? 'text-indigo-500/80 dark:text-indigo-400/70'
                          : 'text-zinc-400 dark:text-zinc-600'
                    }`}
                  >
                    {perfectAttendanceBonusStatus === 'pending'
                      ? 'Pending'
                      : pabBonusAmount > 0
                        ? <span className="pab-shine-text font-semibold">{`+${formatPHP(pabBonusAmount)}`}</span>
                        : formatPHP(0)}
                  </dd>
                  <p className="mt-0.5 text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                    {perfectAttendanceBonusStatus === 'pending'
                      ? 'Period in progress'
                      : isAllTime
                        ? pabEligibleCount > 0
                          ? `${pabEligibleCount} month${pabEligibleCount !== 1 ? 's' : ''} eligible`
                          : 'Not eligible'
                        : isPAEligible
                          ? 'Eligible this month'
                          : perfectAttendanceBonusStatus === 'unknown'
                            ? 'Pending data'
                            : 'Not eligible'}
                  </p>
                </div>
                <div className="min-w-0">
                  <dt className={`text-[10px] font-medium uppercase tracking-[0.14em] ${technologyBonusAmount > 0 ? 'text-sky-600 dark:text-sky-400' : 'text-zinc-500 dark:text-zinc-500'}`}>
                    Tech Bonus
                  </dt>
                  <dd
                    className={`mt-1 break-words text-base font-medium tabular-nums leading-tight sm:text-lg ${
                      technologyBonusAmount > 0 ? 'text-sky-700 dark:text-sky-300' : 'text-zinc-400 dark:text-zinc-600'
                    }`}
                  >
                    {technologyBonusAmount > 0 ? `+${formatPHP(technologyBonusAmount)}` : formatPHP(0)}
                  </dd>
                  <p
                    className="mt-0.5 cursor-help text-[10px] tabular-nums text-zinc-400 underline decoration-dotted underline-offset-2 dark:text-zinc-500"
                    title="Eligible after 30 days of service — paid on the 3rd paycheck of each month."
                  >
                    {isTechnologyBonusActive ? 'Unlocked' : 'Locked'}
                  </p>
                </div>
              </dl>
            </div>
          </motion.section>

          {/* MESA emergency disbursement — surfaced as its own payout so it never silently
              inflates the headline take-home. The amount is the wizard's authoritative
              figure (folded into payroll's final); the reason is best-effort context from
              the employee's own approved request. */}
          {mesaDisbursementPhp > 0 && (
            <Card className="shrink-0 overflow-hidden border-teal-200/80 bg-teal-50/30 dark:border-teal-900/40 dark:bg-teal-950/20">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm text-teal-800 dark:text-teal-300">
                  <Sparkles className="h-4 w-4 text-teal-500" /> MESA emergency payout
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-[13px]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-zinc-800 dark:text-zinc-100">Emergency disbursement</div>
                    {(mesaDisbursementInfo?.reason || mesaDisbursementInfo?.explanation) && (
                      <div className="mt-0.5 break-words text-[11px] text-zinc-500 dark:text-zinc-400">
                        {mesaDisbursementInfo?.reason}
                        {mesaDisbursementInfo?.reason && mesaDisbursementInfo?.explanation ? ' · ' : ''}
                        {mesaDisbursementInfo?.explanation}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums text-teal-700 dark:text-teal-300">
                    +{formatPHP(mesaDisbursementPhp)}
                  </span>
                </div>
                {mesaDeductionPhp > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-600 dark:text-zinc-300">Weekly contribution</span>
                    <span className="shrink-0 tabular-nums text-teal-700 dark:text-teal-300">−{formatPHP(mesaDeductionPhp)}</span>
                  </div>
                )}
                <div className="my-1 h-px bg-teal-200/70 dark:bg-teal-900/50" />
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-zinc-900 dark:text-white">Total deposited this run</span>
                  <span className="shrink-0 text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {totalDepositedPhp != null ? formatPHP(totalDepositedPhp) : '—'}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                  The take-home above is your regular pay only. This one-time MESA payout is added on top when payroll runs.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Daily Hours + PAB Calendar — fills remaining vertical space; side-by-side on lg+, stacked below */}
          <div className="flex shrink-0 flex-col gap-3 lg:min-h-0 lg:grow lg:flex-row lg:items-stretch lg:gap-3 xl:gap-4">
            {/* Daily Hours Bar Chart — always visible. On mobile we grow the
                card so all 7 weekday rows fit without an inner scroll. */}
            <Card
              size="sm"
              className="flex min-h-[22rem] flex-1 flex-col rounded-2xl border-orange-100/80 bg-gradient-to-br from-white to-blue-50/20 shadow-md ring-1 ring-orange-500/5 dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 dark:ring-blue-950/30 sm:min-h-[20rem] lg:min-h-[20rem] lg:rounded-xl lg:shadow-sm lg:ring-0"
            >
              <CardHeader className="shrink-0 px-4 pb-2 pt-3 max-lg:px-4 max-lg:pt-3.5 lg:px-3 lg:pb-1.5 lg:pt-2">
                <CardTitle className="text-sm font-semibold tracking-tight text-zinc-700 lg:text-xs lg:font-medium lg:tracking-normal dark:text-zinc-300 dark:lg:text-zinc-400">
                  Daily Hours Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-0 max-lg:px-4 max-lg:pb-4 lg:px-3 lg:pb-3">
                {dailyHours.length === 0 ? (
                  <div className="flex flex-1 items-center gap-2 py-8 text-sm text-zinc-500">
                    <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
                    Daily breakdown not available
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col gap-0">
                    <div className="flex-1 space-y-1.5 overflow-x-clip pr-0.5 sm:space-y-2 lg:flex lg:flex-col lg:justify-between lg:space-y-1.5 lg:pr-2">
                    {dailyHours.map((day) => {
                      const hours = day.seconds / 3600;
                      const pct = maxBarSeconds > 0 ? (day.seconds / maxBarSeconds) * 100 : 0;
                      const iso = barIsoDate(day);
                      const holidayLabel = iso ? (usHolidayDates.get(iso) ?? null) : null;
                      const isHolidayBar = !!holidayLabel && day.weekday;
                      const meetsPA = day.weekday && day.seconds >= 7 * 3600 && !isHolidayBar;
                      const belowPA = day.weekday && day.seconds > 0 && day.seconds < 7 * 3600 && !isHolidayBar;
                      const showHoursInBar = pct >= 18 && hours > 0.5;
                      return (
                        <div
                          key={day.col}
                          className="group flex min-w-0 -mx-1 items-center gap-2 rounded-lg px-1 transition-all duration-300 ease-out hover:-translate-y-px hover:bg-orange-50/50 sm:gap-2.5 lg:gap-2 dark:hover:bg-orange-950/20"
                        >
                          <span
                            className={`w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums leading-none sm:w-[2.5rem] sm:text-xs lg:w-10 lg:text-xs lg:font-medium ${
                              isHolidayBar
                                ? 'text-sky-600 dark:text-sky-400'
                                : day.weekday
                                  ? 'text-zinc-800 dark:text-zinc-200'
                                  : 'text-zinc-400 dark:text-zinc-600'
                            }`}
                          >
                            {day.label}
                          </span>
                          <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-zinc-100 transition-shadow duration-300 ease-out group-hover:shadow-sm group-hover:ring-1 group-hover:ring-orange-300/40 dark:bg-zinc-800/60 dark:group-hover:ring-orange-500/25 sm:h-8 sm:rounded-lg lg:h-7 lg:rounded-md">
                            <div
                              className={`absolute inset-y-0 left-0 rounded-lg transition-all duration-500 ease-out group-hover:brightness-110 lg:rounded-md ${
                                isHolidayBar
                                  ? 'bg-gradient-to-r from-sky-400 to-sky-500 dark:from-sky-500 dark:to-sky-600'
                                  : meetsPA
                                    ? 'bg-gradient-to-r from-emerald-400 to-emerald-500 dark:from-emerald-500 dark:to-emerald-600'
                                    : belowPA
                                      ? 'bg-gradient-to-r from-amber-400 to-amber-500 dark:from-amber-500 dark:to-amber-600'
                                      : day.weekday
                                        ? 'bg-gradient-to-r from-orange-400 to-orange-500 dark:from-orange-500 dark:to-orange-600'
                                        : 'bg-gradient-to-r from-zinc-300 to-zinc-400 dark:from-zinc-600 dark:to-zinc-700'
                              }`}
                              style={{ width: `${Math.max(pct, day.seconds > 0 ? 2 : 0)}%` }}
                            />
                            {/* Holiday watermark — always visible across the full bar track */}
                            {isHolidayBar && (
                              <span className="pointer-events-none absolute inset-0 flex items-center justify-end pr-2 text-[9px] font-semibold uppercase tracking-widest text-sky-400/70 dark:text-sky-300/50 lg:text-[8px]">
                                {holidayLabel}
                              </span>
                            )}
                            {day.weekday && !isHolidayBar && (
                              <div
                                className="absolute inset-y-0 w-px bg-red-400/50 dark:bg-red-500/50"
                                style={{ left: `${(7 * 3600 / maxBarSeconds) * 100}%` }}
                                title="7h PAB threshold"
                              />
                            )}
                            {showHoursInBar ? (
                              <span className="pointer-events-none absolute inset-y-0 left-2 flex max-w-[calc(100%-0.5rem)] items-center truncate text-xs font-semibold text-white drop-shadow-md lg:left-2 lg:text-[11px] lg:font-medium">
                                {`${hours.toFixed(1)}h`}
                              </span>
                            ) : null}
                          </div>
                          <span className="w-[3.5rem] shrink-0 text-right text-[11px] font-medium tabular-nums text-zinc-600 transition-colors duration-300 group-hover:text-zinc-900 sm:w-[4.25rem] sm:text-xs lg:w-14 lg:text-[10px] lg:font-normal dark:text-zinc-400 dark:group-hover:text-zinc-100">
                            {secondsToDisplay(day.seconds)}
                          </span>
                        </div>
                      );
                    })}
                    </div>
                    <div className="mt-4 grid shrink-0 grid-cols-2 gap-x-4 gap-y-2.5 border-t border-zinc-200/90 pt-3 text-[10px] leading-snug text-zinc-600 dark:border-zinc-800 dark:text-zinc-500 sm:flex sm:flex-wrap sm:justify-center sm:gap-x-5 sm:gap-y-1 sm:text-[10px] lg:mt-2 lg:justify-start lg:gap-x-3 lg:pt-2 lg:text-[9px] dark:lg:text-zinc-600">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500 lg:h-1.5 lg:w-1.5" />{' '}
                        <span>≥ 7h (PA)</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500 lg:h-1.5 lg:w-1.5" />{' '}
                        <span>&lt; 7h</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-600 lg:h-1.5 lg:w-1.5" />{' '}
                        <span>Weekend</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-sky-400 lg:h-1.5 lg:w-1.5" />{' '}
                        <span>Holiday</span>
                      </span>
                      <span className="flex col-span-2 items-center justify-center gap-1.5 sm:col-span-1 lg:col-span-1 lg:justify-start">
                        <span className="inline-block h-1.5 w-4 shrink-0 rounded-sm bg-red-400/60 lg:h-1 lg:w-3" />{' '}
                        <span>7h threshold</span>
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* PAB Calendar — beside Daily Hours on lg+, stacked on mobile.
                Bumped min-h on small screens so the full PAB month fits without
                a tight inner scroll. */}
            <Card
              size="sm"
              className="flex flex-1 flex-col rounded-2xl border-indigo-100/80 bg-gradient-to-br from-white to-indigo-50/20 shadow-md ring-1 ring-indigo-500/5 dark:border-indigo-950/60 dark:bg-none dark:from-indigo-950/20 dark:to-indigo-950/5 dark:ring-indigo-950/30 lg:min-h-[16rem] lg:rounded-xl lg:shadow-sm lg:ring-0"
            >
              <CardHeader className="shrink-0 pb-2 pt-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    PAB Calendar
                    {liveHours != null && (
                      <span
                        title={`Today's time comes straight from Hubstaff (updated ${new Date(liveHours.asOf).toLocaleTimeString()}). Past weeks show the payroll batch.`}
                        className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-400"
                      >
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        </span>
                        Live
                      </span>
                    )}
                  </CardTitle>
                  <button
                    type="button"
                    onClick={() => void refreshDashboard()}
                    disabled={refreshing}
                    aria-label="Refresh PAB calendar"
                    title="Refresh PAB calendar"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-indigo-200 bg-white text-indigo-600 transition-colors hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-400 dark:hover:bg-indigo-950/50"
                  >
                    {refreshing ? (
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                    ) : (
                      <RefreshCw className="size-3" aria-hidden />
                    )}
                  </button>
                </div>
                {pabMonthRange ? (
                  <p className="mt-0.5 flex items-center gap-1 text-[10px] text-indigo-600 dark:text-indigo-400">
                    <CalendarDays className="h-3 w-3 shrink-0" />
                    <span>
                      <span className="font-semibold">{pabMonthRange.monthName} {pabMonthRange.year}</span>
                      {' · '}
                      {formatPabCalendarDate(pabMonthRange.start)} – {formatPabCalendarDate(pabMonthRange.end)}
                    </span>
                  </p>
                ) : (
                  <div className="mt-1 h-3 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                )}
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col pt-0">
                {pabMergeLoading ? (
                  /* -------- Skeleton: mirrors the real grid below so no reflow on swap.
                       Grid dims, gaps, cell size, and header row all match. -------- */
                  <div className="flex min-h-0 flex-1 flex-col gap-0">
                    <div className="min-h-0 flex-1 overflow-hidden pr-1 [scrollbar-gutter:stable]">
                      {/* Day-of-week headers row */}
                      <div className="sticky top-0 z-10 mb-0.5 grid grid-cols-[1.25rem_repeat(5,1fr)] gap-0.5 bg-white/95 pb-0.5 dark:bg-[#0d1117]/95">
                        <div />
                        {Array.from({ length: 5 }, (_, i) => (
                          <div key={i} className="mx-auto h-2 w-2.5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                        ))}
                      </div>
                      {/* Week rows */}
                      {Array.from({ length: 5 }, (_, wi) => (
                        <div key={wi} className="mb-0.5 grid grid-cols-[1.25rem_repeat(5,1fr)] items-stretch gap-0.5">
                          <div className="flex items-center justify-end">
                            <div className="h-2 w-1.5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                          </div>
                          {Array.from({ length: 5 }, (_, di) => (
                            <div
                              key={di}
                              className="h-10 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900/30"
                              style={{ animationDelay: `${(wi * 5 + di) * 40}ms` }}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex shrink-0 items-center justify-center gap-1.5 text-[9px] text-zinc-400 dark:text-zinc-600">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading PAB data…
                    </div>
                  </div>
                ) : pabCalendar && pabCalendar.length > 0 ? (
                  /* -------- PAB Calendar Grid -------- */
                  <div className="flex min-h-0 flex-1 flex-col gap-0">
                    <div className="flex flex-1 flex-col overflow-x-clip pr-1">
                      {/* Column headers */}
                      <div className="sticky top-0 z-10 mb-0.5 grid grid-cols-[1.25rem_repeat(5,1fr)] gap-0.5 bg-white/95 pb-0.5 dark:bg-[#0d1117]/95">
                        <div />
                        {['M', 'T', 'W', 'T', 'F'].map((d, i) => (
                          <div key={i} className="text-center text-[8px] font-semibold text-zinc-400 dark:text-zinc-500">
                            {d}
                          </div>
                        ))}
                      </div>
                      {/* Week rows */}
                      {pabCalendar.map((week, wi) => (
                        <div
                          key={wi}
                          className="mb-0.5 grid grid-cols-[1.25rem_repeat(5,1fr)] items-stretch gap-0.5 lg:min-h-0 lg:flex-1 lg:grid-rows-1"
                          style={{ animation: `pab-row-in 0.35s ease-out ${wi * 80}ms both` }}
                        >
                          <div className="flex items-center justify-end text-[8px] font-medium text-zinc-400 dark:text-zinc-500">
                            {wi + 1}
                          </div>
                          {Array.from({ length: 5 }, (_, di) => {
                            // Latest in-progress (past, no-data) M–F day in this
                            // week — only that one gets the animated hourglass.
                            const _now = new Date();
                            const _todayMid = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
                            let latestInProgressTime = -Infinity;
                            for (const d of week) {
                              const cm = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate());
                              if (cm.getTime() >= _todayMid.getTime()) continue;
                              if (d.hasData && d.seconds > 0) continue;
                              if (cm.getTime() > latestInProgressTime) latestInProgressTime = cm.getTime();
                            }
                            const day: PabCalendarDay | undefined = week.find(
                              d => d.date.getDay() === di + 1,
                            );
                            if (!day) {
                              return (
                                <div
                                  key={di}
                                  className="flex h-10 items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50/50 lg:h-full lg:min-h-[2.5rem] dark:border-zinc-800 dark:bg-zinc-900/20"
                                >
                                  <span className="text-xs text-zinc-300 tabular-nums dark:text-zinc-700">—</span>
                                </div>
                              );
                            }
                            const hours = day.seconds / 3600;
                            const dayIso = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
                            const holidayName = usHolidayDates.get(dayIso) ?? null;
                            const dispute = disputesByDate.get(dayIso);
                            const nowMid = new Date();
                            const todayMid = new Date(nowMid.getFullYear(), nowMid.getMonth(), nowMid.getDate());
                            const cellMid = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate());
                            const isToday = cellMid.getTime() === todayMid.getTime();
                            const isFutureOrToday = cellMid.getTime() >= todayMid.getTime();
                            // Week spans Mon..Sun. `week` only contains M–F cells,
                            // so derive the Sunday end from the Monday entry to
                            // catch Sat/Sun "today" (otherwise the user's Sat
                            // never matches any cell and isCurrentWeek stays false).
                            const isCurrentWeek = (() => {
                              const mon = week[0]?.date;
                              if (!mon) return false;
                              const start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate());
                              const end = new Date(start);
                              end.setDate(end.getDate() + 6);
                              return todayMid.getTime() >= start.getTime() && todayMid.getTime() <= end.getTime();
                            })();
                            // Previous Mon–Sun week — empty cells here are awaiting
                            // Hubstaff upload / payroll processing, not a real miss.
                            const isPreviousWeek = (() => {
                              const mon = week[0]?.date;
                              if (!mon) return false;
                              const start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate());
                              const end = new Date(start);
                              end.setDate(end.getDate() + 6);
                              const nextMon = new Date(end);
                              nextMon.setDate(nextMon.getDate() + 1);
                              const nextSun = new Date(nextMon);
                              nextSun.setDate(nextSun.getDate() + 6);
                              return todayMid.getTime() >= nextMon.getTime() && todayMid.getTime() <= nextSun.getTime();
                            })();
                            const noMeaningfulData = !day.hasData || day.seconds === 0;
                            const stillInProgress = isCurrentWeek && noMeaningfulData && !isFutureOrToday;
                            const stillProcessing = isPreviousWeek && noMeaningfulData && !dispute;

                            const isHoliday = !!holidayName;
                            // PAB dispute filing/viewing was removed from the employee view
                            // (2026-07-20); forgiveness still applies server-side (see
                            // `forgiven` below). Only holidays remain clickable (details modal).
                            const cellClickable = isHoliday;

                            const disputeForgiven =
                              !!dispute &&
                              disputeGrantsPabForgiveness(dispute) &&
                              !day.passes &&
                              (isOrphanageStyleReason(dispute.reason) || day.seconds >= 4 * 3600);
                            // TEMPORARY orphanage → PAB coverage: tracked time + the orphanage
                            // hours Accounting recorded in the Payroll Wizard reach 7h — the day
                            // keeps its REAL hours but renders forgiven. See orphanage-pab-coverage.ts.
                            const orphanageForgiven =
                              !day.passes && orphanageCoveredKeys.has(pabDateKey(day.date));
                            const forgiven = disputeForgiven || orphanageForgiven;
                            const effectivelyPasses = day.passes || forgiven;

                            let cellBorder: string;
                            if (isHoliday) {
                              cellBorder =
                                'border-sky-400 bg-sky-50 ring-1 ring-sky-400/40 dark:border-sky-600/70 dark:bg-sky-950/40';
                            } else if (effectivelyPasses) {
                              // A day that hit ≥7h is locked green the moment it's
                              // logged — including elapsed days in the current week.
                              // (Today's live cell keeps its orange "in progress"
                              // styling below only while it's still UNDER 7h.)
                              cellBorder = forgiven
                                ? 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-400/40 dark:border-emerald-600/60 dark:bg-emerald-950/30'
                                : 'border-emerald-300 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-950/30';
                            } else if (isToday) {
                              cellBorder =
                                'border-orange-300 bg-orange-50 dark:border-orange-700/60 dark:bg-orange-950/30';
                            } else if (stillInProgress) {
                              cellBorder =
                                'border-orange-300 bg-orange-50 dark:border-orange-700/60 dark:bg-orange-950/30';
                            } else if (stillProcessing) {
                              cellBorder =
                                'border-sky-300 bg-sky-50 dark:border-sky-700/60 dark:bg-sky-950/30';
                            } else if (isFutureOrToday || !day.hasData) {
                              cellBorder =
                                'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40';
                            } else {
                              cellBorder =
                                'border-red-300 bg-red-50 dark:border-red-700/70 dark:bg-red-950/40';
                            }

                            const dayRate = resolveDayRate(day.date);
                            // Rate badge shows on every day with hours AND on
                            // any flip-day (even today/empty cells) so a new
                            // effective date is immediately visible.
                            const showRateBadge =
                              dayRate.reg != null && (day.hasData || dayRate.isFlipDay);
                            const rateTooltipSuffix =
                              dayRate.reg != null || dayRate.ot != null
                                ? ` · Rate ${fmtDayRate(dayRate.reg)} / OT ${fmtDayRate(dayRate.ot)}${dayRate.isFlipDay ? ' (new today)' : ''}`
                                : '';

                            return (
                              <div
                                key={di}
                                className={`group relative flex h-10 flex-col overflow-hidden rounded-lg border transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:z-10 hover:shadow-md motion-safe:hover:scale-[1.04] motion-reduce:transition-none lg:h-full lg:min-h-[2.5rem] ${cellBorder} ${cellClickable ? `cursor-pointer ${isHoliday ? 'hover:ring-2 hover:ring-sky-400/50' : 'hover:ring-2 hover:ring-orange-300/50'}` : ''}`}
                                title={`${day.dayLabel} ${day.dateStr}${holidayName ? ` · ${holidayName} (holiday — click for details)` : ''}: ${secondsToDisplay(day.seconds)}${day.passes ? ' ✓' : orphanageForgiven ? ' ✓ Forgiven by Accounting — orphanage hours recorded in payroll' : disputeForgiven ? ' ✓ Forgiven by Accounting' : isToday ? ' — in progress' : isFutureOrToday ? ' — not yet' : stillProcessing ? ' — processing' : day.hasData ? ' ✗ needs 7h' : ' — no data'}${rateTooltipSuffix}`}
                                style={{
                                  // `backwards` (not `both`): hold the hidden start-state during the
                                  // stagger delay, but release the transform once the entrance ends so
                                  // the hover scale (below) isn't overridden by a filled animation.
                                  animation: `pab-cell-in 0.3s ease-out ${wi * 80 + di * 40}ms backwards`,
                                }}
                                onClick={isHoliday && holidayName ? () => setHolidayModal({ name: holidayName, date: dayIso }) : undefined}
                              >
                                {/* Glass sheen — a top-down light reflection that reads as shiny
                                    glass; brightens on hover. Sits above the tinted background but
                                    below the content (which is `relative`), so nothing is washed out. */}
                                <span
                                  aria-hidden
                                  className="pointer-events-none absolute inset-0 rounded-[inherit] bg-gradient-to-b from-white/50 to-transparent opacity-80 transition-opacity duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:opacity-100 motion-reduce:transition-none dark:from-white/[0.10] dark:opacity-70"
                                />
                                <span className="pointer-events-none absolute left-1 top-0.5 max-w-[calc(100%-1.25rem)] truncate text-[5px] font-medium leading-none tabular-nums text-zinc-400 dark:text-zinc-500">
                                  {day.dateStr}
                                </span>
                                {/* Holiday badge */}
                                {isHoliday && (
                                  <span className="pointer-events-none absolute right-0.5 top-0.5 rounded bg-sky-400/20 px-0.5 text-[5px] font-bold uppercase leading-tight tracking-wide text-sky-600 dark:bg-sky-500/20 dark:text-sky-400">
                                    Holiday
                                  </span>
                                )}
                                {/* Pinging dot for today */}
                                {isToday && (
                                  <span className="absolute right-1 top-1 flex h-1.5 w-1.5">
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
                                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
                                  </span>
                                )}
                                <div className="relative flex flex-1 flex-col items-center justify-center px-0.5 pb-0.5 pt-2.5">
                                  {isToday && day.seconds > 0 ? (
                                    // Live tracked time landed (timer running or paused) —
                                    // show the contribution so far. Emerald once the day
                                    // has cleared 7h, orange while it's still short.
                                    <div className="flex flex-col items-center gap-0.5">
                                      <span
                                        className={`text-center text-[13px] font-bold tabular-nums leading-none tracking-tight lg:text-sm ${
                                          effectivelyPasses
                                            ? 'text-emerald-700 dark:text-emerald-400'
                                            : 'text-orange-700 dark:text-orange-400'
                                        }`}
                                      >
                                        {secondsToDisplay(day.seconds)}
                                      </span>
                                      <span
                                        className={`text-[6px] font-semibold uppercase tracking-wider ${
                                          effectivelyPasses
                                            ? 'text-emerald-600 dark:text-emerald-400'
                                            : 'text-orange-400 dark:text-orange-300'
                                        }`}
                                      >
                                        In Progress
                                      </span>
                                    </div>
                                  ) : isToday || stillInProgress ? (
                                    <div className="flex flex-col items-center gap-0.5">
                                      <Hourglass
                                        className="h-3 w-3 text-orange-400 dark:text-orange-300"
                                        style={
                                          isToday || cellMid.getTime() === latestInProgressTime
                                            ? { animation: 'hourglass-flip 2s ease-in-out infinite' }
                                            : undefined
                                        }
                                      />
                                      <span className="text-[7px] font-semibold uppercase tracking-wider text-orange-400 dark:text-orange-300">
                                        In Progress
                                      </span>
                                    </div>
                                  ) : stillProcessing ? (
                                    <div className="flex flex-col items-center gap-0.5">
                                      <Loader2 className="h-3 w-3 animate-spin text-sky-500 dark:text-sky-400" />
                                      <span className="text-[7px] font-semibold uppercase tracking-wider text-sky-600 dark:text-sky-400">
                                        Processing
                                      </span>
                                    </div>
                                  ) : isHoliday ? (
                                    <span className="text-center text-[13px] font-semibold leading-none tracking-tight text-sky-600 dark:text-sky-400 lg:text-sm">
                                      {day.hasData && hours > 0 ? `${hours.toFixed(1)}h` : 'Off'}
                                    </span>
                                  ) : (
                                    <span
                                      className={`text-center text-sm font-bold tabular-nums leading-none tracking-tight lg:text-base ${
                                        effectivelyPasses
                                          ? 'text-emerald-700 dark:text-emerald-400'
                                          : isToday || isFutureOrToday || stillInProgress || !day.hasData
                                            ? 'text-zinc-400 dark:text-zinc-500'
                                            : 'text-red-600 dark:text-red-400'
                                      }`}
                                    >
                                      {day.hasData ? `${hours.toFixed(1)}h` : '—'}
                                    </span>
                                  )}
                                </div>
                                <div className="pointer-events-none absolute bottom-0.5 right-0.5">
                                  {isHoliday ? (
                                    <CheckCircle2 className="h-2.5 w-2.5 text-sky-500 dark:text-sky-400" />
                                  ) : effectivelyPasses ? (
                                    <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" />
                                  ) : isToday || isFutureOrToday || stillInProgress || !day.hasData ? null : day.hasData ? (
                                    <XCircle className="h-2.5 w-2.5 text-red-400" />
                                  ) : null}
                                </div>
                                {/* Per-day rate badge — bottom-left so it
                                    doesn't collide with the dispute/check
                                    indicator. Flip-day gets the green ring. */}
                                {showRateBadge && (
                                  <span
                                    className={`pointer-events-none absolute bottom-0 left-0.5 rounded px-0.5 text-[7px] font-semibold leading-tight tabular-nums ${
                                      dayRate.isFlipDay
                                        ? 'bg-emerald-500/20 text-emerald-700 ring-1 ring-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/40'
                                        : 'text-zinc-400 dark:text-zinc-500'
                                    }`}
                                  >
                                    {fmtDayRate(dayRate.reg)}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    {/* Legend + status */}
                    <div className="mt-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 pt-2 text-[9px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-600 sm:text-[10px]">
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 sm:h-2 sm:w-2" /> ≥ 7h
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400 sm:h-2 sm:w-2" /> &lt; 7h
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600 sm:h-2 sm:w-2" /> N/A
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 sm:h-2 sm:w-2" /> Pending
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 ring-1 ring-emerald-400 sm:h-2 sm:w-2" /> Forgiven
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 sm:h-2 sm:w-2" /> Holiday
                      </span>
                      <span className="ml-auto font-medium">
                        {isPAEligible
                          ? <span className="text-emerald-600 dark:text-emerald-400">PAB Eligible</span>
                          : <span className="text-red-500 dark:text-red-400">PAB Not Met</span>}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
                    <CalendarDays className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
                    <p className="text-xs text-zinc-400 dark:text-zinc-500">
                      PAB calendar will appear once<br />Hubstaff data is uploaded
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

          </div>

          {/* TEMPORARY orphanage → PAB coverage (see orphanage-pab-coverage.ts):
              the employee's orphanage-visit days and how they count toward PAB. */}
          {orphanageVisitSummary.length > 0 && (
            <Card className="shrink-0 overflow-hidden border-rose-200/80 bg-rose-50/30 dark:border-rose-900/40 dark:bg-rose-950/20">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm text-rose-800 dark:text-rose-300">
                  <CalendarDays className="h-4 w-4 text-rose-500" /> Orphanage – Visits
                  <span className="rounded-full bg-rose-100 px-1.5 py-px font-mono text-[10px] tabular-nums text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                    {orphanageVisitSummary.length}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4 text-[13px]">
                <p className="mb-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                  Orphanage hours recorded in payroll automatically top up your short days around the
                  visit — if tracked time + orphanage hours reach 7 hours, the day still counts toward
                  Perfect Attendance. Covered days already show as passing on the calendar above.
                </p>
                <ul className="divide-y divide-rose-100/70 dark:divide-rose-950/50">
                  {orphanageVisitSummary.map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-2 py-1.5">
                      <span className="font-medium tabular-nums text-zinc-700 dark:text-zinc-300">{v.hours}h orphanage hours</span>
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-500">week {v.weekLabel}</span>
                      <span className="ml-auto flex flex-wrap items-center gap-1">
                        {v.stillShort.length === 0 ? (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">No short days remaining</span>
                        ) : (
                          v.stillShort.map((s) => (
                            <span key={s.label} className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300" title={`${s.workedH}h tracked + ${v.hours}h orphanage hours still under 7h`}>
                              {s.label} · {s.workedH}h — not covered
                            </span>
                          ))
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}
      </div>

      <Dialog open={mobileHelpOpen} onOpenChange={setMobileHelpOpen}>
        <DialogContent
          className="max-h-[min(90vh,760px)] w-[calc(100vw-1.25rem)] max-w-md gap-0 overflow-y-auto border-orange-100/70 bg-gradient-to-br from-white via-orange-50/35 to-blue-50/25 p-0 sm:max-w-md dark:border-blue-950/50 dark:from-[#0d1117] dark:via-[#0f1729] dark:to-[#0a1628]"
          showCloseButton
        >
          <DialogHeader className="border-b border-orange-100/60 px-4 py-3 dark:border-blue-950/50">
            <DialogTitle className="text-base text-zinc-900 dark:text-white">PAB &amp; bonuses</DialogTitle>
            <DialogDescription className="text-left text-xs text-zinc-600 dark:text-zinc-400">
              Rules and your status. On mobile, your dashboard shows the hours and PAB calendar charts first — open this
              anytime for eligibility, tech bonus, and pay snapshot.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-4 py-4">
            <section className="rounded-xl border border-zinc-200/80 bg-white/90 p-3 text-[11px] leading-relaxed text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
              <p className="font-semibold text-zinc-800 dark:text-zinc-200">Perfect Attendance (PAB)</p>
              <p className="mt-1.5">
                PAB uses every Mon–Fri in the PAB period (merged Hubstaff uploads); each weekday must be ≥ 7 hours. If the
                month doesn&apos;t start on a Monday, the first week is skipped and counting starts on the{' '}
                <span className="font-medium text-zinc-700 dark:text-zinc-300">second Monday</span> (e.g. March 2026: Mar
                9–Apr 3). Figures are estimates until payroll confirms them.
              </p>
              <p className="mt-3 font-semibold text-zinc-800 dark:text-zinc-200">Technology bonus</p>
              <p className="mt-1">
                {formatPHP(techBonusPhpAmt).replace(/\.\d{2}$/, '')} after 30 days of service, typically paid on the
                3rd paycheck of the month.
              </p>
            </section>

            {renderPabBonusStatusRows()}

            {!row && (
              <p className="text-center text-xs text-zinc-500 dark:text-zinc-500">
                When Hubstaff data is available, your personal eligibility appears here.
              </p>
            )}

            {row && (
              <section className="space-y-2 rounded-xl border border-orange-100/70 bg-white/80 p-3 dark:border-blue-950/50 dark:bg-blue-950/20">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                  Pay snapshot
                </p>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Total hours</span>
                    <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{totalHours.toFixed(2)}h</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Regular pay</span>
                    <span className="tabular-nums text-zinc-800 dark:text-zinc-200">
                      {regularPay != null ? formatPHP(regularPay) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">OT pay</span>
                    <span className="tabular-nums text-zinc-800 dark:text-zinc-200">
                      {otPay != null ? formatPHP(otPay) : otHours > 0 ? '—' : formatPHP(0)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">PAB</span>
                    <span className="tabular-nums text-zinc-800 dark:text-zinc-200">
                      {perfectAttendanceBonusStatus === 'pending'
                        ? '—'
                        : pabBonusAmount > 0
                          ? `+${formatPHP(pabBonusAmount)}`
                          : formatPHP(0)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Tech bonus</span>
                    <span className="tabular-nums text-zinc-800 dark:text-zinc-200">
                      {technologyBonusAmount > 0 ? `+${formatPHP(technologyBonusAmount)}` : formatPHP(0)}
                    </span>
                  </div>
                  {mesaDeductionPhp > 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-teal-600 dark:text-teal-400">MESA contribution</span>
                      <span className="tabular-nums text-teal-700 dark:text-teal-300">
                        −{formatPHP(mesaDeductionPhp)}
                      </span>
                    </div>
                  )}
                  <div className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
                  <div className="flex justify-between gap-2">
                    <span className="font-medium text-zinc-900 dark:text-white">
                      {mesaDisbursementPhp > 0 ? 'Take-home' : 'Total'}
                    </span>
                    <span className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                      {takeHomePhp != null ? formatPHP(takeHomePhp) : '—'}
                    </span>
                  </div>
                  {mesaDisbursementPhp > 0 && (
                    <>
                      <div className="flex justify-between gap-2">
                        <span className="text-teal-600 dark:text-teal-400">MESA emergency payout</span>
                        <span className="tabular-nums text-teal-700 dark:text-teal-300">
                          +{formatPHP(mesaDisbursementPhp)}
                        </span>
                      </div>
                      <div className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
                      <div className="flex justify-between gap-2">
                        <span className="font-medium text-zinc-900 dark:text-white">Total deposited</span>
                        <span className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                          {totalDepositedPhp != null ? formatPHP(totalDepositedPhp) : '—'}
                        </span>
                      </div>
                    </>
                  )}
                  {takeHomeFromPayroll && (
                    <p className="text-right text-[10px] text-zinc-500 dark:text-zinc-400">
                      Includes payroll-confirmed bonuses &amp; adjustments
                    </p>
                  )}
                  {takeHomePhp != null && (
                    <p className="text-right text-[10px] tabular-nums text-blue-600 dark:text-blue-400">
                      ≈{' '}
                      {(takeHomePhp / usdToPhpRate).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      USD
                    </p>
                  )}
                </div>
              </section>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {holidayModal && (
        <Dialog open onOpenChange={(open) => { if (!open) setHolidayModal(null); }}>
          <DialogContent className="max-w-xs">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sky-600 dark:text-sky-400">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-100 text-sm dark:bg-sky-900/40">
                  🎌
                </span>
                Public Holiday
              </DialogTitle>
              <DialogDescription>
                <span className="block space-y-3 pt-1">
                  <span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                    {holidayModal.name}
                  </span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    {(() => {
                      const [y, m, d] = holidayModal.date.split('-').map(Number);
                      return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en-US', {
                        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                      });
                    })()}
                  </span>
                  <span className="block text-xs text-zinc-400 dark:text-zinc-500">
                    This day is a recognised holiday. Your attendance requirement is automatically waived — no issue needed.
                  </span>
                </span>
              </DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      )}

      <PayStubModal
        open={paystubModalFile !== null}
        sourceFile={paystubModalFile}
        onClose={() => setPaystubModalFile(null)}
      />

    </div>
  );
}

/**
 * Bell-style icon button shown in the dashboard header. Renders a tiny pink
 * (or amber, when rejected) badge dot whenever an action is pending. Click
 * opens the gift-shipping modal directly.
 */
function GiftBellButton({
  state,
  onClick,
}: {
  state: GiftShippingState;
  onClick: () => void;
}) {
  const tooltip = (() => {
    if (state.status === 'approved')
      return `${state.milestoneMonths}-month gift — approved`;
    if (state.status === 'rejected')
      return `${state.milestoneMonths}-month gift — needs revisions`;
    if (state.status === 'pending')
      return `${state.milestoneMonths}-month gift — pending review`;
    if (state.status === 'unsubmitted')
      return `${state.milestoneMonths}-month gift — confirm shipping details`;
    return 'Gift shipping';
  })();
  const badgeTone = state.status === 'rejected' ? 'bg-amber-500' : 'bg-pink-500';
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200 bg-white/90 text-pink-600 shadow-sm transition hover:border-pink-300 hover:bg-pink-50 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-pink-300 dark:hover:border-pink-900/60 dark:hover:bg-pink-950/30"
    >
      <Gift className="size-4.5" aria-hidden />
      {state.needsAction && (
        <>
          <span
            className={cn(
              'pointer-events-none absolute right-1 top-1 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-zinc-900',
              badgeTone,
            )}
            aria-hidden
          />
          {/* Soft ping ring to draw the eye when action is needed. */}
          <span
            className={cn(
              'pointer-events-none absolute right-1 top-1 inline-flex h-2.5 w-2.5 animate-ping rounded-full opacity-75',
              badgeTone,
            )}
            aria-hidden
          />
        </>
      )}
    </button>
  );
}

function NotificationBellButton({
  unreadCount,
  onClick,
}: {
  unreadCount: number;
  onClick: () => void;
}) {
  const label = unreadCount > 0
    ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
    : 'Notifications';
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200 bg-white/90 text-zinc-600 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-300 dark:hover:border-orange-900/60 dark:hover:bg-orange-950/30 dark:hover:text-orange-400"
    >
      <Bell className="size-4.5" aria-hidden />
      {unreadCount > 0 && (
        <>
          <motion.span
            key={unreadCount}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 14 }}
            className="pointer-events-none absolute -right-1 -top-1 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-gradient-to-br from-rose-500 via-red-500 to-orange-500 px-1 py-px text-[9px] font-bold tabular-nums text-white ring-2 ring-white dark:ring-zinc-900"
            aria-hidden
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </motion.span>
          <span
            className="pointer-events-none absolute -right-1 -top-1 inline-flex h-4 w-4 animate-ping rounded-full bg-rose-500/50 opacity-75"
            aria-hidden
          />
        </>
      )}
    </button>
  );
}
