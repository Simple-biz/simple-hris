'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Search, Send, Eye, EyeOff, Clock, AlertTriangle, Users, Banknote, Loader2, Sparkles, RefreshCw, CalendarDays, ChevronRight, ChevronDown, Landmark, Bell, Check, Pencil, X, Download, FileText, FileSpreadsheet, Table2,
  User, IdCard, Building2, Hash, Mail, AtSign, Phone, MapPin, Copy, Contact as ContactIcon, Hourglass,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { TeamAvatar } from '@/components/team/team-ui';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { Skeleton } from '@/components/ui/skeleton';
import EmployeePabCalendar from '@/components/employee/EmployeePabCalendar';
import PabCalendarLoader from '@/components/employee/PabCalendarLoader';
import { DatePicker, DateRangePicker, type DateRange } from '@/components/ui/date-picker';
import PeopleBankChanges from './PeopleBankChanges';
import { BankChangeDetailDialog, timeAgo, type BankChangeEntry } from './bank-change-detail';
import { getTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import { parseNameParts, composeMasterListName, type NameParts } from '@/lib/name/name-parts';
import { isHslFamilyLabel, formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { BANK_PREFERRED_OPTIONS, isWiresPreferred } from '@/lib/employee-payment-processors';
import {
  buildRosterExport,
  downloadRosterCsv,
  downloadRosterXlsx,
  downloadRosterPdf,
} from '@/lib/people/people-roster-export';
import { cn } from '@/lib/utils';

type Currency = 'PHP' | 'USD' | 'COP';

interface Rate {
  regular: number | null;
  ot: number | null;
  currency: Currency;
  source: 'employee' | 'sheet' | 'department' | null;
}
interface Hours {
  thisWeek: number;
  ot: number;
  weekStart: string | null;
  weekEnd: string | null;
  inProgress: boolean;
  projectedHours: number | null;
  projectedOt: number | null;
}
interface RosterRow {
  /** global_master_list PK — targets identity edits from the profile editor. */
  id: string | null;
  employee_id: string | null;
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  alternate_work_emails: string[];
  department: string | null;
  start_date: string | null;
  street: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  full_address: string | null;
  phone_number: string | null;
  location: string | null;
  rate: Rate;
  hours: Hours;
  processor: string | null;
  hasBanking: boolean;
}

/** Fresh master fields returned by PATCH /api/people/[email]/profile — merged
 *  into the in-memory roster row (rate/hours/banking are left untouched). */
interface MasterProfileFields {
  id: string | null;
  employee_id: string | null;
  name: string | null;
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
  alternate_work_emails: string[];
  start_date: string | null;
  phone_number: string | null;
  location: string | null;
  street: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  full_address: string | null;
}
interface Banking {
  /** Send-from rail ("Bank Preferred") — wins Payment Dispatch routing. */
  bank_preferred: string | null;
  /** The rail Payment Dispatch actually routes this person on (server-resolved
   *  with PD's full precedence incl. the legacy rates-sheet fallback). */
  effective_processor: string | null;
  effective_processor_source: 'bank_preferred' | 'disbursement' | 'rates_sheet' | null;
  preferred_processor: string | null;
  preferred_bank_slot: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  account_number: string | null;
  routing_number: string | null;
  swift_code: string | null;
  full_address: string | null;
  alt_bank_name: string | null;
  alt_account_holder_name: string | null;
  alt_account_number: string | null;
  alt_routing_number: string | null;
  hurupay_email: string | null;
  wepay_email: string | null;
  higlobe_email: string | null;
  higlobe_account_name: string | null;
  wise_email: string | null;
  wise_tag: string | null;
  phone_number: string | null;
  bank_last_self_updated_at?: string | null;
  masked: boolean;
}
interface HistoryRow {
  source_file: string | null;
  kind: 'cycle' | 'special';
  note: string | null;
  period_start: string | null;
  period_end: string | null;
  total_hours: number | null;
  regular_hours: number | null;
  ot_hours: number | null;
  amount_php: number | null;
  amount_usd: number | null;
  status: string | null;
  paid_amount_usd: number | null;
  paid_at: string | null;
}
interface Summary {
  otEmployees: number;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
}
interface StatsLeader {
  name: string | null;
  email: string | null;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
  weeks: number;
}
interface StatsPoint {
  sourceFile: string;
  weekStart: string;
  weekEnd: string;
  otEmployees: number;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
  /** Full ranked OT renderers for this week (top 5 feed the chart tooltip). */
  leaders: StatsLeader[];
  /** Per-department OT for this week — powers the department trend line graph. */
  depts: StatsDept[];
}
interface StatsDept {
  department: string;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
  people: number;
}
/** The OT trend at three time granularities — drives the trend-chart toggle. */
interface StatsSeries {
  daily: StatsPoint[];
  weekly: StatsPoint[];
  monthly: StatsPoint[];
}
type Granularity = 'daily' | 'weekly' | 'monthly';
type OtSort = 'hours' | 'pay';
type OtTab = 'people' | 'department';

/** Per-granularity copy: the segmented-control label, singular bucket noun, and KPI prefix. */
const GRANULARITY_META: Record<Granularity, { label: string; unit: string; latest: string }> = {
  daily: { label: 'Daily', unit: 'day', latest: 'Latest day' },
  weekly: { label: 'Weekly', unit: 'week', latest: 'Latest week' },
  monthly: { label: 'Monthly', unit: 'month', latest: 'Latest month' },
};
const GRANULARITY_ORDER: Granularity[] = ['daily', 'weekly', 'monthly'];
/** Ambient auto-cycle: begin after this much idle time, then hold each view this long. */
const AUTOPLAY_IDLE_MS = 30_000;
const AUTOPLAY_STEP_MS = 5_000;

/** Editable master-list profile fields, all held as strings for form binding. */
interface ProfileForm {
  name: string;
  department: string;
  work_email: string;
  personal_email: string;
  alternate_work_email: string;
  alternate_work_email_2: string;
  start_date: string;
  phone_number: string;
  street: string;
  city: string;
  province: string;
  postal_code: string;
  full_address: string;
}

/** Master "Start Date" is free-text (e.g. "2/26/18"); coerce to YYYY-MM-DD for
 *  the DatePicker when parseable, else '' (the field shows blank and the
 *  original is preserved unless the user picks a new date). */
function toDateInput(raw: string | null | undefined): string {
  if (!raw?.trim()) return '';
  const s = raw.trim();
  // Already ISO (date-only or timestamp) — take the date part verbatim so there's
  // no UTC parse shift (new Date('2018-02-26') is UTC midnight = the prior day in
  // negative-UTC zones). Free-text like "2/26/18" parses as LOCAL midnight below.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function initialForm(row: RosterRow): ProfileForm {
  return {
    name: row.name ?? '',
    department: row.department ?? '',
    work_email: row.work_email ?? '',
    personal_email: row.personal_email ?? '',
    alternate_work_email: row.alternate_work_emails?.[0] ?? '',
    alternate_work_email_2: row.alternate_work_emails?.[1] ?? '',
    start_date: toDateInput(row.start_date),
    phone_number: row.phone_number ?? '',
    street: row.street ?? '',
    city: row.city ?? '',
    province: row.province ?? '',
    postal_code: row.postal_code ?? '',
    full_address: row.full_address ?? '',
  };
}

/** Editable bank & payout fields, all held as strings for form binding. Mirrors
 *  the allowlist of PATCH /api/people/[email]/banking — which writes the
 *  canonical employee_ids row every dashboard reads. */
interface BankForm {
  bank_preferred: string;
  preferred_processor: string;
  preferred_bank_slot: string;
  bank_name: string;
  account_holder_name: string;
  account_number: string;
  routing_number: string;
  swift_code: string;
  full_address: string;
  alt_bank_name: string;
  alt_account_holder_name: string;
  alt_account_number: string;
  alt_routing_number: string;
  hurupay_email: string;
  wepay_email: string;
  higlobe_email: string;
  higlobe_account_name: string;
  wise_email: string;
  wise_tag: string;
  phone_number: string;
}

/** Build the editable form from an UNMASKED banking record (or empty for a
 *  first-time setup). Must only ever be fed revealed values — a masked record
 *  would put dot-runs into the inputs and save them as literal account numbers. */
function bankingToForm(b: Banking | null): BankForm {
  return {
    bank_preferred: (b?.bank_preferred ?? '').trim().toLowerCase(),
    preferred_processor: (b?.preferred_processor ?? '').trim().toLowerCase(),
    preferred_bank_slot: ((b?.preferred_bank_slot ?? '').trim().toLowerCase() || 'primary'),
    bank_name: b?.bank_name ?? '',
    account_holder_name: b?.account_holder_name ?? '',
    account_number: b?.account_number ?? '',
    routing_number: b?.routing_number ?? '',
    swift_code: b?.swift_code ?? '',
    full_address: b?.full_address ?? '',
    alt_bank_name: b?.alt_bank_name ?? '',
    alt_account_holder_name: b?.alt_account_holder_name ?? '',
    alt_account_number: b?.alt_account_number ?? '',
    alt_routing_number: b?.alt_routing_number ?? '',
    hurupay_email: b?.hurupay_email ?? '',
    wepay_email: b?.wepay_email ?? '',
    higlobe_email: b?.higlobe_email ?? '',
    higlobe_account_name: b?.higlobe_account_name ?? '',
    wise_email: b?.wise_email ?? '',
    wise_tag: b?.wise_tag ?? '',
    phone_number: b?.phone_number ?? '',
  };
}

const PROCESSOR_OPTIONS = [
  { value: '', label: 'Not set' },
  { value: 'hurupay', label: 'Hurupay' },
  { value: 'wepay', label: 'WePay' },
  { value: 'higlobe', label: 'HiGlobe' },
  { value: 'wise', label: 'Wise' },
  { value: 'jeeves', label: 'Jeeves' },
  { value: 'wires', label: 'Wires' },
];

/** A labeled text/date input for the profile editor grid. */
function EditField({
  label,
  value,
  onChange,
  accent,
  type = 'text',
  hint,
  wide,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  accent: Accent;
  type?: string;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <div className={cn(wide && 'sm:col-span-2')}>
      <label className="text-[10.5px] uppercase tracking-wide text-zinc-400">{label}</label>
      {type === 'date' ? (
        <DatePicker
          value={value}
          onChange={onChange}
          className={cn('mt-1 h-8 text-[13px]', accent.ring)}
        />
      ) : (
        <Input
          value={value}
          type={type}
          onChange={(e) => onChange(e.target.value)}
          className={cn('mt-1 h-8 text-[13px]', accent.ring)}
        />
      )}
      {hint && <p className="mt-0.5 text-[10.5px] text-zinc-400">{hint}</p>}
    </div>
  );
}

/** Merge freshly-saved master fields into an existing roster row, leaving the
 *  rate/hours/processor/banking (which a profile edit never touches) intact. */
function mergeMaster(row: RosterRow, m: MasterProfileFields): RosterRow {
  return {
    ...row,
    id: m.id ?? row.id,
    employee_id: m.employee_id ?? row.employee_id,
    name: m.name,
    work_email: m.work_email,
    personal_email: m.personal_email,
    alternate_work_emails: m.alternate_work_emails ?? [],
    department: m.department,
    start_date: m.start_date,
    street: m.street,
    city: m.city,
    province: m.province,
    postal_code: m.postal_code,
    full_address: m.full_address,
    phone_number: m.phone_number,
    location: m.location,
  };
}

// Case-insensitive A→Z by display name — every people list in this tab (main
// table, excluded-payout modal, missing-bank modal) presents in this order.
function byName(a: RosterRow, b: RosterRow): number {
  return (a.name ?? '').trim().localeCompare((b.name ?? '').trim(), undefined, { sensitivity: 'base' });
}

function fmtMoney(amount: number | null | undefined, currency: Currency = 'PHP'): string {
  if (amount == null) return '—';
  const opts = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (currency === 'USD') return `$${amount.toLocaleString('en-US', opts)}`;
  if (currency === 'COP') return `COP ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `₱${amount.toLocaleString('en-PH', opts)}`;
}

function fmtHours(h: number | null | undefined): string {
  if (h == null) return '—';
  return `${h.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;
}

function todayIso(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse a "YYYY-MM-DD" string as a LOCAL calendar date (no UTC/TZ shift). */
function parseIsoLocal(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** "2026-06-22" → "June 22, 2026". Falls back to the raw string if unparseable. */
function formatDay(iso: string | null | undefined): string {
  const d = parseIsoLocal(iso);
  if (!d) return iso ?? '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Hire date → "Jun 22, 2026". null when absent; raw string if unparseable.
 *  Lenient (`new Date`) so any master-list format renders — start dates arrive in
 *  whatever shape was typed into the sheet, not guaranteed ISO. Matches fmtDate on
 *  the Global Master List. */
function formatHireDate(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return raw.trim();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Tenure = start date compared to the current date → "2y 3m" / "5mo" / "12d" /
 *  "New". null when there's no start date or it can't be parsed. Mirrors the
 *  Global Master List's tenure() exactly (lenient `new Date` parsing, same
 *  bucketing) so both surfaces agree for the same person. Client-only (runs inside
 *  the profile dialog after a click), so the `new Date()` never hits SSR hydration. */
function tenureFrom(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const start = new Date(raw.trim());
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return null;
  if (years > 0 && months > 0) return `${years}y ${months}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
  return days <= 0 ? 'New' : `${days}d`;
}

/**
 * Friendly pay-period range:
 *   same month  → "April 5 - 10, 2026"
 *   cross month → "June 29 - July 5, 2026"
 *   cross year  → "Dec 30, 2025 - Jan 5, 2026"
 */
function formatPeriodRange(startIso: string | null | undefined, endIso: string | null | undefined): string {
  const s = parseIsoLocal(startIso);
  const e = parseIsoLocal(endIso);
  if (!s || !e) return [startIso, endIso].filter(Boolean).join(' - ');
  const mLong = (d: Date) => d.toLocaleDateString('en-US', { month: 'long' });
  if (s.getFullYear() !== e.getFullYear()) return `${formatDay(startIso)} - ${formatDay(endIso)}`;
  if (s.getMonth() === e.getMonth()) return `${mLong(s)} ${s.getDate()} - ${e.getDate()}, ${s.getFullYear()}`;
  return `${mLong(s)} ${s.getDate()} - ${mLong(e)} ${e.getDate()}, ${s.getFullYear()}`;
}

/** A Hubstaff upload filename → friendly week label for the period selector. */
function labelForSourceFile(file: string): string {
  const m = file.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (m) return formatPeriodRange(m[1], m[2]);
  return file.replace(/\.csv$/i, '');
}

export interface Accent {
  ring: string;
  chipBg: string;
  chipText: string;
  btn: string;
  /** native accent-color for checkboxes/date pickers */
  check: string;
  /** solid color for the active tab underline */
  bar: string;
  /** interior focus ring for popover date-picker controls */
  focusRing?: string;
  /** text color for the "today" marker in date pickers */
  today?: string;
}

export default function PeopleTab({
  view,
  viewerEmail,
  canEdit,
  canPay = false,
}: {
  view: 'accounting' | 'ceo';
  viewerEmail: string | null;
  canEdit: boolean;
  /** CEO + Accounting: show the "Pay" action (files a one-off Urgent payment).
   *  Separate from canEdit — the CEO is otherwise read-only on People. */
  canPay?: boolean;
}) {
  void viewerEmail; // identity is derived server-side from the session
  const accent: Accent =
    view === 'ceo'
      ? {
          ring: 'focus-visible:ring-amber-500/40',
          chipBg: 'bg-amber-50 dark:bg-amber-950/30',
          chipText: 'text-amber-700 dark:text-amber-300',
          btn: 'bg-gradient-to-r from-yellow-500 to-amber-600 hover:from-yellow-500 hover:to-amber-700 text-white',
          check: 'accent-amber-600',
          bar: 'bg-amber-500',
          focusRing: 'focus-visible:ring-amber-500/40',
          today: 'text-amber-700 dark:text-amber-300',
        }
      : {
          ring: 'focus-visible:ring-orange-500/40',
          chipBg: 'bg-orange-50 dark:bg-orange-950/30',
          chipText: 'text-orange-700 dark:text-orange-300',
          btn: 'bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white',
          check: 'accent-orange-600',
          bar: 'bg-orange-500',
          focusRing: 'focus-visible:ring-orange-500/40',
          today: 'text-orange-700 dark:text-orange-300',
        };

  const [rows, setRows] = useState<RosterRow[]>(() => getTabCache<RosterRow[]>(TAB_CACHE_KEYS.peopleRoster) ?? []);
  const [loading, setLoading] = useState(rows.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<RosterRow | null>(null);
  // The person a one-off payment is being filed for (Pay dialog open when set).
  const [payTarget, setPayTarget] = useState<RosterRow | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [showNoBanking, setShowNoBanking] = useState(false);
  const [deptFilter, setDeptFilter] = useState<string>('all');
  // Roster + stats share this: when on, only people who rendered OT are shown.
  const [otOnly, setOtOnly] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 15;
  const [summary, setSummary] = useState<Summary | null>(null);
  const [periods, setPeriods] = useState<{ file: string; label: string }[]>([]);
  const [period, setPeriod] = useState('');
  const periodRef = useRef('');
  const defaultFileRef = useRef('');
  // Custom date range — when set, the roster aggregates hours/OT across every
  // payroll week overlapping [start, end] (overrides the single-week selector).
  const [range, setRange] = useState<DateRange | null>(null);
  const rangeRef = useRef<DateRange | null>(null);
  const [rangeMeta, setRangeMeta] = useState<{ weeks: number; start: string | null; end: string | null } | null>(null);
  const rangeMode = range != null;
  // Top-level mode: the roster, the weekly Statistics graph, or the live
  // Bank-changes feed (self-service payout edits via the external link).
  const [mode, setMode] = useState<'roster' | 'stats' | 'changes'>('roster');
  const [statsSeries, setStatsSeries] = useState<StatsSeries | null>(null);
  const [statsLeaders, setStatsLeaders] = useState<StatsLeader[] | null>(null);
  const [statsDepts, setStatsDepts] = useState<StatsDept[] | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const statsFetchedRef = useRef(false);

  // Fetch the roster for the CURRENT scope — a custom date range if one is set
  // (aggregated across weeks), otherwise the selected single week (`periodRef`;
  // '' = current week). Reads refs so refresh/realtime callers stay scope-aware.
  const load = useCallback(async (quiet: boolean) => {
    if (!quiet) setLoading(true);
    try {
      const rng = rangeRef.current;
      const src = periodRef.current;
      const url = rng
        ? `/api/people?start=${encodeURIComponent(rng.start)}&end=${encodeURIComponent(rng.end)}`
        : src
          ? `/api/people?source_file=${encodeURIComponent(src)}`
          : '/api/people';
      const res = await fetch(url, { cache: 'no-store' });
      const json = (await res.json()) as {
        rows?: RosterRow[]; sourceFile?: string; summary?: Summary;
        range?: { weeks: number; start: string | null; end: string | null } | null; error?: string;
      };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      const next = json.rows ?? [];
      setRows(next);
      setSummary(json.summary ?? null);
      setRangeMeta(json.range ?? null);
      setError(json.error ?? null);
      // Cache only the current/default single week so the next mount paints it
      // instantly — never a custom range or a non-default week.
      if (!rng && (!src || src === defaultFileRef.current)) setTabCache(TAB_CACHE_KEYS.peopleRoster, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const onPeriodChange = (v: string) => {
    setPeriod(v);
    periodRef.current = v;
    void load(false);
  };

  // Selecting a custom range overrides the single-week selector; clearing it
  // (null) reverts to whatever week is chosen in the dropdown.
  const onRangeChange = (v: DateRange | null) => {
    setRange(v);
    rangeRef.current = v;
    if (!v) setRangeMeta(null);
    void load(false);
  };

  // Statistics tab — lazy-fetch the weekly trend on first open.
  const openStats = () => {
    setMode('stats');
    if (statsFetchedRef.current) return;
    statsFetchedRef.current = true;
    setStatsLoading(true);
    fetch('/api/people/stats', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: {
        daily?: StatsPoint[]; weekly?: StatsPoint[]; monthly?: StatsPoint[];
        otLeaders?: StatsLeader[]; otDepts?: StatsDept[]; error?: string;
      }) => {
        setStatsSeries({ daily: j.daily ?? [], weekly: j.weekly ?? [], monthly: j.monthly ?? [] });
        setStatsLeaders(j.otLeaders ?? []);
        setStatsDepts(j.otDepts ?? []);
        setStatsError(j.error ?? null);
      })
      .catch((e) => setStatsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStatsLoading(false));
  };

  // Jump from the Bank-changes feed straight to a person's roster profile:
  // switch to the roster and open their detail dialog. If they aren't in the
  // current roster scope (a different pay week, offboarded, etc.), still land on
  // the roster filtered to them so it's clear who we were after.
  const openProfileByEmail = useCallback(
    (email: string | null) => {
      const target = (email ?? '').trim().toLowerCase();
      setMode('roster');
      if (!target) return;
      const match = rows.find((r) => (r.work_email ?? '').trim().toLowerCase() === target);
      if (match) {
        setShowExcluded(false);
        setSelected(match);
      } else {
        setQuery(email ?? '');
        toast.message(`${email} isn't in the current roster view — showing the roster.`);
      }
    },
    [rows],
  );

  // Reflect a profile edit (from the View Modal) into the in-memory roster + the
  // open dialog immediately, without a refetch. Admin/HR reflect it separately
  // via their own live refresh (same global_master_list table). Matches by the
  // stable master-row id. Warms the tab cache only when on the default scope
  // (mirrors load()), so a cached paint next mount isn't a stale non-default week.
  const handleRowUpdated = useCallback((master: MasterProfileFields) => {
    setRows((prev) => {
      const next = prev.map((r) => (r.id != null && r.id === master.id ? mergeMaster(r, master) : r));
      if (!rangeRef.current && (!periodRef.current || periodRef.current === defaultFileRef.current)) {
        setTabCache(TAB_CACHE_KEYS.peopleRoster, next);
      }
      return next;
    });
    // onRowUpdated only fires from the currently-open dialog, so the selection is
    // exactly this person — merge unconditionally.
    setSelected((sel) => (sel ? mergeMaster(sel, master) : sel));
  }, []);

  // Manual refresh — re-pull the SELECTED week in place (no skeleton flash) so a
  // change made in the Payroll Wizard shows up here without a full reload.
  const refresh = async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  };

  // On mount: populate the CSV period selector and load the current week.
  useEffect(() => {
    let alive = true;
    (async () => {
      let defaultFile = '';
      try {
        const r = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
        const j = (await r.json()) as {
          files?: string[];
          uploads?: { source_file: string | null; is_current: boolean }[];
        };
        const ups = j.uploads ?? [];
        const files = (j.files ?? ups.map((u) => u.source_file ?? '')).filter(Boolean) as string[];
        defaultFile = ups.find((u) => u.is_current)?.source_file ?? files[0] ?? '';
        if (alive) setPeriods(files.map((f) => ({ file: f, label: labelForSourceFile(f) })));
      } catch {
        /* selector stays empty; the roster still loads the current week below */
      }
      if (!alive) return;
      defaultFileRef.current = defaultFile;
      setPeriod(defaultFile);
      periodRef.current = defaultFile;
      void load(rows.length > 0);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Distinct, alphabetised departments for the filter dropdown.
  const departments = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => (r.department ?? '').trim()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (deptFilter !== 'all' && (r.department ?? '').trim() !== deptFilter) return false;
        if (otOnly && (r.hours.projectedOt ?? r.hours.ot) <= 0) return false;
        if (!q) return true;
        const name = (r.name ?? '').toLowerCase();
        const email = (r.work_email ?? '').toLowerCase();
        const dept = (r.department ?? '').toLowerCase();
        const id = (r.employee_id ?? '').toLowerCase();
        return name.includes(q) || email.includes(q) || dept.includes(q) || id.includes(q);
      })
      // Always present names A→Z (case-insensitive), regardless of API order.
      .sort(byName);
  }, [rows, query, deptFilter, otOnly]);

  // Reset to page 1 whenever the filters change so results never land on an
  // out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [query, deptFilter, otOnly]);

  // Paginate — 10 rows per page. safePage clamps after the result set shrinks.
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const otWatch = useMemo(
    () => rows.filter((r) => (r.hours.projectedOt ?? r.hours.ot) > 0).length,
    [rows],
  );

  // Friendly label for the active scope — a custom range (with the number of
  // payroll weeks it aggregated) or the single week chosen in the CSV selector.
  const periodLabel = useMemo(() => {
    if (range) {
      const base = formatPeriodRange(rangeMeta?.start ?? range.start, rangeMeta?.end ?? range.end);
      const wk = rangeMeta?.weeks;
      return wk != null ? `${base} · ${wk} payroll week${wk === 1 ? '' : 's'}` : base;
    }
    return periods.find((p) => p.file === period)?.label ?? (period ? labelForSourceFile(period) : 'Current week');
  }, [range, rangeMeta, periods, period]);

  // One-line description of the active in-view filter — carried into exports so a
  // downloaded roster says exactly what slice it captured.
  const filterLabel = useMemo(() => {
    const parts: string[] = [deptFilter === 'all' ? 'All departments' : deptFilter];
    if (otOnly) parts.push('OT only');
    const q = query.trim();
    if (q) parts.push(`matching "${q}"`);
    return parts.join(' · ');
  }, [deptFilter, otOnly, query]);

  // Earliest / latest dates present in the uploaded weeks — bounds the calendar
  // picker so the CEO can't range past the available data.
  const dataBounds = useMemo(() => {
    let min: string | null = null;
    let max: string | null = null;
    for (const p of periods) {
      const m = p.file.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      if (!min || m[1] < min) min = m[1];
      if (!max || m[2] > max) max = m[2];
    }
    return { min, max };
  }, [periods]);

  // Payouts to be sent this week = people who logged Hubstaff hours in the
  // selected pay week AND are in the Global Master List. The roster is already
  // built only from master-list employees, so "in master list" is implicit.
  // The excluded set (no hours this week) powers the "Payouts to send" modal.
  const excludedRows = useMemo(() => rows.filter((r) => !(r.hours.thisWeek > 0)).sort(byName), [rows]);
  const payoutCount = rows.length - excludedRows.length;

  // People in the roster with NO bank / payout method on file at all — powers the
  // "Missing bank info" KPI card + its drill-down modal. Roster-wide (not scoped
  // to the selected pay week), since payout details don't vary by period.
  // US employees (department "USEE") are an accepted exception — they're paid
  // through a separate channel, so we don't flag them as missing bank info.
  const noBankingRows = useMemo(
    () =>
      rows
        .filter((r) => !r.hasBanking && (r.department ?? '').trim().toUpperCase() !== 'USEE')
        .sort(byName),
    [rows],
  );

  return (
    // data-readonly-allow: People is a read surface (browse, search, reveal-banking
    // is itself audited), so we don't want ReadOnlyTab swallowing row clicks.
    <div data-readonly-allow className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <Users className="h-5 w-5 shrink-0 text-zinc-400" /> People
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Everyone, searchable — hours this week, pay rate, and banking.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', accent.chipBg, accent.chipText)}>
              {rows.length} people
            </span>
            {otWatch > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-600 dark:bg-red-950/30 dark:text-red-300">
                <AlertTriangle className="h-3 w-3" /> {otWatch} {rangeMode ? 'with overtime' : 'on track for OT'}
              </span>
            )}
            {mode === 'roster' && (
              <ExportMenu
                rows={filtered}
                periodTotal={rows.length}
                periodLabel={periodLabel}
                filterLabel={filterLabel}
                rangeMode={rangeMode}
                otPayoutUsd={summary?.otPayoutUsd ?? null}
                otPayoutPhp={summary?.otPayoutPhp ?? 0}
                accent={accent}
              />
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 px-2.5 text-[12px]"
              onClick={refresh}
              disabled={refreshing || (loading && rows.length === 0)}
              aria-label="Refresh roster"
              title="Pull the latest hours, rates, and payroll changes"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>
        {/* Top-level tabs: Roster · Statistics · live Bank-changes feed. */}
        <div role="tablist" className="mt-3 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
          {([['roster', 'Roster'], ['stats', 'Statistics'], ['changes', 'Bank changes']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => (id === 'stats' ? openStats() : setMode(id))}
              className={cn(
                'relative px-3 py-2 text-[13px] font-medium transition-colors',
                mode === id
                  ? 'text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {label}
              {mode === id && <span className={cn('absolute inset-x-2 -bottom-px h-0.5 rounded-full', accent.bar)} />}
            </button>
          ))}
        </div>

        {mode === 'roster' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              type="search"
              placeholder="Search name, work email, department, or ID…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={cn('pl-9', accent.ring)}
              aria-label="Search people"
            />
          </div>
          <SmoothSelect
            value={deptFilter}
            onChange={setDeptFilter}
            aria-label="Filter by department"
            className="w-full shrink-0 sm:w-48"
            options={[
              { value: 'all', label: 'All departments' },
              ...departments.map((d) => ({ value: d, label: d })),
            ]}
          />
          {/* Show only people who rendered (or are on track for) overtime. */}
          <Button
            type="button"
            variant="outline"
            onClick={() => setOtOnly((v) => !v)}
            aria-pressed={otOnly}
            title="Show only people with overtime this week"
            className={cn(
              'h-9 shrink-0 gap-1.5 px-3 text-[13px]',
              otOnly &&
                'border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60',
            )}
          >
            <AlertTriangle className="h-3.5 w-3.5" /> OT only
          </Button>
          {/* CSV period selector — scopes hours / OT / KPIs to a chosen week.
              Disabled while a custom range is active (the range overrides it). */}
          <SmoothSelect
            value={period}
            onChange={onPeriodChange}
            disabled={rangeMode}
            aria-label="Pay week"
            className="w-full shrink-0 sm:w-52"
            options={
              periods.length
                ? periods.map((p) => ({ value: p.file, label: p.label }))
                : period
                  ? [{ value: period, label: labelForSourceFile(period) }]
                  : [{ value: '', label: 'Current week' }]
            }
          />
          {/* Custom date-range picker — aggregates hours/OT across the range. */}
          <DateRangePicker
            value={range}
            onChange={onRangeChange}
            accent={accent}
            min={dataBounds.min}
            max={dataBounds.max ?? todayIso()}
            className="w-full shrink-0 sm:w-56"
          />
        </div>
        )}
        {mode === 'roster' && rangeMode && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <CalendarDays className="h-3 w-3 shrink-0" />
            Aggregating hours &amp; pay across <span className="font-medium text-zinc-700 dark:text-zinc-200">{periodLabel}</span>. Weekly OT projection is hidden in range mode.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {mode === 'stats' ? (
          <PeopleStatsChart series={statsSeries} leaders={statsLeaders} depts={statsDepts} periods={periods} loading={statsLoading} error={statsError} accent={accent} />
        ) : mode === 'changes' ? (
          <PeopleBankChanges accent={accent} onOpenProfile={openProfileByEmail} />
        ) : (
        <>
        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Week KPI cards — overtime headcount + estimated OT payout for the
            selected week (USD primary, PHP small). */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Employees with overtime
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {summary?.otEmployees ?? 0}
              </span>
              <span className="text-[12px] text-zinc-400">
                of {rows.length} · {fmtHours(summary?.otHours ?? 0)} OT
              </span>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <Banknote className="h-3.5 w-3.5 text-emerald-500" /> {rangeMode ? 'OT payout in range' : 'OT payout this week'}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {fmtMoney(summary?.otPayoutUsd ?? 0, 'USD')}
              </span>
              <span className="text-[12px] tabular-nums text-zinc-400">{fmtMoney(summary?.otPayoutPhp ?? 0, 'PHP')}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowExcluded(true)}
            className="group rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-sky-300 hover:bg-sky-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-sky-800/70 dark:hover:bg-sky-950/20"
            title="See who has no payout this week and why"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                <Send className="h-3.5 w-3.5 text-sky-500" /> Payouts to send
              </div>
              <span className="flex items-center gap-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
                {excludedRows.length} excluded
                <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {payoutCount}
              </span>
              <span className="text-[12px] text-zinc-400">of {rows.length}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-400">
              <CalendarDays className="h-3 w-3 shrink-0" /> <span className="truncate">{periodLabel}</span>
            </div>
          </button>
          {/* People with no bank / payout method on file — click to see who. */}
          <button
            type="button"
            onClick={() => setShowNoBanking(true)}
            className="group rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-rose-300 hover:bg-rose-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-rose-800/70 dark:hover:bg-rose-950/20"
            title="See who has no bank / payout details on file"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                <Landmark className="h-3.5 w-3.5 text-rose-500" /> Missing bank info
              </div>
              <span className="flex items-center gap-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                View
                <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span
                className={cn(
                  'text-2xl font-semibold tabular-nums',
                  noBankingRows.length > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-900 dark:text-zinc-100',
                )}
              >
                {noBankingRows.length}
              </span>
              <span className="text-[12px] text-zinc-400">of {rows.length}</span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-zinc-400">
              {noBankingRows.length === 0 ? 'Everyone has payout details' : 'No payout method on file yet'}
            </div>
          </button>
        </div>

        {loading && rows.length === 0 ? (
          <RosterSkeleton />
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center text-sm text-zinc-500">
            {query.trim() || deptFilter !== 'all' || otOnly
              ? 'No people match the current filters.'
              : 'No people to show.'}
          </div>
        ) : (
          <>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="px-3 py-2.5 font-medium">Person</th>
                  <th className="px-3 py-2.5 font-medium">Employee ID</th>
                  <th className="px-3 py-2.5 font-medium">Department</th>
                  <th className="px-3 py-2.5 font-medium">{rangeMode ? 'Hours in range' : 'Hours this week'}</th>
                  <th className="px-3 py-2.5 font-medium">Pay rate</th>
                  <th className="px-3 py-2.5 font-medium">Payout</th>
                  <th className="px-3 py-2.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => (
                  <tr
                    key={`${r.work_email ?? r.employee_id ?? r.name ?? 'row'}|${r.name ?? ''}|${i}`}
                    className="cursor-pointer border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
                    onClick={() => setSelected(r)}
                  >
                    <td className="px-3 py-2.5" data-label="Person">
                      <div className="flex items-center gap-2.5">
                        <TeamAvatar name={r.name ?? ''} email={r.work_email} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">{r.name ?? '—'}</div>
                          <div className="truncate text-[11px] text-zinc-400">{r.work_email ?? r.employee_id ?? ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5" data-label="Employee ID">
                      {r.employee_id ? (
                        <span className="font-mono text-[12px] text-zinc-600 dark:text-zinc-300">{r.employee_id}</span>
                      ) : (
                        <span className="text-[11px] text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-300" data-label="Department">
                      {formatDeptLabel(r.department) || '—'}
                    </td>
                    <td className="px-3 py-2.5" data-label={rangeMode ? 'Hours in range' : 'Hours this week'}>
                      <HoursCell hours={r.hours} />
                    </td>
                    <td className="px-3 py-2.5 text-zinc-700 dark:text-zinc-200" data-label="Pay rate">
                      {r.rate.regular != null ? (
                        <span>
                          {fmtMoney(r.rate.regular, r.rate.currency)}
                          <span className="text-[11px] text-zinc-400">/hr</span>
                          {r.rate.ot != null && (
                            <span className="ml-1 text-[11px] text-zinc-400">
                              · OT {fmtMoney(r.rate.ot, r.rate.currency)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-zinc-400">not set</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5" data-label="Payout">
                      {r.processor ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium capitalize text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          <Banknote className="h-3 w-3" /> {r.processor}
                        </span>
                      ) : (
                        <span className="text-[11px] text-zinc-400">{r.hasBanking ? 'on file' : 'none'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right" data-label="">
                      <div className="flex items-center justify-end gap-1.5">
                        {canPay && (
                          <Button
                            type="button"
                            size="sm"
                            className={cn('h-7 gap-1 px-2 text-[12px]', accent.btn)}
                            disabled={!r.work_email}
                            title={r.work_email ? 'Send a one-off payment' : 'No work email on file'}
                            onClick={(e) => { e.stopPropagation(); setPayTarget(r); }}
                          >
                            <Banknote className="h-3.5 w-3.5" /> Pay
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[12px]"
                          onClick={(e) => { e.stopPropagation(); setSelected(r); }}
                        >
                          View
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div data-readonly-allow className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-500">
            <span>
              Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[12px]"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </Button>
                <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                  Page {safePage} of {totalPages}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[12px]"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
          </>
        )}
        </>
        )}
      </div>

      {selected && (
        <PersonDetailDialog
          key={selected.id ?? selected.work_email ?? selected.employee_id ?? selected.name ?? 'person'}
          row={selected}
          accent={accent}
          canEdit={canEdit}
          canPay={canPay}
          onPay={(r) => { setSelected(null); setPayTarget(r); }}
          onClose={() => setSelected(null)}
          onRowUpdated={handleRowUpdated}
        />
      )}

      {payTarget && (
        <PayDialog
          row={payTarget}
          accent={accent}
          onClose={() => setPayTarget(null)}
        />
      )}

      {showExcluded && (
        <ExcludedPayoutDialog
          rows={excludedRows}
          periodLabel={periodLabel}
          onClose={() => setShowExcluded(false)}
          onSelect={(r) => { setShowExcluded(false); setSelected(r); }}
        />
      )}

      {showNoBanking && (
        <MissingBankInfoDialog
          rows={noBankingRows}
          rangeMode={rangeMode}
          periodLabel={periodLabel}
          canEdit={canEdit}
          onClose={() => setShowNoBanking(false)}
          onSelect={(r) => { setShowNoBanking(false); setSelected(r); }}
        />
      )}
    </div>
  );
}

/* ── Export menu (PDF · XLSX · CSV — themed like the CEO dashboard) ────────── */

type ExportFormat = 'pdf' | 'xlsx' | 'csv';

/** Download the roster currently in view (respecting search / department / OT
 *  filter and the selected week or range) as a branded PDF, an Excel workbook,
 *  or a flat CSV. Fully client-side — the rows are already loaded. */
function ExportMenu({
  rows,
  periodTotal,
  periodLabel,
  filterLabel,
  rangeMode,
  otPayoutUsd,
  otPayoutPhp,
  accent,
}: {
  rows: RosterRow[];
  periodTotal: number;
  periodLabel: string;
  filterLabel: string;
  rangeMode: boolean;
  otPayoutUsd: number | null;
  otPayoutPhp: number;
  accent: Accent;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const runExport = useCallback(
    async (format: ExportFormat) => {
      if (rows.length === 0) {
        toast.error('Nothing to export in this view.');
        return;
      }
      setBusy(format);
      setOpen(false);
      try {
        const model = buildRosterExport({
          rows,
          periodTotal,
          periodLabel,
          filterLabel,
          hoursHeader: rangeMode ? 'Hours in range' : 'Hours this week',
          rangeMode,
          periodOtPayoutUsd: otPayoutUsd,
          periodOtPayoutPhp: otPayoutPhp,
        });
        if (format === 'csv') {
          downloadRosterCsv(model);
        } else if (format === 'xlsx') {
          downloadRosterXlsx(model);
        } else {
          await downloadRosterPdf(model);
        }
        toast.success(`Exported ${rows.length.toLocaleString()} ${rows.length === 1 ? 'person' : 'people'} as ${format.toUpperCase()}.`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Failed to export ${format.toUpperCase()}`);
      } finally {
        setBusy(null);
      }
    },
    [rows, periodTotal, periodLabel, filterLabel, rangeMode, otPayoutUsd, otPayoutPhp],
  );

  const items: { format: ExportFormat; label: string; hint: string; Icon: typeof FileText }[] = [
    { format: 'pdf', label: 'PDF', hint: 'Branded document', Icon: FileText },
    { format: 'xlsx', label: 'Excel', hint: 'XLSX workbook', Icon: FileSpreadsheet },
    { format: 'csv', label: 'CSV', hint: 'Plain data', Icon: Table2 },
  ];

  return (
    <div ref={wrapRef} className="relative">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Export the roster in view (CSV · Excel · PDF)"
        className={cn('h-8 gap-1.5 px-2.5 text-[12px]', accent.ring)}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{busy ? `Exporting ${busy.toUpperCase()}…` : 'Export'}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
              Export {rows.length.toLocaleString()} {rows.length === 1 ? 'person' : 'people'}
            </p>
            {items.map(({ format, label, hint, Icon }) => (
              <button
                key={format}
                type="button"
                role="menuitem"
                onClick={() => void runExport(format)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-amber-50 dark:hover:bg-amber-950/30"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-sm">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</span>
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Excluded-from-payout modal ─────────────────────────────────────────── */

function ExcludedPayoutDialog({
  rows,
  periodLabel,
  onClose,
  onSelect,
}: {
  rows: RosterRow[];
  periodLabel: string;
  onClose: () => void;
  onSelect: (r: RosterRow) => void;
}) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (r) =>
        (r.name ?? '').toLowerCase().includes(term) ||
        (r.work_email ?? '').toLowerCase().includes(term) ||
        (r.department ?? '').toLowerCase().includes(term),
    );
  }, [rows, q]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex max-h-[88vh] flex-col">
          <DialogHeader className="shrink-0 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
            <DialogTitle className="text-lg">Not in this week&apos;s payout</DialogTitle>
            <DialogDescription>
              {rows.length} {rows.length === 1 ? 'person is' : 'people are'} in the Global Master List but logged no
              Hubstaff hours for {periodLabel}, so they have no payout to be sent this week.
            </DialogDescription>
          </DialogHeader>

          <div className="shrink-0 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, email, or department…"
                className="h-9 pl-8 text-[13px]"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {list.length === 0 ? (
              <p className="py-12 text-center text-sm text-zinc-500">
                {rows.length === 0
                  ? 'Everyone in the Master List has Hubstaff hours this week.'
                  : 'No one matches your search.'}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {list.map((r, i) => {
                  const noRate = r.rate.regular == null && r.rate.ot == null;
                  return (
                    <li key={`${r.work_email ?? r.employee_id ?? r.name ?? 'row'}|${r.name ?? ''}|${i}`}>
                      <button
                        type="button"
                        onClick={() => onSelect(r)}
                        className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50"
                      >
                        <TeamAvatar name={r.name ?? ''} email={r.work_email} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{r.name ?? '—'}</div>
                          <div className="truncate text-[11px] text-zinc-400">
                            {formatDeptLabel(r.department) || '—'} · {r.work_email ?? r.employee_id ?? ''}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                          <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                            No hours this week
                          </span>
                          {noRate && (
                            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                              No pay rate
                            </span>
                          )}
                          {!r.hasBanking && (
                            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                              No payout details
                            </span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-200 px-5 py-3 text-[11px] text-zinc-400 dark:border-zinc-800">
            Showing {list.length} of {rows.length}. Click anyone to open their full record.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Missing-bank-info modal ────────────────────────────────────────────── */

function MissingBankInfoDialog({
  rows,
  rangeMode,
  periodLabel,
  canEdit,
  onClose,
  onSelect,
}: {
  rows: RosterRow[];
  rangeMode: boolean;
  periodLabel: string;
  canEdit: boolean;
  onClose: () => void;
  onSelect: (r: RosterRow) => void;
}) {
  const [q, setQ] = useState('');
  // Emails notified this session (button flips to "Notified") and those with an
  // in-flight request (spinner). Session-only — reopening the modal resets them.
  const [notified, setNotified] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notifyingAll, setNotifyingAll] = useState(false);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (r) =>
        (r.name ?? '').toLowerCase().includes(term) ||
        (r.work_email ?? '').toLowerCase().includes(term) ||
        (r.department ?? '').toLowerCase().includes(term),
    );
  }, [rows, q]);
  // People with no payout method who ALSO logged hours in the current scope are
  // the urgent ones — they're owed a payout but there's nowhere to send it.
  const owedNow = useMemo(() => rows.filter((r) => r.hours.thisWeek > 0).length, [rows]);
  // Notifiable = currently-shown people with a work email we haven't notified yet.
  const notifiable = useMemo(
    () =>
      list.filter((r) => {
        const e = (r.work_email ?? '').trim().toLowerCase();
        return !!e && !notified.has(e);
      }),
    [list, notified],
  );

  const notify = async (targets: RosterRow[]) => {
    const emails = Array.from(
      new Set(targets.map((t) => (t.work_email ?? '').trim().toLowerCase()).filter(Boolean)),
    );
    if (emails.length === 0) {
      toast.error('No work email on file to notify.');
      return;
    }
    // Pass names purely to personalise the email greeting ("Hi Ana," vs
    // "Hi there,"); the server still derives who gets notified from `emails`.
    const recipients = targets
      .map((t) => ({ email: (t.work_email ?? '').trim().toLowerCase(), name: t.name ?? '' }))
      .filter((r) => r.email);
    setBusy((prev) => new Set([...prev, ...emails]));
    try {
      const res = await fetch('/api/people/request-bank-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails, recipients }),
      });
      const json = (await res.json()) as { ok?: boolean; notified?: number; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setNotified((prev) => new Set([...prev, ...emails]));
      const n = json.notified ?? emails.length;
      toast.success(
        n === 1 ? 'Notified them to add their bank details.' : `Notified ${n} people to add their bank details.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the notification.');
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        emails.forEach((x) => next.delete(x));
        return next;
      });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex max-h-[88vh] flex-col">
          <DialogHeader className="shrink-0 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Landmark className="h-5 w-5 text-rose-500" /> Missing bank information
            </DialogTitle>
            <DialogDescription>
              {rows.length} {rows.length === 1 ? 'person has' : 'people have'} no bank or payout method on file
              {owedNow > 0 && (
                <> — <span className="font-medium text-amber-600 dark:text-amber-400">{owedNow} owed a payout {rangeMode ? 'in the selected range' : 'this week'}</span></>
              )}
              .{canEdit ? ' Notify anyone to blink their dashboard toward adding payout details.' : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, email, or department…"
                className="h-9 pl-8 text-[13px]"
              />
            </div>
            {canEdit && (
              <Button
                type="button"
                size="sm"
                disabled={notifiable.length === 0 || notifyingAll}
                onClick={async () => { setNotifyingAll(true); await notify(notifiable); setNotifyingAll(false); }}
                title={notifiable.length === 0 ? 'Everyone shown has already been notified' : 'Notify everyone shown to add their bank details'}
                className="h-9 shrink-0 gap-1.5 bg-rose-600 px-3 text-[12px] text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-500"
              >
                {notifyingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bell className="h-3.5 w-3.5" />}
                <span className="whitespace-nowrap">Notify all{notifiable.length > 0 ? ` (${notifiable.length})` : ''}</span>
              </Button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {list.length === 0 ? (
              <p className="py-12 text-center text-sm text-zinc-500">
                {rows.length === 0
                  ? 'Everyone in the roster has bank details on file.'
                  : 'No one matches your search.'}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {list.map((r, i) => {
                  const email = (r.work_email ?? '').trim().toLowerCase();
                  const done = !!email && notified.has(email);
                  const inFlight = !!email && busy.has(email);
                  return (
                    <li key={`${r.work_email ?? r.employee_id ?? r.name ?? 'row'}|${r.name ?? ''}|${i}`}>
                      <div className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50">
                        <button
                          type="button"
                          onClick={() => onSelect(r)}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-rose-400"
                        >
                          <TeamAvatar name={r.name ?? ''} email={r.work_email} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{r.name ?? '—'}</div>
                            <div className="truncate text-[11px] text-zinc-400">
                              {formatDeptLabel(r.department) || '—'} · {r.work_email ?? r.employee_id ?? ''}
                            </div>
                          </div>
                        </button>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                          <span className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[10.5px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                            No payout details
                          </span>
                          {r.hours.thisWeek > 0 && (
                            <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                              {rangeMode ? 'Owed in range' : 'Owed this week'}
                            </span>
                          )}
                          {canEdit && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!email || inFlight || done}
                              onClick={() => notify([r])}
                              title={
                                !email
                                  ? 'No work email on file to notify'
                                  : done
                                    ? 'Notified this session'
                                    : 'Notify this person to add their bank details'
                              }
                              className={cn(
                                'h-7 gap-1 px-2 text-[11.5px]',
                                done && 'border-emerald-300 text-emerald-600 dark:border-emerald-800/70 dark:text-emerald-400',
                              )}
                            >
                              {inFlight ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : done ? (
                                <Check className="h-3 w-3" />
                              ) : (
                                <Bell className="h-3 w-3" />
                              )}
                              {done ? 'Notified' : 'Notify'}
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-200 px-5 py-3 text-[11px] text-zinc-400 dark:border-zinc-800">
            Showing {list.length} of {rows.length}. Click anyone to open their full record{canEdit ? ', or Notify to nudge them' : ''}.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Round up to a clean axis maximum (1/2/5 × 10ⁿ). */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function fmtUsdAxis(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return `$${Math.round(v)}`;
}

/** "2026-06-22" → "Jun 22" (local, no TZ shift). */
function shortDayLabel(iso: string): string {
  const d = parseIsoLocal(iso);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : iso;
}

/**
 * An x-axis / tooltip label for one trend bucket, adapted to the granularity:
 *   daily   → "Jun 22"        weekly  → "Jun 22"
 *   monthly → "Jun" (or "Jun '26" when the series spans years)
 */
function bucketAxisLabel(iso: string, granularity: Granularity, multiYear: boolean): string {
  const d = parseIsoLocal(iso);
  if (!d) return iso;
  if (granularity === 'monthly') {
    return multiYear
      ? d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      : d.toLocaleDateString('en-US', { month: 'short' });
  }
  return shortDayLabel(iso);
}

/** Tooltip header for one bucket: a single day, a week range, or a named month. */
function bucketRangeLabel(start: string, end: string, granularity: Granularity): string {
  if (granularity === 'daily') return formatDay(start);
  if (granularity === 'monthly') {
    const d = parseIsoLocal(start);
    return d ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : start;
  }
  return `${shortDayLabel(start)} – ${shortDayLabel(end)}`;
}

/**
 * The Daily / Weekly / Monthly trend granularity control. A motion-driven pill
 * slides under the active segment (a real state cue, not a colour swap); reduced
 * motion collapses it to an instant move. Drives both trend charts.
 */
function GranularityToggle({
  value,
  onChange,
  accent,
  reduceMotion,
}: {
  value: Granularity;
  onChange: (g: Granularity) => void;
  accent: Accent;
  reduceMotion: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label="Trend granularity"
      className="inline-flex shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      {GRANULARITY_ORDER.map((g) => {
        const active = value === g;
        return (
          <button
            key={g}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(g)}
            className={cn(
              'relative rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-150',
              active
                ? accent.chipText
                : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            {active && (
              <motion.span
                layoutId="ot-granularity-pill"
                aria-hidden
                className={cn('absolute inset-0 rounded-md shadow-sm', accent.chipBg)}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              />
            )}
            <span className="relative z-10">{GRANULARITY_META[g].label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A loading placeholder for one trend chart: faint gridlines + ghost lines that
 *  pulse. Uses the SAME aspect ratio as the real SVG so nothing jumps on swap. */
function ChartSkeleton({ aspectClass }: { aspectClass: string }) {
  const grid = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className={cn('relative w-full', aspectClass)}>
      {grid.map((g, i) => (
        <div key={i} className="absolute inset-x-0 border-t border-zinc-100 dark:border-zinc-800/70" style={{ top: `${g * 100}%` }} />
      ))}
      <svg className="absolute inset-0 h-full w-full animate-pulse text-zinc-200 dark:text-zinc-700" preserveAspectRatio="none" viewBox="0 0 100 40" aria-hidden>
        <polyline points="0,30 14,25 28,27 42,18 56,21 70,12 84,15 100,7" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <polyline points="0,36 14,33 28,34 42,30 56,32 70,28 84,29 100,25" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/**
 * Statistics-tab loading state — mirrors the real two-column layout (KPI cards +
 * the two trend charts on the left, the OT-standings table on the right) so the
 * transition to loaded content is seamless rather than a spinner-to-grid jump.
 */
function StatsSkeleton() {
  const card = 'rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950';
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start" aria-hidden>
      {/* LEFT: KPIs + the two trend charts */}
      <div className="space-y-3 lg:space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className={card}>
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-2 h-7 w-24" />
              <Skeleton className="mt-2 h-2.5 w-28" />
            </div>
          ))}
        </div>
        <div className={card}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-7 w-44 rounded-lg" />
          </div>
          <div className="mb-3 flex gap-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-28" />
          </div>
          <ChartSkeleton aspectClass="aspect-[760/260]" />
        </div>
        <div className={card}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-52" />
            <Skeleton className="h-7 w-36 rounded-lg" />
          </div>
          <div className="mb-2 flex flex-wrap gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-20" />
            ))}
          </div>
          <ChartSkeleton aspectClass="aspect-[760/210]" />
        </div>
      </div>

      {/* RIGHT: OT standings */}
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-2.5 w-40" />
          </div>
          <Skeleton className="h-7 w-48 rounded-lg" />
        </div>
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <Skeleton className="h-7 w-40 rounded-lg" />
          <Skeleton className="h-7 flex-1 rounded-md" />
        </div>
        <div>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5 last:border-0 dark:border-zinc-900">
              <Skeleton className="h-3 w-4 shrink-0" />
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-2.5 w-44 max-w-[70%]" />
              </div>
              <Skeleton className="h-3.5 w-12 shrink-0" />
              <Skeleton className="h-3.5 w-16 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * OT trend — a self-contained dual-axis SVG line chart (no chart lib). Left axis
 * + emerald line = OT payout (USD); right axis + amber line = number of people on
 * overtime. A Daily / Weekly / Monthly toggle rebuckets the series; on change the
 * line re-scales and draws on. The OT-by-department chart below follows the same
 * granularity. The standings leaderboard on the right keeps its own week selector.
 */
function PeopleStatsChart({
  series,
  leaders,
  depts,
  periods,
  loading,
  error,
  accent,
}: {
  series: StatsSeries | null;
  leaders: StatsLeader[] | null;
  depts: StatsDept[] | null;
  periods: { file: string; label: string }[];
  loading: boolean;
  error: string | null;
  accent: Accent;
}) {
  const [granularity, setGranularity] = useState<Granularity>('weekly');
  const [hover, setHover] = useState<number | null>(null);
  const [sort, setSort] = useState<OtSort>('hours');
  const [tab, setTab] = useState<OtTab>('people');
  const [leaderPage, setLeaderPage] = useState(1);
  const [leaderQuery, setLeaderQuery] = useState('');
  const LEADERS_PER_PAGE = 10;
  // CSV period the leaderboard follows. '' = the cross-week aggregate ("All
  // recent weeks"); any other value is a Hubstaff source_file fetched on demand
  // so both tabs are authoritatively scoped to the selected week.
  const [statsPeriod, setStatsPeriod] = useState('');
  const [weekData, setWeekData] = useState<Record<string, { leaders: StatsLeader[]; depts: StatsDept[] }>>({});
  const reduceMotion = useReducedMotion();

  // Fetch the selected week's OT leaders + department rollup on demand (cached
  // per file). '' uses the aggregates passed in, so it never fetches.
  useEffect(() => {
    const file = statsPeriod;
    if (!file || weekData[file]) return;
    let alive = true;
    fetch(`/api/people/stats?source_file=${encodeURIComponent(file)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { leaders?: StatsLeader[]; depts?: StatsDept[] }) => {
        if (alive) setWeekData((prev) => ({ ...prev, [file]: { leaders: j.leaders ?? [], depts: j.depts ?? [] } }));
      })
      .catch(() => { if (alive) setWeekData((prev) => ({ ...prev, [file]: { leaders: [], depts: [] } })); });
    return () => { alive = false; };
  }, [statsPeriod, weekData]);

  // Bucket indices change meaning between granularities, so drop the hover guide.
  useEffect(() => { setHover(null); }, [granularity]);

  // Ambient auto-cycle: once the view sits idle for AUTOPLAY_IDLE_MS, step
  // through Daily → Weekly → Monthly every AUTOPLAY_STEP_MS using the same
  // smooth transitions. Any manual interaction (toggle click or touching a
  // chart) stops it and restarts the idle wait. Skipped under reduced motion —
  // auto-advancing content is exactly the motion those users opt out of.
  const [autoPlay, setAutoPlay] = useState(false);
  const [interactionNonce, setInteractionNonce] = useState(0);
  const onUserInteract = useCallback(() => {
    setAutoPlay(false);
    setInteractionNonce((k) => k + 1);
  }, []);
  useEffect(() => {
    if (reduceMotion || autoPlay) return;
    const t = setTimeout(() => setAutoPlay(true), AUTOPLAY_IDLE_MS);
    return () => clearTimeout(t);
  }, [reduceMotion, autoPlay, interactionNonce]);
  useEffect(() => {
    if (!autoPlay) return;
    const id = setInterval(() => {
      setGranularity((g) => GRANULARITY_ORDER[(GRANULARITY_ORDER.indexOf(g) + 1) % GRANULARITY_ORDER.length]);
    }, AUTOPLAY_STEP_MS);
    return () => clearInterval(id);
  }, [autoPlay]);

  if (loading && !series) {
    return <StatsSkeleton />;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        {error}
      </div>
    );
  }
  // The selected granularity drives the two trend charts; the weekly count still
  // labels the standings leaderboard's "All recent weeks" aggregate.
  const data = series?.[granularity] ?? [];
  const weeklyCount = series?.weekly.length ?? 0;
  const hasAnyData = !!series && (series.daily.length + series.weekly.length + series.monthly.length) > 0;
  if (!hasAnyData) {
    return <div className="py-24 text-center text-sm text-zinc-500">No payroll data to chart yet.</div>;
  }

  const W = 760;
  const H = 260;
  const padL = 56;
  const padR = 48;
  const padT = 14;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = data.length;
  const xAt = (i: number) => (n === 1 ? padL + plotW / 2 : padL + (i * plotW) / (n - 1));

  const usdTop = niceCeil(Math.max(1, ...data.map((d) => d.otPayoutUsd ?? 0)));
  const cntTop = niceCeil(Math.max(1, ...data.map((d) => d.otEmployees)));
  const yUsd = (v: number) => padT + plotH - (v / usdTop) * plotH;
  const yCnt = (v: number) => padT + plotH - (v / cntTop) * plotH;

  // Paths (not polylines) so the line can draw on via motion's pathLength.
  const toPathD = (yOf: (v: number) => number, valOf: (d: StatsPoint) => number) =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yOf(valOf(d))}`).join(' ');
  const payoutPath = toPathD(yUsd, (d) => d.otPayoutUsd ?? 0);
  const countPath = toPathD(yCnt, (d) => d.otEmployees);
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const latest = data.length ? data[data.length - 1] : null;
  const multiYear = new Set(data.map((d) => d.weekStart.slice(0, 4))).size > 1;
  const axisLabel = (iso: string) => bucketAxisLabel(iso, granularity, multiYear);
  // Re-mount + re-draw the line layer whenever the granularity (and thus the
  // whole bucket set + axis scale) changes.
  const lineKey = `${granularity}`;
  const gran = GRANULARITY_META[granularity];

  // Both tabs follow the CSV period selector authoritatively: '' uses the
  // cross-week aggregate; any other value is that week's server-fetched data.
  // The selector lists the same CSV periods as the roster.
  const isAggregate = statsPeriod === '';
  const activeLeaders = isAggregate ? leaders ?? [] : weekData[statsPeriod]?.leaders ?? [];
  const activeDepts = isAggregate ? depts ?? [] : weekData[statsPeriod]?.depts ?? [];
  const weekPending = !isAggregate && weekData[statsPeriod] === undefined;
  const statsPeriodOptions = [
    { value: '', label: 'All recent weeks' },
    ...periods.map((p) => ({ value: p.file, label: p.label })),
  ];
  const periodLabel = isAggregate
    ? `last ${weeklyCount} week${weeklyCount === 1 ? '' : 's'}`
    : periods.find((p) => p.file === statsPeriod)?.label ?? labelForSourceFile(statsPeriod);

  // Both lists rank by the chosen key. otPayoutUsd is FX-normalised so it ranks
  // correctly across currencies; fall back to PHP when no FX is available.
  const byMetric = <T extends { otHours: number; otPayoutPhp: number; otPayoutUsd: number | null }>(a: T, b: T) =>
    sort === 'pay'
      ? (b.otPayoutUsd ?? b.otPayoutPhp ?? 0) - (a.otPayoutUsd ?? a.otPayoutPhp ?? 0)
      : b.otHours - a.otHours;
  const lq = leaderQuery.trim().toLowerCase();

  const isPeople = tab === 'people';
  const sortedLeaders = activeLeaders.slice().sort(byMetric);
  const filteredLeaders = lq
    ? sortedLeaders.filter(
        (l) => (l.name ?? '').toLowerCase().includes(lq) || (l.email ?? '').toLowerCase().includes(lq),
      )
    : sortedLeaders;
  const sortedDepts = activeDepts.slice().sort(byMetric);
  const filteredDepts = lq ? sortedDepts.filter((d) => d.department.toLowerCase().includes(lq)) : sortedDepts;

  const activeCount = isPeople ? activeLeaders.length : activeDepts.length;
  const filteredCount = isPeople ? filteredLeaders.length : filteredDepts.length;
  const leaderTotalPages = Math.max(1, Math.ceil(filteredCount / LEADERS_PER_PAGE));
  const leaderSafePage = Math.min(leaderPage, leaderTotalPages);
  const leaderStart = (leaderSafePage - 1) * LEADERS_PER_PAGE;
  const pageLeaders = filteredLeaders.slice(leaderStart, leaderStart + LEADERS_PER_PAGE);
  const pageDepts = filteredDepts.slice(leaderStart, leaderStart + LEADERS_PER_PAGE);
  // Re-animate the standings body whenever the tab, period, sort, or page change
  // (but NOT on each search keystroke — that would feel janky).
  const contentKey = `${tab}|${statsPeriod}|${sort}|${leaderSafePage}`;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
      {/* LEFT column: KPIs + the OT-by-employee chart + the OT-by-department chart. */}
      <div className="space-y-3 lg:space-y-4">
      {/* Latest-bucket headline — adapts to the selected granularity. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            <Banknote className="h-3.5 w-3.5 text-emerald-500" /> {gran.latest} OT payout
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{fmtMoney(latest?.otPayoutUsd ?? 0, 'USD')}</span>
            <span className="text-[12px] tabular-nums text-zinc-400">{fmtMoney(latest?.otPayoutPhp ?? 0, 'PHP')}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{latest ? bucketRangeLabel(latest.weekStart, latest.weekEnd, granularity) : '—'}</div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> {gran.latest} on overtime
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{latest?.otEmployees ?? 0}</span>
            <span className="text-[12px] text-zinc-400">people · {fmtHours(latest?.otHours ?? 0)} OT</span>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">across {n} {n === 1 ? gran.unit : `${gran.unit}s`}</div>
        </div>
      </div>

      {/* Trend chart */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">OT pay out over time</div>
          <div className="flex items-center gap-2">
            <AnimatePresence initial={false}>
              {autoPlay && (
                <motion.button
                  type="button"
                  onClick={onUserInteract}
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                  title="Auto-cycling Daily / Weekly / Monthly — click to stop"
                  aria-label="Stop auto-cycling the trend granularity"
                >
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                  </span>
                  Auto
                </motion.button>
              )}
            </AnimatePresence>
            <GranularityToggle
              value={granularity}
              onChange={(g) => { onUserInteract(); setGranularity(g); }}
              accent={accent}
              reduceMotion={!!reduceMotion}
            />
          </div>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> OT payout (USD)</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" /> Employees on OT</span>
        </div>
        <div className="relative" onMouseEnter={onUserInteract}>
          {data.length === 0 ? (
            <div className="py-16 text-center text-sm text-zinc-500">No overtime in this {gran.unit} view.</div>
          ) : (
          <>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${gran.label} overtime trend`} onMouseLeave={() => setHover(null)}>
            {grid.map((g, gi) => {
              const y = padT + plotH - g * plotH;
              return (
                <g key={gi}>
                  <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth={1} />
                  <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-emerald-600 dark:fill-emerald-400" fontSize={10}>{fmtUsdAxis(g * usdTop)}</text>
                  <text x={W - padR + 8} y={y + 3} textAnchor="start" className="fill-amber-600 dark:fill-amber-400" fontSize={10}>{Math.round(g * cntTop)}</text>
                </g>
              );
            })}
            {/* x-axis labels re-fade when the bucketing changes */}
            <motion.g key={`xl-${lineKey}`} initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              {data.map((d, i) =>
                i % labelEvery === 0 || i === n - 1 ? (
                  <text key={`x${i}`} x={xAt(i)} y={H - padB + 16} textAnchor="middle" className={cn('fill-zinc-400', hover === i && 'fill-zinc-700 dark:fill-zinc-200')} fontSize={9}>
                    {axisLabel(d.weekStart)}
                  </text>
                ) : null,
              )}
            </motion.g>
            {/* hover guide */}
            {hover != null && (
              <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + plotH} stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" strokeWidth={1} strokeDasharray="3 3" />
            )}
            {/* lines draw on (pathLength) + fade so the rescale reads as a state change */}
            <motion.path
              key={`payout-${lineKey}`}
              d={payoutPath}
              fill="none"
              stroke="currentColor"
              className="text-emerald-500"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ pathLength: { duration: 0.55, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.2 } }}
            />
            <motion.path
              key={`count-${lineKey}`}
              d={countPath}
              fill="none"
              stroke="currentColor"
              className="text-amber-500"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ pathLength: { duration: 0.55, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.2 } }}
            />
            <motion.g key={`m-${lineKey}`} initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: reduceMotion ? 0 : 0.22 }}>
              {data.map((d, i) => (
                <g key={`m${i}`}>
                  <circle cx={xAt(i)} cy={yUsd(d.otPayoutUsd ?? 0)} r={hover === i ? 4 : 2.5} className={cn('fill-emerald-500', hover === i && 'stroke-white dark:stroke-zinc-950')} strokeWidth={hover === i ? 1.5 : 0} />
                  <circle cx={xAt(i)} cy={yCnt(d.otEmployees)} r={hover === i ? 4 : 2.5} className={cn('fill-amber-500', hover === i && 'stroke-white dark:stroke-zinc-950')} strokeWidth={hover === i ? 1.5 : 0} />
                </g>
              ))}
            </motion.g>
            {/* transparent per-bucket hit areas (on top) for hover detection */}
            {data.map((d, i) => {
              const band = n > 1 ? plotW / (n - 1) : plotW;
              return (
                <rect
                  key={`hit${i}`}
                  x={xAt(i) - band / 2}
                  y={padT}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              );
            })}
          </svg>

          {/* Hover tooltip — bucket totals + top 5 OT renderers, tracking the point. */}
          {hover != null && data[hover] && (
            <div
              className="pointer-events-none absolute top-1 z-20 w-52 -translate-x-1/2"
              style={{ left: `${Math.min(84, Math.max(16, (xAt(hover) / W) * 100))}%` }}
            >
              <div className="rounded-lg border border-zinc-200 bg-white/95 p-2.5 text-[11px] shadow-lg backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95">
                <div className="font-semibold text-zinc-800 dark:text-zinc-100">
                  {bucketRangeLabel(data[hover].weekStart, data[hover].weekEnd, granularity)}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-zinc-500">
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">{fmtMoney(data[hover].otPayoutUsd ?? 0, 'USD')}</span>
                  <span className="text-zinc-300 dark:text-zinc-600">·</span>
                  <span className="font-medium text-amber-600 dark:text-amber-400">{data[hover].otEmployees} on OT</span>
                </div>
                {(data[hover].leaders ?? []).length > 0 ? (
                  <div className="mt-1.5 border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">Top OT renderers</div>
                    <ul className="space-y-0.5">
                      {(data[hover].leaders ?? []).slice(0, 5).map((t, ti) => (
                        <li key={ti} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-200">
                            <span className="text-zinc-400">{ti + 1}.</span> {t.name ?? '—'}
                          </span>
                          <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{fmtHours(t.otHours)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="mt-1 text-[10px] text-zinc-400">No overtime this {gran.unit}.</div>
                )}
              </div>
            </div>
          )}
          </>
          )}
        </div>
      </div>
      {/* OT by department over time — follows the same granularity. */}
      <DeptTrendChart points={data} depts={depts} accent={accent} granularity={granularity} reduceMotion={!!reduceMotion} onInteract={onUserInteract} />
      </div>{/* end LEFT column */}

      {/* RIGHT column — OT leaderboard: everyone who rendered OT across the
          recent weeks, ranked by total OT hours or total OT pay (paginated to
          10). Only people with OT appear, so it is "OT only" by construction. */}
      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">OT standings</div>
            <div className="text-[11px] text-zinc-400">
              {weekPending ? '…' : activeCount}{' '}
              {isPeople
                ? activeCount === 1 ? 'person' : 'people'
                : activeCount === 1 ? 'department' : 'departments'}{' '}
              on overtime · {periodLabel}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* CSV period selector — same list as the roster; authoritatively
                scopes the leaderboard to one week (or the recent aggregate). */}
            <SmoothSelect
              value={statsPeriod}
              onChange={(v) => { setStatsPeriod(v); setLeaderPage(1); }}
              aria-label="Leaderboard pay week"
              className="w-full shrink-0 sm:w-52"
              options={statsPeriodOptions}
            />
            {/* Sort toggle so the two rankings can be told apart. */}
            <div data-readonly-allow className="inline-flex shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
              {([['hours', 'Top OT hours'], ['pay', 'Top OT pay']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setSort(key); setLeaderPage(1); }}
                  aria-pressed={sort === key}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                    sort === key
                      ? cn('shadow-sm', accent.chipBg, accent.chipText)
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* People | Department tabs + a search bar scoped to the active tab. */}
        <div className="flex flex-col gap-2 border-b border-zinc-200 px-3 py-2 sm:flex-row sm:items-center dark:border-zinc-800">
          <div data-readonly-allow className="inline-flex shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
            {([['people', 'People'], ['department', 'Department']] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setTab(key); setLeaderPage(1); setLeaderQuery(''); }}
                aria-pressed={tab === key}
                className={cn(
                  'rounded-md px-3 py-1 text-[12px] font-medium transition-colors',
                  tab === key
                    ? cn('shadow-sm', accent.chipBg, accent.chipText)
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {!weekPending && activeCount > 0 && (
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                type="search"
                placeholder={isPeople ? 'Search name or email…' : 'Search department…'}
                value={leaderQuery}
                onChange={(e) => { setLeaderQuery(e.target.value); setLeaderPage(1); }}
                className={cn('h-8 pl-8 text-[13px]', accent.ring)}
                aria-label={isPeople ? 'Search OT people' : 'Search OT departments'}
              />
            </div>
          )}
        </div>
        <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={contentKey}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
        {weekPending ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading {periodLabel}…
          </div>
        ) : activeCount === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-500">
            {isAggregate ? 'No overtime in the recent weeks.' : 'No overtime this week.'}
          </div>
        ) : filteredCount === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-500">
            No {isPeople ? 'one' : 'department'} matches “{leaderQuery.trim()}”.
          </div>
        ) : isPeople ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="px-4 py-2.5 font-medium">#</th>
                  <th className="px-3 py-2.5 font-medium">Person</th>
                  <th className="px-3 py-2.5 font-medium text-right">OT hours</th>
                  <th className="px-4 py-2.5 font-medium text-right">OT pay</th>
                </tr>
              </thead>
              <tbody>
                {pageLeaders.map((l, i) => (
                  <tr
                    key={`${l.email ?? l.name ?? 'leader'}|${leaderStart + i}`}
                    className="border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
                  >
                    <td className="px-4 py-2.5 tabular-nums text-zinc-400" data-label="#">{leaderStart + i + 1}</td>
                    <td className="px-3 py-2.5" data-label="Person">
                      <div className="flex items-center gap-2.5">
                        <TeamAvatar name={l.name ?? ''} email={l.email} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">{l.name ?? '—'}</div>
                          <div className="truncate text-[11px] text-zinc-400">{l.email ?? ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-amber-600 dark:text-amber-400" data-label="OT hours">
                      {fmtHours(l.otHours)}
                    </td>
                    <td className="px-4 py-2.5 text-right" data-label="OT pay">
                      <div className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{fmtMoney(l.otPayoutUsd ?? 0, 'USD')}</div>
                      <div className="text-[11px] tabular-nums text-zinc-400">{fmtMoney(l.otPayoutPhp ?? 0, 'PHP')}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="px-4 py-2.5 font-medium">#</th>
                  <th className="px-3 py-2.5 font-medium">Department</th>
                  <th className="px-3 py-2.5 font-medium text-right">People</th>
                  <th className="px-3 py-2.5 font-medium text-right">OT hours</th>
                  <th className="px-4 py-2.5 font-medium text-right">OT pay</th>
                </tr>
              </thead>
              <tbody>
                {pageDepts.map((d, i) => (
                  <tr
                    key={`${d.department}|${leaderStart + i}`}
                    className="border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
                  >
                    <td className="px-4 py-2.5 tabular-nums text-zinc-400" data-label="#">{leaderStart + i + 1}</td>
                    <td className="px-3 py-2.5 font-medium text-zinc-900 dark:text-zinc-100" data-label="Department">{d.department}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-300" data-label="People">{d.people}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-amber-600 dark:text-amber-400" data-label="OT hours">
                      {fmtHours(d.otHours)}
                    </td>
                    <td className="px-4 py-2.5 text-right" data-label="OT pay">
                      <div className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{fmtMoney(d.otPayoutUsd ?? 0, 'USD')}</div>
                      <div className="text-[11px] tabular-nums text-zinc-400">{fmtMoney(d.otPayoutPhp ?? 0, 'PHP')}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </motion.div>
        </AnimatePresence>
        {leaderTotalPages > 1 && (
          <div data-readonly-allow className="flex items-center justify-between gap-2 border-t border-zinc-200 px-4 py-2.5 text-[12px] text-zinc-500 dark:border-zinc-800">
            <span className="tabular-nums">
              {leaderStart + 1}–{Math.min(leaderStart + LEADERS_PER_PAGE, filteredCount)} of {filteredCount}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[12px]"
                disabled={leaderSafePage <= 1}
                onClick={() => setLeaderPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <span className="tabular-nums text-zinc-600 dark:text-zinc-300">Page {leaderSafePage} of {leaderTotalPages}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[12px]"
                disabled={leaderSafePage >= leaderTotalPages}
                onClick={() => setLeaderPage((p) => Math.min(leaderTotalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Stroke + dot palette for the department trend lines (and legend). */
const DEPT_COLORS = [
  { line: 'text-emerald-500', dot: 'bg-emerald-500' },
  { line: 'text-sky-500', dot: 'bg-sky-500' },
  { line: 'text-amber-500', dot: 'bg-amber-500' },
  { line: 'text-violet-500', dot: 'bg-violet-500' },
  { line: 'text-rose-500', dot: 'bg-rose-500' },
  { line: 'text-teal-500', dot: 'bg-teal-500' },
];

/**
 * Department OT trend — a multi-line chart (one line per top department) showing
 * how each department's OT pay or OT hours moves over time. Follows the headline
 * chart's Daily / Weekly / Monthly granularity; lines re-draw on every change.
 */
function DeptTrendChart({
  points,
  depts,
  accent,
  granularity,
  reduceMotion,
  onInteract,
}: {
  points: StatsPoint[];
  depts: StatsDept[] | null;
  accent: Accent;
  granularity: Granularity;
  reduceMotion: boolean;
  /** Notify the parent that the user touched this chart, so auto-cycling stops. */
  onInteract: () => void;
}) {
  const [metric, setMetric] = useState<OtSort>('pay');
  const [hover, setHover] = useState<number | null>(null);

  // Bucket indices change meaning between granularities — drop the hover guide.
  useEffect(() => { setHover(null); }, [granularity]);

  const ranked = [...(depts ?? [])].sort((a, b) =>
    metric === 'pay'
      ? (b.otPayoutUsd ?? b.otPayoutPhp ?? 0) - (a.otPayoutUsd ?? a.otPayoutPhp ?? 0)
      : b.otHours - a.otHours,
  );
  const top = ranked.slice(0, DEPT_COLORS.length);
  if (points.length === 0 || top.length === 0) return null;

  const valueFor = (p: StatsPoint, dept: string) => {
    const d = (p.depts ?? []).find((x) => x.department === dept);
    if (!d) return 0;
    return metric === 'pay' ? d.otPayoutUsd ?? d.otPayoutPhp ?? 0 : d.otHours;
  };
  const series = top.map((d, idx) => ({
    dept: d.department,
    color: DEPT_COLORS[idx % DEPT_COLORS.length],
    values: points.map((p) => valueFor(p, d.department)),
  }));

  const W = 760;
  const H = 210;
  const padL = 52;
  const padR = 14;
  const padT = 12;
  const padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = points.length;
  const xAt = (i: number) => (n === 1 ? padL + plotW / 2 : padL + (i * plotW) / (n - 1));
  const top0 = niceCeil(Math.max(1, ...series.flatMap((s) => s.values)));
  const yAt = (v: number) => padT + plotH - (v / top0) * plotH;
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const multiYear = new Set(points.map((p) => p.weekStart.slice(0, 4))).size > 1;
  const axisLabel = (iso: string) => bucketAxisLabel(iso, granularity, multiYear);
  const fmtVal = (v: number) => (metric === 'pay' ? fmtMoney(v, 'USD') : fmtHours(v));
  const fmtAxis = (v: number) => (metric === 'pay' ? fmtUsdAxis(v) : String(Math.round(v)));
  // Re-mount + re-draw the line layer when the bucketing or metric changes.
  const lineKey = `${granularity}-${metric}`;
  const gran = GRANULARITY_META[granularity];

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
          OT by department over time
          <span className="ml-2 text-[11px] font-normal text-zinc-400">
            {gran.label.toLowerCase()} · top {top.length} of {ranked.length}
          </span>
        </div>
        <div className="inline-flex shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
          {([['pay', 'OT pay'], ['hours', 'OT hours']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => { onInteract(); setMetric(key); }}
              aria-pressed={metric === key}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                metric === key
                  ? cn('shadow-sm', accent.chipBg, accent.chipText)
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-300">
        {series.map((s) => (
          <span key={s.dept} className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', s.color.dot)} />
            <span className="max-w-[120px] truncate">{s.dept}</span>
          </span>
        ))}
      </div>
      <div className="relative" onMouseEnter={onInteract}>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Department ${gran.label.toLowerCase()} overtime trend`} onMouseLeave={() => setHover(null)}>
          {grid.map((g, gi) => {
            const y = padT + plotH - g * plotH;
            return (
              <g key={gi}>
                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth={1} />
                <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-zinc-400" fontSize={10}>{fmtAxis(g * top0)}</text>
              </g>
            );
          })}
          <motion.g key={`xl-${lineKey}`} initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
            {points.map((p, i) =>
              i % labelEvery === 0 || i === n - 1 ? (
                <text key={`x${i}`} x={xAt(i)} y={H - padB + 16} textAnchor="middle" className={cn('fill-zinc-400', hover === i && 'fill-zinc-700 dark:fill-zinc-200')} fontSize={9}>
                  {axisLabel(p.weekStart)}
                </text>
              ) : null,
            )}
          </motion.g>
          {hover != null && (
            <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + plotH} stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" strokeWidth={1} strokeDasharray="3 3" />
          )}
          {series.map((s, idx) => (
            <motion.path
              key={`${s.dept}-${lineKey}`}
              d={s.values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`).join(' ')}
              fill="none"
              stroke="currentColor"
              className={s.color.line}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ pathLength: { duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: reduceMotion ? 0 : idx * 0.05 }, opacity: { duration: 0.2 } }}
            />
          ))}
          {hover != null &&
            series.map((s) => (
              <circle key={`dot-${s.dept}`} cx={xAt(hover)} cy={yAt(s.values[hover])} r={3.5} fill="currentColor" className={s.color.line} />
            ))}
          {points.map((p, i) => {
            const band = n > 1 ? plotW / (n - 1) : plotW;
            return <rect key={`hit${i}`} x={xAt(i) - band / 2} y={padT} width={band} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />;
          })}
        </svg>
        {hover != null && points[hover] && (
          <div className="pointer-events-none absolute top-1 z-20 w-48 -translate-x-1/2" style={{ left: `${Math.min(86, Math.max(14, (xAt(hover) / W) * 100))}%` }}>
            <div className="rounded-lg border border-zinc-200 bg-white/95 p-2.5 text-[11px] shadow-lg backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95">
              <div className="font-semibold text-zinc-800 dark:text-zinc-100">
                {bucketRangeLabel(points[hover].weekStart, points[hover].weekEnd, granularity)}
              </div>
              <ul className="mt-1 space-y-0.5">
                {series.map((s) => (
                  <li key={s.dept} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', s.color.dot)} />
                      <span className="truncate text-zinc-700 dark:text-zinc-200">{s.dept}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{fmtVal(s.values[hover])}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RosterSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-zinc-100 px-3 py-3 last:border-0 dark:border-zinc-900"
        >
          <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-2.5 w-52 max-w-[60%]" />
          </div>
          <Skeleton className="hidden h-3.5 w-24 sm:block" />
          <Skeleton className="hidden h-3.5 w-20 md:block" />
          <Skeleton className="h-7 w-14 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function HoursCell({ hours }: { hours: Hours }) {
  const ot = hours.projectedOt ?? hours.ot;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{fmtHours(hours.thisWeek)}</span>
        {hours.ot > 0 && (
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:bg-red-950/30 dark:text-red-300">
            +{fmtHours(hours.ot)} OT
          </span>
        )}
      </div>
      {hours.inProgress && hours.projectedHours != null && (
        <span className="flex items-center gap-1 text-[10.5px] text-zinc-400">
          <Clock className="h-3 w-3" />
          on track for {fmtHours(hours.projectedHours)}
          {ot > 0 && <span className="text-red-500">({fmtHours(ot)} OT)</span>}
        </span>
      )}
    </div>
  );
}

/* ── Person detail (banking + payroll history) ──────────────────────────── */

type PersonTab = 'profile' | 'banking' | 'payroll' | 'pab';

/** "Don't show again soon" for the sensitive-edit warning is a TEMPORARY snooze,
 *  not a permanent opt-out — the warning re-arms after this window so it can't be
 *  silenced forever. Stored as an expiry timestamp in localStorage. */
const EDIT_WARN_SNOOZE_KEY = 'people:edit-profile-warning-snooze-until';
const EDIT_WARN_SNOOZE_MS = 8 * 60 * 60 * 1000; // 8 hours ≈ one work session

/** True while the sensitive-edit warning is snoozed (window not yet expired). */
function isEditWarningSnoozed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const until = Number(window.localStorage.getItem(EDIT_WARN_SNOOZE_KEY) ?? '0');
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

/** Start (or refresh) the snooze window. */
function snoozeEditWarning(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(EDIT_WARN_SNOOZE_KEY, String(Date.now() + EDIT_WARN_SNOOZE_MS));
  } catch {
    /* private mode / storage disabled — the warning simply shows every time */
  }
}

/**
 * One-off payment dialog (People tab "Pay" action). The user enters a PHP amount
 * (and optional note); on submit it files a PENDING urgent_payment_requests row
 * via POST /api/people/pay, which surfaces in Payment Dispatch → Urgent →
 * One-off Payments for a clerk to actually send. No money moves here.
 */
function PayDialog({
  row,
  accent,
  onClose,
}: {
  row: RosterRow;
  accent: Accent;
  onClose: () => void;
}) {
  const email = (row.work_email ?? '').trim().toLowerCase();
  const [amountStr, setAmountStr] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Sane ceiling — well above any real one-off payment, and below the DB's
  // numeric(12,2) limit so a huge value fails as a clear message, not a raw 500.
  const MAX_AMOUNT = 1_000_000_000; // ₱1B
  const amount = parseFloat(amountStr);
  const valid = !!email && Number.isFinite(amount) && amount > 0 && amount <= MAX_AMOUNT;

  const submit = async () => {
    if (!email) { toast.error('No work email on file to pay.'); return; }
    if (Number.isFinite(amount) && amount > MAX_AMOUNT) { toast.error('Amount is too large.'); return; }
    if (!valid) { toast.error('Enter a valid amount greater than zero.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/people/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: email,
          full_name: row.name ?? '',
          department: row.department ?? null,
          amount_php: amount,
          note: note.trim() || null,
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error || `Request failed (${res.status})`);
      toast.success('Payment request sent to Urgent dispatch.');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the payment request.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !submitting) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-4 w-4 text-amber-500" /> Send a payment
          </DialogTitle>
          <DialogDescription>
            Files an <span className="font-medium text-amber-600 dark:text-amber-400">Urgent</span> one-off
            payment to {row.name ?? 'this person'}. It appears in Payment Dispatch → Urgent for a clerk to send.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Recipient */}
          <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
            <TeamAvatar name={row.name ?? ''} email={row.work_email} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.name ?? '—'}</div>
              <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{email || 'no work email'}</div>
            </div>
          </div>

          {/* Amount */}
          <div>
            <label htmlFor="pay-amount" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Amount (PHP)
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-zinc-500">₱</span>
              <Input
                id="pay-amount"
                type="number"
                inputMode="decimal"
                min="0"
                max={MAX_AMOUNT}
                step="0.01"
                autoFocus
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && valid && !submitting) void submit(); }}
                placeholder="0.00"
                className="pl-7"
              />
            </div>
            {amountStr !== '' && Number.isFinite(amount) && amount > 0 && (
              <p className="mt-1 text-[11px] text-zinc-500">Paying {fmtMoney(amount, 'PHP')}</p>
            )}
          </div>

          {/* Note (optional) */}
          <div>
            <label htmlFor="pay-note" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Note <span className="font-normal normal-case text-zinc-400">(optional)</span>
            </label>
            <Input
              id="pay-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason for this payment"
              maxLength={250}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className={cn('gap-1.5', accent.btn)}
            disabled={!valid || submitting}
            onClick={() => void submit()}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {submitting ? 'Sending…' : 'Send payment'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PersonDetailDialog({
  row,
  accent,
  canEdit,
  canPay = false,
  onPay,
  onClose,
  onRowUpdated,
}: {
  row: RosterRow;
  accent: Accent;
  canEdit: boolean;
  canPay?: boolean;
  onPay?: (row: RosterRow) => void;
  onClose: () => void;
  onRowUpdated: (master: MasterProfileFields) => void;
}) {
  const [tab, setTab] = useState<PersonTab>('profile');
  // The scroll viewport for the tab panels — reset to the top on every switch so
  // a new tab always opens at its start, not wherever the last one was scrolled.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Mount the PAB calendar on first visit, then keep it mounted (hidden when
  // inactive) so switching tabs never re-fetches its data.
  const [pabVisited, setPabVisited] = useState(false);
  const [pabLoading, setPabLoading] = useState(true);
  const [pabProgress, setPabProgress] = useState(0);
  const [showPabLoader, setShowPabLoader] = useState(true);
  const handlePabLoaderDone = useCallback(() => setShowPabLoader(false), []);
  const [banking, setBanking] = useState<Banking | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [bankHistory, setBankHistory] = useState<BankChangeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealing, setRevealing] = useState(false);
  // Banking & payout stays hidden until the viewer explicitly reveals it.
  const [showBanking, setShowBanking] = useState(false);
  const isHsl = isHslFamilyLabel(row.department);
  const [histPage, setHistPage] = useState(1);
  const histDirRef = useRef<1 | -1>(1);
  const [bankHistPage, setBankHistPage] = useState(1);
  const [bankHistDetail, setBankHistDetail] = useState<BankChangeEntry | null>(null);
  const reduceMotion = useReducedMotion();
  const HIST_PAGE_SIZE = 5;
  // Freeze the person's identity for the dialog's lifetime: the dialog is keyed by
  // the stable master id, so editing the work email must NOT re-fire the banking/
  // payroll/PAB fetches (which would flash skeletons and silently re-mask a reveal).
  const [email] = useState(() => row.work_email ?? '');

  // Tech-neon easter egg: one person's profile gets a running neon rim + glowing
  // tab bar (see `.neon-profile-modal` in index.css). Matched on the frozen work
  // email so it survives an in-modal email edit.
  const isNeon = email.trim().toLowerCase() === 'kaner@simple.biz';

  // Profile editor (Identity & contact). Only reachable when canEdit AND the row
  // carries its master-list id (the update target).
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ProfileForm>(() => initialForm(row));
  const upd = (k: keyof ProfileForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  // The full name, split into editable parts (First / Middle / Last / Extension
  // / Nickname). Composed back into the master-list "Name" on save — see
  // saveProfile — so an explicit nickname persists to Supabase, not the blob.
  const [nameParts, setNameParts] = useState<NameParts>(() => parseNameParts(row.name));
  const updPart = (k: keyof NameParts, v: string) => setNameParts((p) => ({ ...p, [k]: v }));
  const beginEdit = () => { setForm(initialForm(row)); setNameParts(parseNameParts(row.name)); setEditing(true); };
  const cancelEdit = () => { setForm(initialForm(row)); setNameParts(parseNameParts(row.name)); setEditing(false); };
  // Read-only breakdown shown when not editing (derived from the stored name).
  const viewParts = useMemo(() => parseNameParts(row.name), [row.name]);

  // Banking editor — writes the canonical employee_ids payout row (the source
  // of truth every dashboard reads). The form is only ever seeded from the
  // UNMASKED record (beginBankEdit reveals first), so a save can never persist
  // masked dot-runs as real values.
  const [bankEditing, setBankEditing] = useState(false);
  const [bankSaving, setBankSaving] = useState(false);
  const [bankForm, setBankForm] = useState<BankForm>(() => bankingToForm(null));
  const bankInitialRef = useRef<BankForm>(bankingToForm(null));
  const updBank = (k: keyof BankForm, v: string) => setBankForm((f) => ({ ...f, [k]: v }));

  // Sensitive-info gate: clicking Edit opens a warning first, unless it's been
  // snoozed ("Don't show again soon"). The snooze is time-boxed, not permanent.
  // Shared by the profile AND banking editors — editTarget picks which one the
  // confirm actually opens.
  const [showEditWarning, setShowEditWarning] = useState(false);
  const [snoozeWarning, setSnoozeWarning] = useState(false);
  const [editTarget, setEditTarget] = useState<'profile' | 'banking'>('profile');
  const startEdit = (target: 'profile' | 'banking') => {
    if (target === 'banking') { void beginBankEdit(); return; }
    beginEdit();
  };
  const requestEdit = (target: 'profile' | 'banking') => {
    setEditTarget(target);
    if (isEditWarningSnoozed()) { startEdit(target); return; }
    setSnoozeWarning(false);
    setShowEditWarning(true);
  };
  const confirmEditWarning = () => {
    if (snoozeWarning) snoozeEditWarning();
    setShowEditWarning(false);
    startEdit(editTarget);
  };

  const saveProfile = async () => {
    const initial = initialForm(row);
    const patch: Record<string, string> = {};
    (Object.keys(initial) as (keyof ProfileForm)[]).forEach((k) => {
      if (k === 'name') return; // the name is edited via its parts (below), not this field
      const before = k === 'start_date' ? initial[k] : initial[k].trim();
      const after = k === 'start_date' ? form[k] : form[k].trim();
      if (before !== after) patch[k] = after;
    });
    // Recompose the name from its parts and include it only when a part actually
    // changed — so editing e.g. only the phone never rewrites the name. The
    // composed surname-first string is stored verbatim server-side (comma form),
    // so an explicit nickname is preserved rather than re-derived.
    const initialParts = parseNameParts(row.name);
    const partsChanged = (Object.keys(nameParts) as (keyof NameParts)[]).some(
      (k) => nameParts[k].trim() !== initialParts[k].trim(),
    );
    // Self-heal a name whose STORED value carries doubled quotes (`""Aeriele""`)
    // - a CSV/Sheet round-trip artifact. Recomposing from the (already-scrubbed)
    // parts rewrites it to the clean canonical form on ANY save, so the user does
    // not have to re-type the name just to clear the corruption.
    const nameCorrupt = /""/.test(row.name ?? '');
    if (partsChanged || nameCorrupt) {
      const composedName = composeMasterListName(nameParts).trim();
      if (!composedName) {
        toast.error('Name can’t be empty — a first or last name is required.');
        return;
      }
      patch.name = composedName;
    }
    // Any structured-address change re-derives the combined "Location" line
    // (the single address field the Google Sheet carries).
    const ADDR = ['street', 'city', 'province', 'postal_code', 'full_address'];
    if (ADDR.some((k) => k in patch)) {
      const full = form.full_address.trim();
      patch.location =
        full || [form.street, form.city, form.province, form.postal_code].map((x) => x.trim()).filter(Boolean).join(', ');
    }
    // Never blank the identity keys (mirrors the server guard so the user gets an
    // inline error instead of a 400).
    const REQUIRED_LABELS: Record<string, string> = { name: 'Name', work_email: 'Work email', department: 'Department' };
    for (const k of Object.keys(REQUIRED_LABELS)) {
      if (k in patch && !(patch[k] ?? '').trim()) {
        toast.error(`${REQUIRED_LABELS[k]} can’t be empty.`);
        return;
      }
    }
    if (Object.keys(patch).length === 0) { setEditing(false); return; }

    setSaving(true);
    try {
      const seg = email || row.personal_email || row.id || 'employee';
      const res = await fetch(`/api/people/${encodeURIComponent(seg)}/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: row.id,
          original_work_email: row.work_email,
          original_personal_email: row.personal_email,
          original_department: row.department,
          patch,
        }),
      });
      const j = (await res.json()) as { ok?: boolean; master?: MasterProfileFields; sheet?: { updated: number; reason?: string }; error?: string };
      if (!res.ok || !j.ok || !j.master) throw new Error(j.error || `Save failed (${res.status})`);
      onRowUpdated(j.master);
      setEditing(false);
      if (j.sheet && j.sheet.updated === 0) {
        toast.message('Saved in-app — Google Sheet not updated', {
          description: `${j.sheet.reason ?? 'The master Sheet row was not found.'} This edit may revert on the next Sheet sync.`,
        });
      } else {
        toast.success('Profile updated.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the profile.');
    } finally {
      setSaving(false);
    }
  };

  const changeTab = (next: PersonTab) => {
    if (next === tab) return;
    setTab(next);
    if (next === 'pab') setPabVisited(true);
    // Land the incoming panel at the top of the scroll viewport.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/people/${encodeURIComponent(email)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { banking?: Banking | null; history?: HistoryRow[]; bankHistory?: BankChangeEntry[] }) => {
        if (!alive) return;
        setBanking(j.banking ?? null);
        setHistory(j.history ?? []);
        setBankHistory(j.bankHistory ?? []);
        setHistPage(1);
        setBankHistPage(1);
      })
      .catch(() => { if (alive) setBanking(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [email]);

  // Paginate the bank-change history — 5 newest-first per page, same pattern as
  // the payroll history list below.
  const bankHistTotalPages = Math.max(1, Math.ceil(bankHistory.length / HIST_PAGE_SIZE));
  const bankHistSafePage = Math.min(bankHistPage, bankHistTotalPages);
  const bankHistStart = (bankHistSafePage - 1) * HIST_PAGE_SIZE;
  const pagedBankHistory = bankHistory.slice(bankHistStart, bankHistStart + HIST_PAGE_SIZE);

  // Paginate the history list — 6 newest-first per page. safePage clamps if the
  // set shrinks (e.g. after a reveal/refresh) so we never land out of range.
  const histTotalPages = Math.max(1, Math.ceil(history.length / HIST_PAGE_SIZE));
  const histSafePage = Math.min(histPage, histTotalPages);
  const histStart = (histSafePage - 1) * HIST_PAGE_SIZE;
  const pagedHistory = history.slice(histStart, histStart + HIST_PAGE_SIZE);

  const goPage = (dir: 1 | -1) => {
    histDirRef.current = dir;
    setHistPage((p) => Math.min(histTotalPages, Math.max(1, p + dir)));
  };

  // Preferred bank slot first, falling back to the OTHER slot per field — the
  // same pickFirst rule Payment Dispatch's queue row uses (buildPayeeDetails in
  // mock-queue.ts), so a person whose details live only in the non-preferred
  // slot still shows the account PD pays to instead of a blank.
  const prefAlt = banking?.preferred_bank_slot === 'alternative';
  const firstOf = (...vals: (string | null | undefined)[]) =>
    vals.find((v) => v != null && String(v).trim() !== '') ?? null;
  const prefBank = {
    name: prefAlt
      ? firstOf(banking?.alt_bank_name, banking?.bank_name)
      : firstOf(banking?.bank_name, banking?.alt_bank_name),
    holder: prefAlt
      ? firstOf(banking?.alt_account_holder_name, banking?.account_holder_name)
      : firstOf(banking?.account_holder_name, banking?.alt_account_holder_name),
    account: prefAlt
      ? firstOf(banking?.alt_account_number, banking?.account_number)
      : firstOf(banking?.account_number, banking?.alt_account_number),
    routing: prefAlt
      ? firstOf(banking?.alt_routing_number, banking?.routing_number)
      : firstOf(banking?.routing_number, banking?.alt_routing_number),
    swift: banking?.swift_code ?? null,
    address: banking?.full_address ?? null,
  };
  // Show the details of the rail Payment Dispatch ACTUALLY routes this person
  // on (server-resolved: bank_preferred → Disbursement pick → legacy rates
  // cell) — not the raw Disbursement pick, which can disagree with how the
  // person is really paid. Unknown/empty falls back to a bank if one exists.
  const proc = (banking?.effective_processor ?? banking?.preferred_processor ?? '')
    .trim()
    .toLowerCase();
  // wires, jeeves AND wise all carry full bank/wire details (jeeves also shows
  // phone). Wise payees are paid into their bank account, not a Wise handle —
  // same field set as wires (mirrors the Readiness Set-bank editor).
  const showBank = proc === 'wires' || proc === 'jeeves' || proc === 'wise' || (!proc && !!prefBank.name);

  // The editor's field visibility follows the same processor rules as the
  // read view, but driven by the FORM's processor so switching the payment
  // method immediately swaps the relevant fields in.
  const editProc = bankForm.preferred_processor;
  const editShowsBank = editProc === 'wires' || editProc === 'jeeves' || editProc === 'wise' || editProc === '';
  const editAlt = bankForm.preferred_bank_slot === 'alternative';

  const reveal = async (): Promise<Banking | null> => {
    setRevealing(true);
    try {
      const res = await fetch(`/api/people/${encodeURIComponent(email)}/reveal-banking`, { method: 'POST' });
      const j = (await res.json()) as { banking?: Banking | null; error?: string };
      if (!res.ok) throw new Error(j.error || 'Reveal failed');
      if (j.banking) setBanking(j.banking);
      return j.banking ?? null;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reveal banking');
      return null;
    } finally {
      setRevealing(false);
    }
  };

  // Toggle the Banking & payout block. Revealing masked records fetches the
  // unmasked values first (audit-logged); hiding is purely visual.
  const toggleBanking = async () => {
    if (showBanking) { setShowBanking(false); return; }
    if (banking?.masked) {
      const b = await reveal();
      if (!b) return; // keep hidden if the reveal failed
    }
    setShowBanking(true);
  };

  // Open the banking editor. Masked records are revealed first (audit-logged)
  // so the form always starts from the real values — never dot-runs.
  const beginBankEdit = async () => {
    let b = banking;
    if (b?.masked) {
      b = await reveal();
      if (!b) return;
    }
    setShowBanking(true);
    const f = bankingToForm(b);
    bankInitialRef.current = f;
    setBankForm(f);
    setBankEditing(true);
  };
  const cancelBankEdit = () => { setBankForm(bankInitialRef.current); setBankEditing(false); };

  const saveBanking = async () => {
    // Send only the fields that actually changed; '' clears a field (→ null).
    const patch: Record<string, string | null> = {};
    (Object.keys(bankForm) as (keyof BankForm)[]).forEach((k) => {
      const before = bankInitialRef.current[k].trim();
      const after = bankForm[k].trim();
      if (before !== after) patch[k] = after === '' ? null : after;
    });
    if (Object.keys(patch).length === 0) { setBankEditing(false); return; }

    setBankSaving(true);
    try {
      const res = await fetch(`/api/people/${encodeURIComponent(email)}/banking`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      });
      const j = (await res.json()) as { ok?: boolean; banking?: Banking | null; bankHistory?: BankChangeEntry[]; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error || `Save failed (${res.status})`);
      // The endpoint returns the fresh UNMASKED record + updated change history,
      // so the modal reflects the save immediately without a refetch.
      if (j.banking) setBanking(j.banking);
      if (j.bankHistory) { setBankHistory(j.bankHistory); setBankHistPage(1); }
      setBankEditing(false);
      toast.success('Payout details updated — this is now what payroll pays to.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the payout details.');
    } finally {
      setBankSaving(false);
    }
  };

  return (
    <>
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={cn('!flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl', isNeon && 'neon-profile-modal')}>
        <div className="flex min-h-0 flex-1 flex-col">
        <DialogHeader className={cn('relative shrink-0 overflow-hidden border-b px-5 py-4', isNeon ? 'neon-tattoo border-cyan-400/25 dark:border-cyan-400/20' : 'border-zinc-200 dark:border-zinc-800')}>
          <div className="relative z-10 flex items-center gap-3">
            {isNeon ? (
              // Neon: a spinning conic ring hugs the round avatar, with a soft
              // outer glow. `neon-avatar-ring` lives in index.css.
              <span className="neon-avatar-ring shrink-0" aria-hidden={false}>
                <TeamAvatar name={row.name ?? ''} email={row.work_email} size="xl" />
              </span>
            ) : (
              <TeamAvatar name={row.name ?? ''} email={row.work_email} size="xl" />
            )}
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-lg">{row.name ?? '—'}</DialogTitle>
              <DialogDescription className="truncate">
                {row.department ?? '—'} · {row.work_email ?? row.employee_id ?? ''}
              </DialogDescription>
            </div>
            {canPay && onPay && (
              <Button
                type="button"
                size="sm"
                className={cn('mr-8 h-8 shrink-0 gap-1.5 px-3 text-[12px]', accent.btn)}
                disabled={!row.work_email}
                title={row.work_email ? 'Send a one-off payment' : 'No work email on file'}
                onClick={() => onPay(row)}
              >
                <Banknote className="h-3.5 w-3.5" /> Pay
              </Button>
            )}
          </div>
        </DialogHeader>

        {/* Tabs */}
        <div
          role="tablist"
          className={cn(
            'flex shrink-0 gap-1 overflow-x-auto border-b px-3',
            isNeon
              ? 'border-cyan-400/25 dark:border-cyan-400/20'
              : 'border-zinc-200 dark:border-zinc-800',
          )}
        >
          {([['profile', 'Profile'], ['banking', 'Banking'], ['payroll', 'Payroll'], ['pab', 'PAB Calendar']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => changeTab(id)}
              className={cn(
                'relative shrink-0 whitespace-nowrap px-3 py-2.5 text-[13px] font-medium transition-colors',
                isNeon
                  ? 'neon-tab'
                  : tab === id
                    ? 'text-zinc-900 dark:text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {/* Neon: a glowing pill glides behind the active tab. */}
              {isNeon && tab === id && (
                <motion.span
                  layoutId="person-tab-pill"
                  className="absolute inset-x-1 inset-y-1.5 -z-10 rounded-md bg-cyan-400/10 ring-1 ring-cyan-400/30 shadow-[0_0_16px_-2px_rgba(56,189,248,0.55)] dark:bg-cyan-400/10 dark:ring-cyan-300/30"
                  transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 32 }}
                />
              )}
              <span className="relative z-10">{label}</span>
              {tab === id && (
                <motion.span
                  layoutId="person-tab-underline"
                  className={cn(
                    'absolute inset-x-2 -bottom-px h-0.5 rounded-full',
                    isNeon
                      ? 'bg-gradient-to-r from-cyan-400 via-sky-400 to-fuchsia-400 shadow-[0_0_10px_1px_rgba(56,189,248,0.7)]'
                      : accent.bar,
                  )}
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                />
              )}
            </button>
          ))}
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Light tabs cross-fade with a subtle rise on switch (mode="wait" so
              the outgoing panel finishes before the incoming one enters). The PAB
              tab is NOT in here — it stays persistently mounted below so it never
              re-fetches; this animates only profile / banking / payroll. */}
          <AnimatePresence mode="wait" initial={false}>
          {tab !== 'pab' && (
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: reduceMotion ? 0 : (isNeon ? 10 : 6), filter: isNeon && !reduceMotion ? 'blur(6px)' : 'blur(0px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : (isNeon ? -8 : -4), filter: isNeon && !reduceMotion ? 'blur(6px)' : 'blur(0px)' }}
            transition={{ duration: reduceMotion ? 0 : (isNeon ? 0.28 : 0.22), ease: [0.22, 1, 0.36, 1] }}
          >
          {tab === 'profile' && (
          <>
          {/* Snapshot cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="Hours this week" value={fmtHours(row.hours.thisWeek)} sub={row.hours.ot > 0 ? `+${fmtHours(row.hours.ot)} OT` : 'no OT'} />
            <StatCard
              label="On track for"
              value={row.hours.inProgress && row.hours.projectedHours != null ? fmtHours(row.hours.projectedHours) : '—'}
              sub={
                row.hours.inProgress && (row.hours.projectedOt ?? 0) > 0
                  ? `${fmtHours(row.hours.projectedOt)} projected OT`
                  : row.hours.inProgress ? 'within 40h' : 'week complete'
              }
            />
            <StatCard
              label="Pay rate"
              value={row.rate.regular != null ? `${fmtMoney(row.rate.regular, row.rate.currency)}/hr` : 'not set'}
              sub={row.rate.ot != null ? `OT ${fmtMoney(row.rate.ot, row.rate.currency)}` : (row.rate.source ?? '')}
            />
          </div>

          {/* Identity & contact — master-list "cabinet" fields, editable in place
              (canEdit + a resolved master id). Read-only values come from the
              roster row already in memory; the editor writes global_master_list +
              the Google Sheet, and Admin/HR reflect it on their next refresh. */}
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Identity &amp; contact</h3>
              {canEdit && !editing && (
                row.id ? (
                  <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-[12px]" onClick={() => requestEdit('profile')}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                ) : (
                  <span className="text-[10.5px] text-zinc-400">Not editable (no master record)</span>
                )
              )}
            </div>
            {editing ? (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  {/* Full name, split into parts. Composed back to the master-list
                      "Name" (surname first, with the nickname quoted) on save. */}
                  <div className="rounded-md border border-zinc-200/70 bg-white/60 p-2.5 sm:col-span-2 dark:border-zinc-800 dark:bg-zinc-950/30">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                      <EditField label="First name" value={nameParts.first} onChange={(v) => updPart('first', v)} accent={accent} />
                      <EditField label="Middle name" value={nameParts.middle} onChange={(v) => updPart('middle', v)} accent={accent} />
                      <EditField label="Last name" value={nameParts.last} onChange={(v) => updPart('last', v)} accent={accent} />
                      <EditField label="Extension" value={nameParts.extension} onChange={(v) => updPart('extension', v)} accent={accent} hint="Jr, Sr, III…" />
                      <EditField label="Nickname" value={nameParts.nickname} onChange={(v) => updPart('nickname', v)} accent={accent} hint="Go-by name" />
                    </div>
                    <p className="mt-2 text-[10.5px] text-zinc-400">
                      Saved to the master list as{' '}
                      <span className="font-medium text-zinc-600 dark:text-zinc-300">
                        {/* Hide the empty `()` boundary marker in the preview - it
                            only appears for a multi-word first name with no middle,
                            and reads as a glitch. The stored value keeps it. */}
                        {composeMasterListName(nameParts).replace(/\s*\(\)\s*/, ' ').replace(/\s+/g, ' ').trim() || '—'}
                      </span>
                    </p>
                  </div>
                  <EditField label="Department" value={form.department} onChange={(v) => upd('department', v)} accent={accent} />
                  <EditField label="Work email" value={form.work_email} onChange={(v) => upd('work_email', v)} accent={accent} type="email" hint="Identity key — must stay unique per department." />
                  <EditField label="Personal email" value={form.personal_email} onChange={(v) => upd('personal_email', v)} accent={accent} type="email" />
                  <EditField label="Alternate work email" value={form.alternate_work_email} onChange={(v) => upd('alternate_work_email', v)} accent={accent} type="email" />
                  <EditField label="Alternate work email 2" value={form.alternate_work_email_2} onChange={(v) => upd('alternate_work_email_2', v)} accent={accent} type="email" />
                  <EditField label="Start date" value={form.start_date} onChange={(v) => upd('start_date', v)} accent={accent} type="date" hint={row.start_date ? `Currently: ${formatHireDate(row.start_date)}` : undefined} />
                  <EditField label="Phone number" value={form.phone_number} onChange={(v) => upd('phone_number', v)} accent={accent} />
                  <EditField label="Full address" value={form.full_address} onChange={(v) => upd('full_address', v)} accent={accent} wide hint="Synced to the Sheet's Location column." />
                  <EditField label="Street" value={form.street} onChange={(v) => upd('street', v)} accent={accent} />
                  <EditField label="City" value={form.city} onChange={(v) => upd('city', v)} accent={accent} />
                  <EditField label="Province" value={form.province} onChange={(v) => upd('province', v)} accent={accent} />
                  <EditField label="Postal code" value={form.postal_code} onChange={(v) => upd('postal_code', v)} accent={accent} />
                </div>
                <p className="mt-3 text-[11px] text-zinc-400">
                  Employee ID <span className="font-mono">{row.employee_id ?? '—'}</span> is system-managed. Saving writes the Global Master List + Google Sheet.
                </p>
                <div className="mt-3 flex items-center justify-end gap-2">
                  <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 px-3 text-[12px]" onClick={cancelEdit} disabled={saving}>
                    <X className="h-3.5 w-3.5" /> Cancel
                  </Button>
                  <Button type="button" size="sm" className={cn('h-8 gap-1.5 px-3 text-[12px] font-medium', accent.btn)} onClick={saveProfile} disabled={saving}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save changes
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                {/* Name banner — the composed display name reads at a glance,
                    with the go-by nickname called out as an accent pill. */}
                <div className={cn('flex items-center gap-2.5 rounded-lg border border-zinc-200/80 px-3 py-2 dark:border-zinc-800', accent.chipBg)}>
                  <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold', accent.chipText, 'bg-white/70 dark:bg-zinc-950/40')}>
                    {(viewParts.first?.[0] ?? row.name?.[0] ?? '?').toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[14px] font-semibold text-zinc-900 dark:text-zinc-50">
                        {[viewParts.first, viewParts.middle, viewParts.last, viewParts.extension].filter(Boolean).join(' ') || row.name || '—'}
                      </p>
                      {viewParts.nickname && (
                        <span className={cn('shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[10.5px] font-medium dark:bg-zinc-950/40', accent.chipText)}>
                          “{viewParts.nickname}”
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                      {row.department || 'No department'}
                      {row.employee_id && <span className="font-mono"> · {row.employee_id}</span>}
                    </p>
                  </div>
                </div>

                {/* Two grouped cards: who they are, and how to reach them. */}
                <div className="grid grid-cols-1 items-start gap-2.5 sm:grid-cols-2">
                  <InfoCard icon={User} title="Identity" accent={accent}>
                    <InfoRow icon={User} label="First name" value={viewParts.first || null} />
                    <InfoRow icon={User} label="Last name" value={viewParts.last || null} />
                    {viewParts.middle && <InfoRow icon={User} label="Middle name" value={viewParts.middle} />}
                    {viewParts.extension && <InfoRow icon={User} label="Extension" value={viewParts.extension} />}
                    {viewParts.nickname && <InfoRow icon={User} label="Nickname" value={viewParts.nickname} />}
                    <InfoRow icon={IdCard} label="Employee ID" value={row.employee_id} mono copyable />
                    <InfoRow icon={Building2} label="Department" value={row.department} />
                    <InfoRow icon={CalendarDays} label="Start date" value={formatHireDate(row.start_date)} />
                    <InfoRow icon={Hourglass} label="Tenure" value={tenureFrom(row.start_date)} />
                  </InfoCard>

                  <InfoCard icon={ContactIcon} title="Contact" accent={accent}>
                    <InfoRow icon={Mail} label="Work email" value={row.work_email} copyable />
                    <InfoRow icon={AtSign} label="Personal email" value={row.personal_email} copyable />
                    {(row.alternate_work_emails ?? []).length > 0 && (
                      <InfoRow icon={Mail} label="Alternate work emails" value={(row.alternate_work_emails ?? []).join(', ')} />
                    )}
                    <InfoRow icon={Phone} label="Phone number" value={row.phone_number} copyable />
                    <InfoRow
                      icon={MapPin}
                      label="Home address"
                      value={
                        row.full_address?.trim() ||
                        [row.city, row.province].map((x) => (x ?? '').trim()).filter(Boolean).join(', ') ||
                        row.location ||
                        null
                      }
                    />
                  </InfoCard>
                </div>
              </div>
            )}
          </div>
          </>
          )}

          {tab === 'banking' && (
          <>
          {/* Banking */}
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Banking & payout</h3>
              {!loading && !bankEditing && (
                <div className="flex items-center gap-1.5">
                  {canEdit && (
                    <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-[12px]" onClick={() => requestEdit('banking')} disabled={revealing}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-[12px]" onClick={toggleBanking} disabled={revealing}>
                    {revealing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : showBanking ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                    {showBanking ? 'Hide' : 'Reveal'}
                  </Button>
                </div>
              )}
            </div>
            {!loading && banking?.bank_last_self_updated_at && (
              <p className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                Self-updated via external link on {new Date(banking.bank_last_self_updated_at).toLocaleDateString()}
              </p>
            )}
            {loading ? (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="space-y-1.5">
                      <Skeleton className="h-2.5 w-16" />
                      <Skeleton className="h-3.5 w-32" />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
              {!showBanking ? (
                <motion.button
                  key="hidden"
                  type="button"
                  onClick={toggleBanking}
                  disabled={revealing}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.14 }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 px-3 py-4 text-[12px] text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Payout details hidden — click to reveal
                </motion.button>
              ) : (
                <motion.div
                  key="shown"
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                {bankEditing ? (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                    <div>
                      <label className="text-[10.5px] uppercase tracking-wide text-zinc-400">Bank Preferred (send-from)</label>
                      <SmoothSelect
                        value={bankForm.bank_preferred}
                        onChange={(v) => updBank('bank_preferred', v)}
                        aria-label="Bank Preferred (send-from rail)"
                        className="mt-1 w-full"
                        options={[
                          { value: '', label: 'Not set' },
                          // WIRES lock: a wires-preferred person (incl. unset)
                          // can never be offered Hurupay/HiGlobe — same option
                          // filter as the employee's own profile dropdown; the
                          // API re-enforces against the stored value on save.
                          ...BANK_PREFERRED_OPTIONS.filter(
                            (o) =>
                              !isWiresPreferred(bankInitialRef.current.bank_preferred || null) ||
                              (o.id !== 'hurupay' && o.id !== 'higlobe'),
                          ).map((o) => ({ value: o.id, label: o.label })),
                        ]}
                        portal
                      />
                      <p className="mt-1 text-[10.5px] text-zinc-400">The rail Payment Dispatch routes this salary on. Overrides the Disbursement pick.</p>
                    </div>
                    <div>
                      <label className="text-[10.5px] uppercase tracking-wide text-zinc-400">Disbursement (receive via)</label>
                      <SmoothSelect
                        value={bankForm.preferred_processor}
                        onChange={(v) => updBank('preferred_processor', v)}
                        aria-label="Disbursement pick (receive via)"
                        className="mt-1 w-full"
                        options={PROCESSOR_OPTIONS}
                        portal
                      />
                    </div>
                    {editShowsBank && (
                      <div>
                        <label className="text-[10.5px] uppercase tracking-wide text-zinc-400">Preferred bank slot</label>
                        <SmoothSelect
                          value={bankForm.preferred_bank_slot}
                          onChange={(v) => updBank('preferred_bank_slot', v)}
                          aria-label="Preferred bank slot"
                          className="mt-1 w-full"
                          options={[
                            { value: 'primary', label: 'Primary bank' },
                            { value: 'alternative', label: 'Alternative bank' },
                          ]}
                          portal
                        />
                      </div>
                    )}
                    {editShowsBank && (editAlt ? (
                      <>
                        <EditField label="Bank (alternative)" value={bankForm.alt_bank_name} onChange={(v) => updBank('alt_bank_name', v)} accent={accent} />
                        <EditField label="Account holder" value={bankForm.alt_account_holder_name} onChange={(v) => updBank('alt_account_holder_name', v)} accent={accent} />
                        <EditField label="Account no." value={bankForm.alt_account_number} onChange={(v) => updBank('alt_account_number', v)} accent={accent} />
                        <EditField label="Routing" value={bankForm.alt_routing_number} onChange={(v) => updBank('alt_routing_number', v)} accent={accent} />
                      </>
                    ) : (
                      <>
                        <EditField label="Bank" value={bankForm.bank_name} onChange={(v) => updBank('bank_name', v)} accent={accent} />
                        <EditField label="Account holder" value={bankForm.account_holder_name} onChange={(v) => updBank('account_holder_name', v)} accent={accent} />
                        <EditField label="Account no." value={bankForm.account_number} onChange={(v) => updBank('account_number', v)} accent={accent} />
                        <EditField label="Routing" value={bankForm.routing_number} onChange={(v) => updBank('routing_number', v)} accent={accent} />
                        <EditField label="SWIFT" value={bankForm.swift_code} onChange={(v) => updBank('swift_code', v)} accent={accent} />
                        <EditField label="Address" value={bankForm.full_address} onChange={(v) => updBank('full_address', v)} accent={accent} wide hint="Account holder's address for wires." />
                      </>
                    ))}
                    {editProc === 'jeeves' && (
                      <EditField label="Phone number" value={bankForm.phone_number} onChange={(v) => updBank('phone_number', v)} accent={accent} />
                    )}
                    {editProc === 'hurupay' && (
                      <EditField label="Hurupay email" value={bankForm.hurupay_email} onChange={(v) => updBank('hurupay_email', v)} accent={accent} type="email" />
                    )}
                    {editProc === 'wepay' && (
                      <EditField label="WePay email" value={bankForm.wepay_email} onChange={(v) => updBank('wepay_email', v)} accent={accent} type="email" />
                    )}
                    {editProc === 'higlobe' && (
                      <>
                        <EditField label="HiGlobe email" value={bankForm.higlobe_email} onChange={(v) => updBank('higlobe_email', v)} accent={accent} type="email" />
                        <EditField label="HiGlobe account" value={bankForm.higlobe_account_name} onChange={(v) => updBank('higlobe_account_name', v)} accent={accent} />
                      </>
                    )}
                  </div>
                  <p className="mt-3 text-[11px] text-zinc-400">
                    Saving updates the payout record payroll pays to — the change applies across all dashboards immediately and is recorded in the bank change history below.
                  </p>
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 px-3 text-[12px]" onClick={cancelBankEdit} disabled={bankSaving}>
                      <X className="h-3.5 w-3.5" /> Cancel
                    </Button>
                    <Button type="button" size="sm" className={cn('h-8 gap-1.5 px-3 text-[12px] font-medium', accent.btn)} onClick={saveBanking} disabled={bankSaving}>
                      {bankSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save changes
                    </Button>
                  </div>
                </div>
                ) : (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-[13px] dark:border-zinc-800 dark:bg-zinc-900/40">
                {!banking ? (
                  <p className="mb-2 text-[11px] text-zinc-400">No payout details on file yet — these fields will populate once the employee completes their payout setup.</p>
                ) : banking.masked ? (
                  <p className="mb-2 text-[11px] text-zinc-400">Sensitive fields are masked. Reveal is recorded in the audit log.</p>
                ) : null}
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  {/* The routing picture, mirrored from Payment Dispatch:
                      "Pays via" = the rail PD actually routes on; "Sends from" =
                      the Bank Preferred send-from pick that wins precedence;
                      "Disbursement pick" = how the employee elected to receive. */}
                  <Field
                    label="Pays via (Payment Dispatch)"
                    value={
                      banking?.effective_processor
                        ? banking.effective_processor.charAt(0).toUpperCase() +
                          banking.effective_processor.slice(1) +
                          (banking.effective_processor_source === 'rates_sheet'
                            ? ' — routed by the rates sheet'
                            : banking.effective_processor_source === 'bank_preferred'
                              ? ' — via Bank Preferred'
                              : '')
                        : banking
                          ? 'Not routed'
                          : null
                    }
                  />
                  <Field
                    label="Bank Preferred (send-from)"
                    value={banking ? (banking.bank_preferred || 'Not set') : null}
                    cap
                  />
                  <Field
                    label="Disbursement pick"
                    value={banking ? (banking.preferred_processor || 'Not set') : null}
                    cap
                  />
                  {/* No banking record → show the canonical bank/wires field set as
                      placeholders so the CEO sees where details are expected. */}
                  {(showBank || !banking) && (
                    <>
                      <Field label={`Bank${prefAlt ? ' (alternative)' : ''}`} value={prefBank.name} />
                      <Field label="Account holder" value={prefBank.holder} />
                      <Field label="Account no." value={prefBank.account} mono />
                      <Field label="SWIFT" value={prefBank.swift} mono />
                      <Field label="Routing" value={prefBank.routing} mono />
                      <Field label="Address" value={prefBank.address} wide />
                    </>
                  )}
                  {proc === 'hurupay' && <Field label="Hurupay email" value={banking?.hurupay_email ?? null} />}
                  {proc === 'wepay' && <Field label="WePay email" value={banking?.wepay_email ?? null} />}
                  {proc === 'higlobe' && (
                    <>
                      <Field label="HiGlobe email" value={banking?.higlobe_email ?? null} />
                      <Field label="HiGlobe account" value={banking?.higlobe_account_name ?? null} />
                    </>
                  )}
                  {proc === 'jeeves' && <Field label="Phone" value={banking?.phone_number ?? null} mono />}
                </dl>
                </div>
                )}
                </motion.div>
              )}
              </AnimatePresence>
            )}
          </div>

          {/* Bank change history — masked before→after per self-service edit,
              sourced from the dedicated bank_update_history table (not
              audit_log, which any admin can clear). Shares its detail dialog
              with the People-tab global "Recent bank changes" feed. */}
          <div className="mt-5">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <Landmark className="h-3.5 w-3.5 text-emerald-500" />
              Bank change history
            </h3>
            {loading ? (
              <ul className="space-y-1.5">
                {Array.from({ length: 2 }).map((_, i) => (
                  <li key={i} className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
                    <div className="space-y-1.5">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-2.5 w-24" />
                    </div>
                    <Skeleton className="h-7 w-14" />
                  </li>
                ))}
              </ul>
            ) : bankHistory.length === 0 ? (
              <p className="py-3 text-xs text-zinc-400">No self-service payout changes yet.</p>
            ) : (
              <>
              <ul className="space-y-1.5">
                {pagedBankHistory.map((h) => {
                  const changedCount = h.changes.length > 0
                    ? h.changes.filter((c) => c.changed && c.field !== 'preferred_processor').length
                    : h.fields.filter((f) => f !== 'preferred_processor').length;
                  return (
                    <li
                      key={h.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-[13px] dark:border-zinc-800 dark:bg-zinc-950"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-800 dark:text-zinc-100">
                            {h.createdNew ? 'First-time setup' : 'Updated details'}
                          </span>
                          {h.processor && (
                            <span className="inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10.5px] font-medium capitalize text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                              {h.processor}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] text-zinc-400">
                          {timeAgo(h.created_at)} · {changedCount > 0 ? `${changedCount} field${changedCount === 1 ? '' : 's'} changed` : 'no values changed'}
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 gap-1 px-2 text-[12px]"
                        onClick={() => setBankHistDetail(h)}
                      >
                        <Eye className="h-3.5 w-3.5" /> View
                      </Button>
                    </li>
                  );
                })}
              </ul>
              {bankHistTotalPages > 1 && (
                <div data-readonly-allow className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
                  <span>
                    Showing {bankHistStart + 1}–{Math.min(bankHistStart + HIST_PAGE_SIZE, bankHistory.length)} of {bankHistory.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[12px]"
                      disabled={bankHistSafePage <= 1}
                      onClick={() => setBankHistPage((p) => Math.max(1, p - 1))}
                    >
                      Prev
                    </Button>
                    <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                      {bankHistSafePage} / {bankHistTotalPages}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[12px]"
                      disabled={bankHistSafePage >= bankHistTotalPages}
                      onClick={() => setBankHistPage((p) => Math.min(bankHistTotalPages, p + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
              </>
            )}
          </div>

          </>
          )}

          {tab === 'payroll' && (
          <>
          {/* Payroll history */}
          <div className="mt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Payroll history</h3>
            {loading ? (
              <ul className="space-y-1.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <li key={i} className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
                    <div className="space-y-1.5">
                      <Skeleton className="h-3.5 w-44" />
                      <Skeleton className="h-2.5 w-24" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="ml-auto h-3.5 w-20" />
                      <Skeleton className="ml-auto h-2.5 w-12" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : history.length === 0 ? (
              <p className="py-3 text-xs text-zinc-400">No payroll records yet.</p>
            ) : (
              <>
              <AnimatePresence mode="wait" custom={histDirRef.current} initial={false}>
              <motion.ul
                key={histSafePage}
                custom={histDirRef.current}
                variants={{
                  enter: (d: number) => (reduceMotion ? { opacity: 0 } : { opacity: 0, x: d * 18 }),
                  center: { opacity: 1, x: 0 },
                  exit: (d: number) => (reduceMotion ? { opacity: 0 } : { opacity: 0, x: d * -18 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-1.5"
              >
                {pagedHistory.map((h, i) => (
                  <li
                    key={`${h.source_file}-${histStart + i}`}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[13px]',
                      h.kind === 'special'
                        ? 'border-violet-200 bg-violet-50/60 dark:border-violet-900/40 dark:bg-violet-950/20'
                        : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {h.kind === 'special' && (
                          <span className="inline-flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">
                            <Sparkles className="h-2.5 w-2.5" /> Special
                          </span>
                        )}
                        <span className="truncate font-medium text-zinc-800 dark:text-zinc-100">
                          {h.kind === 'special' ? (h.note || 'Special transfer') : formatPeriodRange(h.period_start, h.period_end)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-400">
                        {h.kind === 'special'
                          ? formatDay(h.paid_at ?? h.period_start)
                          : `${fmtHours(h.total_hours)} · ${(h.status ?? 'pending')}`}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-semibold text-zinc-900 dark:text-zinc-100">{fmtMoney(h.amount_php, 'PHP')}</div>
                      <div className={cn(
                        'text-[10.5px] font-medium',
                        h.status === 'paid' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
                      )}>
                        {h.status ?? 'pending'}
                      </div>
                    </div>
                  </li>
                ))}
              </motion.ul>
              </AnimatePresence>
              {histTotalPages > 1 && (
                <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
                  <span>
                    Showing {histStart + 1}–{Math.min(histStart + HIST_PAGE_SIZE, history.length)} of {history.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[12px]"
                      disabled={histSafePage <= 1}
                      onClick={() => goPage(-1)}
                    >
                      Prev
                    </Button>
                    <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                      {histSafePage} / {histTotalPages}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[12px]"
                      disabled={histSafePage >= histTotalPages}
                      onClick={() => goPage(1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
              </>
            )}
          </div>
          </>
          )}
          </motion.div>
          )}
          </AnimatePresence>

          {pabVisited && (
            <div className={cn('relative', tab === 'pab' ? '' : 'hidden')}>
              {/* Progress bar sits INSIDE the calendar box, centered over the
                  skeleton (which stays visible around it) — they load together,
                  and the bar only completes once the data actually lands. */}
              {showPabLoader && (
                <PabCalendarLoader progress={pabProgress} done={!pabLoading} barClassName={accent.bar} onDone={handlePabLoaderDone} />
              )}
              <EmployeePabCalendar
                employeeEmail={email}
                isHsl={isHsl}
                trimToElapsedWeeks={false}
                onLoadingChange={setPabLoading}
                onProgress={setPabProgress}
              />
            </div>
          )}
        </div>

        </div>
      </DialogContent>
    </Dialog>
    {bankHistDetail && (
      <BankChangeDetailDialog row={bankHistDetail} onClose={() => setBankHistDetail(null)} />
    )}
    <Dialog open={showEditWarning} onOpenChange={(o) => { if (!o) setShowEditWarning(false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
            </span>
            Edit sensitive information
          </DialogTitle>
          <DialogDescription>
            {editTarget === 'banking' ? (
              <>
                You&apos;re about to edit <span className="font-medium text-zinc-700 dark:text-zinc-200">{row.name ?? 'this person'}</span>&apos;s
                bank &amp; payout details. This is the record payroll pays their salary to — changes apply across all dashboards immediately and are audit-logged. Please make sure the details are correct before saving.
              </>
            ) : (
              <>
                You&apos;re about to edit <span className="font-medium text-zinc-700 dark:text-zinc-200">{row.name ?? 'this person'}</span>&apos;s
                information. This is sensitive personal data — changes write to the Global Master List and the Google Sheet, and are visible to Admin and HR. Please make sure the details are correct before saving.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <label className="mt-1 flex cursor-pointer items-center gap-2 text-[13px] text-zinc-600 select-none dark:text-zinc-300">
          <input
            type="checkbox"
            checked={snoozeWarning}
            onChange={(e) => setSnoozeWarning(e.target.checked)}
            className={cn('h-4 w-4 rounded border-zinc-300 dark:border-zinc-600', accent.check)}
          />
          Don&apos;t show this again soon
        </label>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 px-3 text-[12px]" onClick={() => setShowEditWarning(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" className={cn('h-8 gap-1.5 px-3 text-[12px] font-medium', accent.btn)} onClick={confirmEditWarning}>
            <Pencil className="h-3.5 w-3.5" /> Continue to edit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-[10.5px] uppercase tracking-wide text-zinc-400">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-zinc-900 dark:text-zinc-100">{value}</div>
      {sub && <div className="text-[11px] text-zinc-400">{sub}</div>}
    </div>
  );
}

function Field({ label, value, mono, cap, wide }: { label: string; value: string | null; mono?: boolean; cap?: boolean; wide?: boolean }) {
  const empty = !value;
  return (
    <div className={cn(wide && 'sm:col-span-2')}>
      <dt className="text-[10.5px] uppercase tracking-wide text-zinc-400">{label}</dt>
      <dd
        className={cn(
          empty
            ? 'italic text-zinc-400 dark:text-zinc-500'
            : cn('text-zinc-800 dark:text-zinc-100', mono && 'font-mono', cap && 'capitalize'),
        )}
      >
        {empty ? 'Not yet filled' : value}
      </dd>
    </div>
  );
}

/* ── Beautified read-only profile primitives ──────────────────────────────
   InfoCard groups related fields under an icon-badged header; InfoRow renders
   one label→value pair with a leading icon, a monospace/copyable option, and a
   consistent empty-state. Used by the Identity & contact read view so the
   fields read as a structured record rather than a flat label list. */
function InfoCard({
  icon: Icon,
  title,
  accent,
  children,
}: {
  icon: LucideIcon;
  title: string;
  accent: Accent;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800/70 dark:bg-zinc-900/40">
        <span className={cn('flex h-6 w-6 items-center justify-center rounded-md', accent.chipBg, accent.chipText)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h4>
      </div>
      <dl className="divide-y divide-zinc-100 dark:divide-zinc-800/70">{children}</dl>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
  mono,
  copyable,
}: {
  icon: LucideIcon;
  label: string;
  value: string | null;
  mono?: boolean;
  copyable?: boolean;
}) {
  const empty = !value;
  const [copied, setCopied] = useState(false);
  const canCopy = copyable && !empty;
  const doCopy = () => {
    if (!canCopy || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(value as string).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <div className="group flex items-start gap-2.5 px-3 py-1.5">
      <Icon className="mt-[2px] h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
      <div className="min-w-0 flex-1">
        <dt className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</dt>
        <dd
          className={cn(
            'mt-0.5 break-words text-[12.5px] leading-snug',
            empty
              ? 'italic text-zinc-400 dark:text-zinc-600'
              : cn('font-medium text-zinc-800 dark:text-zinc-100', mono && 'font-mono text-[12px]'),
          )}
        >
          {empty ? 'Not filled' : value}
        </dd>
      </div>
      {canCopy && (
        <button
          type="button"
          onClick={doCopy}
          className="mt-[2px] shrink-0 rounded p-0.5 text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-600 focus-visible:opacity-100 group-hover:opacity-100 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          aria-label={`Copy ${label}`}
          title={copied ? 'Copied' : `Copy ${label}`}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}

/* Special transfer / one-off payment removed — People is now a read-only surface. */
