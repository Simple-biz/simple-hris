'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cleanErrorMessage } from '@/lib/clean-error-message';
import {
  Loader2,
  AlertCircle,
  Camera,
  Trash2,
  Pencil,
  Lock,
  Save,
  CheckCircle,
  X,
  MapPin,
  ArrowUpRight,
  Plus,
  Briefcase,
  Bell,
  DoorOpen,
  Send,
  AlertTriangle,
  Clock,
  XCircle,
  FileText,
  FileSpreadsheet,
  Receipt,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { DatePicker } from '@/components/ui/date-picker';
import EmployeeAvatar from './EmployeeAvatar';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import {
  OFFICIAL_USD_TO_PHP_RATE,
  effectiveUsdToPhpRateFromStored,
} from '@/lib/fx/usd-php';
import { compressProfilePhotoForUpload } from '@/lib/images/compress-profile-photo';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import type { ResignationRequestRow } from '@/lib/supabase/resignation-requests';
import {
  downloadPayStubsPdf,
  downloadPayStubsXlsx,
  type PayStubWeek,
} from '@/lib/payroll/paystub-export';
import { PayStubModal } from '@/components/paystub/PayStubModal';

/** Lightweight per-week row for the paginated Pay Stubs list (GET
 *  /api/employee/paystub?summary=1) — total + dates only, no itemized breakdown,
 *  so the list loads fast. The full statement loads lazily per week (modal) and
 *  the full set only on export. */
interface PayStubSummaryRow {
  sourceFile: string;
  weekStart: string | null;
  weekEnd: string | null;
  weekHuman: string;
  totalPayPhp: number;
  totalPayUsd: number;
  paidAt: string | null;
  payDate: string | null;
}

/** How many weeks per page in the Pay Stubs list. */
const PAY_STUBS_PAGE_SIZE = 10;
import RequestDocumentsTab from '@/components/employee/RequestDocumentsTab';
import {
  PROCESSOR_OPTIONS,
  type ProcessorId,
  isProcessorId,
  BANK_PREFERRED_OPTIONS,
  bankPreferredLabelForProcessor,
  processorForBankPreferredLabel,
  isWiresPreferred,
} from '@/lib/employee-payment-processors';
import { getTitlesForDepartment, hasAnySkillSetContent } from '@/lib/skill-set-titles';
import {
  PreferredPaymentMethodRadios,
  PayoutDetailsFields,
  emptyPayout,
  payoutDraftFromIdsRow,
  isPayoutComplete,
  type PayoutFields,
} from '@/components/employee/employee-payout-fields';

interface EmployeeProfileProps {
  employeeEmail: string;
  profilePhotoUrl: string | null;
  /** Google SSO profile picture (`session.user.image`) — fallback when no Supabase upload. */
  googlePhotoUrl?: string | null;
  focusTab?: TabId;
  onProfilePhotoUpdated: (url: string | null) => void;
  /** Notifies the shell whether payout/bank details are now complete (clears the nudge). */
  onPayoutCompletionChange?: (complete: boolean) => void;
  onSkillSetCompletionChange?: (complete: boolean) => void;
  /** When accounting starts payroll processing, bank / payout editing is disabled. */
  payrollLocked?: boolean;
  /**
   * Accounting/CEO explicitly asked this person (from the People tab) to add
   * their missing payout details AND they still haven't. Escalates the Payment
   * tab's ping to rose and shows a callout guiding them to fill it in.
   */
  escalatePayment?: boolean;
}

/* ───────── Pure helpers ───────── */

function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseRate(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function formatStartDate(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const s = raw.trim();
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return s;
}

function matchesEmployeeEmail(emp: EmployeeRow, n: string): boolean {
  const we = normEmail(emp.work_email ?? '');
  const pe = normEmail(emp.personal_email ?? '');
  return we === n || pe === n;
}

/* ───────── Visual primitives ───────── */

type TabId = 'overview' | 'compensation' | 'payStubs' | 'payment' | 'skillsets' | 'reports' | 'requestDocuments' | 'resign';

interface SkillSetFields {
  role_title: string;
  currently_working_on: string;
  skills: string;
  strengths: string;
  member_notes: string;
  /** Free-typed personal list of project names. */
  projects: string[];
  /** The 1-2 the employee is currently on (subset of projects), in display order. */
  current_projects: string[];
}

const EMPTY_SKILL_SET: SkillSetFields = {
  role_title: '',
  currently_working_on: '',
  skills: '',
  strengths: '',
  member_notes: '',
  projects: [],
  current_projects: [],
};

const MAX_CURRENT_PROJECTS = 2;

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200/80 bg-white transition-colors duration-200 hover:border-zinc-300/80 dark:border-zinc-800/80 dark:bg-zinc-950/40 dark:hover:border-zinc-700/80">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800/60 sm:px-6">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">
            {title}
          </h3>
          {description && (
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="px-5 py-2 sm:px-6">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  mono = false,
  status,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  status?: 'active' | 'paused';
}) {
  const text = value?.trim();
  if (!text) return null;
  return (
    <div className="grid grid-cols-1 items-center gap-1 border-b border-zinc-100 py-3.5 last:border-b-0 dark:border-zinc-800/40 sm:grid-cols-[10rem_1fr] sm:gap-6">
      <div className="text-[12px] font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
      <div
        className={[
          'min-w-0 text-[14px] text-zinc-900 dark:text-zinc-100',
          mono ? 'text-[13px] tracking-tight' : '',
        ].join(' ')}
      >
        {status === 'active' && (
          <span className="mr-2 inline-flex items-center gap-1.5 align-baseline">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
          </span>
        )}
        <span className="break-words">{text}</span>
      </div>
    </div>
  );
}

function SetupNudge({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-[12.5px] dark:border-amber-500/30 dark:bg-amber-500/10 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="relative mt-0.5 flex h-3 w-3 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500/70" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-amber-950 dark:text-amber-100">{title}</p>
          <p className="mt-0.5 leading-relaxed text-amber-900/80 dark:text-amber-100/75">
            {description}
          </p>
        </div>
      </div>
      {action && <div className="shrink-0 sm:pl-3">{action}</div>}
    </div>
  );
}

function CompactStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      <span className="text-[22px] font-medium tracking-tight text-zinc-900 dark:text-zinc-100">
        {value}
      </span>
      {hint && (
        <span className="text-[12px] text-zinc-500 dark:text-zinc-400">{hint}</span>
      )}
    </div>
  );
}

function SkillSetField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
          {label}
        </span>
        {hint && (
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{hint}</span>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="mt-1.5 w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13.5px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-100 dark:focus:border-orange-500/40 dark:focus:ring-orange-500/20"
      />
    </label>
  );
}

/**
 * Projects editor — the employee free-types the projects they work on, then
 * marks 1-2 they are currently on. The selected ones display joined with
 * " and " on their own + their teammates' My Team cards.
 */
function ProjectsField({
  projects,
  current,
  onChange,
}: {
  projects: string[];
  current: string[];
  onChange: (projects: string[], current: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const addProject = () => {
    const name = draft.trim();
    if (!name) return;
    if (projects.some((p) => p.toLowerCase() === name.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...projects, name], current);
    setDraft('');
  };

  const removeProject = (name: string) => {
    onChange(
      projects.filter((p) => p !== name),
      current.filter((p) => p !== name),
    );
  };

  const toggleCurrent = (name: string) => {
    if (current.includes(name)) {
      onChange(projects, current.filter((p) => p !== name));
    } else if (current.length < MAX_CURRENT_PROJECTS) {
      onChange(projects, [...current, name]);
    }
  };

  const preview = current.length > 0 ? current.join(' and ') : null;

  return (
    <div className="block">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
          Projects
        </span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
          Add what you work on, then mark 1–2 you’re currently on
        </span>
      </div>

      {/* Add a project */}
      <div className="mt-1.5 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addProject();
            }
          }}
          placeholder="e.g. Gridline Billing System"
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px] text-zinc-900 placeholder:text-zinc-400 focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-orange-500/40 dark:focus:ring-orange-500/20"
        />
        <Button
          type="button"
          size="sm"
          onClick={addProject}
          disabled={!draft.trim()}
          className="h-auto gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-700 dark:hover:bg-zinc-600"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {/* Project list with current toggles */}
      {projects.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5">
          {projects.map((name) => {
            const isCurrent = current.includes(name);
            const atLimit = !isCurrent && current.length >= MAX_CURRENT_PROJECTS;
            return (
              <li
                key={name}
                className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 dark:border-zinc-800 dark:bg-zinc-950/50"
              >
                <button
                  type="button"
                  onClick={() => toggleCurrent(name)}
                  disabled={atLimit}
                  title={
                    isCurrent
                      ? 'Currently working on this — click to unset'
                      : atLimit
                        ? `You can mark at most ${MAX_CURRENT_PROJECTS} as current`
                        : 'Mark as currently working on'
                  }
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    isCurrent
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300'
                      : 'border-zinc-200 bg-zinc-50 text-zinc-500 hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
                  )}
                >
                  {isCurrent && <CheckCircle className="h-3 w-3" />}
                  {isCurrent ? 'Current' : 'Set current'}
                </button>
                <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-800 dark:text-zinc-200" title={name}>
                  {name}
                </span>
                <button
                  type="button"
                  onClick={() => removeProject(name)}
                  title="Remove project"
                  aria-label={`Remove ${name}`}
                  className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-2.5 text-[12.5px] italic text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-600">
          No projects added yet.
        </p>
      )}

      {/* Live preview of what teammates will see */}
      <div className="mt-2 flex items-start gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
        <Briefcase className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {preview ? (
          <span>
            Currently working on{' '}
            <span className="font-medium text-zinc-700 dark:text-zinc-200">{preview}</span>
          </span>
        ) : (
          <span className="italic text-zinc-400 dark:text-zinc-600">
            Mark 1–2 projects as current so your team can see what you’re on.
          </span>
        )}
      </div>
    </div>
  );
}

function TabBar({
  active,
  onChange,
  hasAddress,
  needsPhoto,
  needsBank,
  needsSkillSet,
  paymentEscalated = false,
  resignPending = false,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
  hasAddress: boolean;
  needsPhoto: boolean;
  needsBank: boolean;
  needsSkillSet: boolean;
  /** Escalate the Payment tab's ping to rose (accounting requested bank info). */
  paymentEscalated?: boolean;
  /** A resignation request is awaiting the manager — show a rose dot on Resign. */
  resignPending?: boolean;
}) {
  const tabs: { id: TabId; label: string; sub: string }[] = [
    { id: 'overview', label: 'Overview', sub: hasAddress ? 'Identity, employment, address' : 'Identity & employment' },
    { id: 'compensation', label: 'Compensation', sub: 'Rates & currency' },
    { id: 'payStubs', label: 'Pay Stubs', sub: 'Weekly statements & exports' },
    { id: 'payment', label: 'Payment', sub: 'Disbursement details' },
    { id: 'skillsets', label: 'Skill Sets', sub: 'Visible to teammates' },
    { id: 'reports', label: 'Reports', sub: 'Commendations' },
    { id: 'requestDocuments', label: 'Request Documents', sub: 'COE, pay stubs & certificates' },
    { id: 'resign', label: 'Resign', sub: 'End your employment' },
  ];

  return (
    <LayoutGroup id="employee-profile-tabs">
      <div
        className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Profile sections"
      >
        {tabs.map((t) => {
          const isActive = active === t.id;
          const hasIssue =
            (t.id === 'overview' && needsPhoto) ||
            (t.id === 'payment' && needsBank) ||
            (t.id === 'skillsets' && needsSkillSet) ||
            (t.id === 'resign' && resignPending);
          const escalated =
            (t.id === 'payment' && paymentEscalated) || (t.id === 'resign' && resignPending);
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(t.id)}
              className={[
                'relative shrink-0 px-2.5 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#0a0a0a] sm:px-3',
                isActive
                  ? 'text-zinc-900 dark:text-zinc-50'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200',
              ].join(' ')}
            >
              <span className="block text-[13.5px] font-medium tracking-[-0.01em]">{t.label}</span>
              <span className="mt-0.5 block whitespace-nowrap text-[11px] text-zinc-400 dark:text-zinc-500">
                {t.sub}
              </span>
              {hasIssue && (
                <span
                  className="absolute right-1.5 top-2 flex h-2.5 w-2.5"
                  aria-label={escalated ? `${t.label} details requested` : `${t.label} setup needed`}
                >
                  <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full', escalated ? 'bg-rose-500/70' : 'bg-amber-500/70')} />
                  <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-[#0a0a0a]', escalated ? 'bg-rose-500' : 'bg-amber-500')} />
                </span>
              )}
              {isActive && (
                <motion.span
                  layoutId="profile-tab-underline"
                  className="absolute -bottom-px left-0 right-0 h-[2px] rounded-full bg-orange-500"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                />
              )}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-white dark:bg-[#0a0a0a]">
      <div className="mx-auto w-full max-w-[1400px] px-5 pb-16 pt-8 sm:px-8 sm:pt-12 lg:px-10">
        {/* Header — avatar + name + dept/ID + Active badge (mirrors the real header row). */}
        <div className="flex items-center gap-4 sm:gap-6">
          <div className="h-16 w-16 shrink-0 animate-pulse rounded-full bg-zinc-100 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800 sm:h-20 sm:w-20" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-7 w-48 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900 sm:h-8 sm:w-64" />
            <div className="h-3.5 w-40 animate-pulse rounded bg-zinc-100/70 dark:bg-zinc-900/70" />
            <div className="h-5 w-20 animate-pulse rounded-full bg-emerald-100/70 dark:bg-emerald-500/10" />
          </div>
        </div>
        {/* Tab bar (Overview / Payment / Skill Sets / …). */}
        <div className="mt-8 flex gap-1 border-b border-zinc-200 dark:border-zinc-800 sm:mt-10">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="px-4 py-3">
              <div
                className="h-3.5 w-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900"
                style={{ animationDelay: `${i * 80}ms` }}
              />
            </div>
          ))}
        </div>
        {/* Tab content — section cards with title + description + label/value rows. */}
        <div className="mt-6 space-y-4 sm:mt-8">
          {[0, 1].map((s) => (
            <div
              key={s}
              className="rounded-2xl border border-zinc-200/80 bg-white p-5 dark:border-zinc-800/80 dark:bg-zinc-950/40"
            >
              <div className="h-4 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
              <div className="mt-1 h-2.5 w-40 animate-pulse rounded bg-zinc-100/70 dark:bg-zinc-900/70" />
              <div className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-800/60">
                {[0, 1, 2].map((r) => (
                  <div key={r} className="flex items-center justify-between py-3.5">
                    <div className="h-3 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
                    <div
                      className="h-3.5 w-36 animate-pulse rounded bg-zinc-100/70 dark:bg-zinc-900/70"
                      style={{ animationDelay: `${r * 90}ms` }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────── Main component ───────── */

export default function EmployeeProfile({
  employeeEmail,
  profilePhotoUrl,
  googlePhotoUrl = null,
  focusTab = 'overview',
  onProfilePhotoUpdated,
  onPayoutCompletionChange,
  onSkillSetCompletionChange,
  payrollLocked = false,
  escalatePayment = false,
}: EmployeeProfileProps) {
  const norm = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [removingPhoto, setRemovingPhoto] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [master, setMaster] = useState<EmployeeRow | null>(null);
  const [rate, setRate] = useState<EmployeeHourlyRateRow | null>(null);
  const [bankInfo, setBankInfo] = useState<EmployeeIdRow | null>(null);
  const [usdToPhpRate, setUsdToPhpRate] = useState(OFFICIAL_USD_TO_PHP_RATE);

  const [preferredProcessor, setPreferredProcessor] = useState<ProcessorId | ''>('');
  // "Bank Preferred" — the processor Payment Dispatch routes salary through.
  // SEPARATE from preferredProcessor (Disbursement); changing one never changes
  // the other. Stored in employee_ids.bank_preferred (x1153 → 'wires').
  const [bankPreferred, setBankPreferred] = useState<ProcessorId | ''>('');
  // A pending Bank Preferred change awaiting accounting approval (the requested
  // processor id), or null. The live `bankPreferred` above still shows the
  // currently-approved value until accounting approves this.
  const [pendingBankPreferred, setPendingBankPreferred] = useState<ProcessorId | ''>('');
  const [payout, setPayout] = useState<PayoutFields>(() => ({ ...emptyPayout }));
  const [payoutSaving, setPayoutSaving] = useState(false);
  const [payoutSavedAt, setPayoutSavedAt] = useState<string | null>(null);
  const [payoutEditing, setPayoutEditing] = useState(false);

  const [activeTab, setActiveTab] = useState<TabId>('overview');

  useEffect(() => {
    setActiveTab(focusTab);
  }, [focusTab]);

  // ── Resignation (Profile → Resign) ──
  // The employee's own current/last resignation request. A `pending` one shows a
  // status card + Withdraw; anything else falls back to the file-a-resignation form.
  const [resignation, setResignation] = useState<ResignationRequestRow | null>(null);
  const [resignEffectiveDate, setResignEffectiveDate] = useState('');
  const [resignMessage, setResignMessage] = useState('');
  const [resignConfirmOpen, setResignConfirmOpen] = useState(false);
  const [resignSubmitting, setResignSubmitting] = useState(false);
  const [resignWithdrawing, setResignWithdrawing] = useState(false);

  const refreshResignation = React.useCallback(async () => {
    try {
      const res = await fetch(
        `/api/resignation-requests?employee_email=${encodeURIComponent(employeeEmail)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { rows?: ResignationRequestRow[] };
      const rows = json.rows ?? [];
      // Prefer an active pending request; else show the most recent (approved/rejected/cancelled).
      const pending = rows.find((r) => r.status === 'pending');
      setResignation(pending ?? rows[0] ?? null);
    } catch {
      /* non-fatal — the form still renders */
    }
  }, [employeeEmail]);

  useEffect(() => {
    void refreshResignation();
  }, [refreshResignation]);

  const submitResignation = async () => {
    if (!resignEffectiveDate) {
      toast.error('Choose your effective date.');
      return;
    }
    setResignSubmitting(true);
    try {
      const res = await fetch('/api/resignation-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_email: norm,
          employee_name: displayName && displayName !== '—' ? displayName : null,
          employee_work_email: workEmail,
          employee_personal_email: personalEmail,
          department: employmentDepartment,
          effective_date: resignEffectiveDate,
          message: resignMessage.trim() || null,
        }),
      });
      const json = (await res.json()) as { error?: string; manager_emails?: string[] | null };
      if (!res.ok) throw new Error(json.error || 'Submit failed');
      const managers = (json.manager_emails ?? []).filter(Boolean);
      toast.success('Resignation submitted', {
        description: managers.length
          ? 'Sent to your department manager for approval.'
          : 'No department manager is configured yet — HR will follow up.',
      });
      setResignConfirmOpen(false);
      setResignMessage('');
      setResignEffectiveDate('');
      await refreshResignation();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not submit resignation');
    } finally {
      setResignSubmitting(false);
    }
  };

  const withdrawResignation = async () => {
    if (!resignation) return;
    setResignWithdrawing(true);
    try {
      const res = await fetch(`/api/resignation-requests/${resignation.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Withdraw failed');
      toast.success('Resignation withdrawn');
      await refreshResignation();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not withdraw resignation');
    } finally {
      setResignWithdrawing(false);
    }
  };

  interface Commendation { id: string; note: string | null; awarded_by: string; awarded_at: string; }
  const [commendations, setCommendations] = useState<Commendation[]>([]);
  const [commendationsLoading, setCommendationsLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setCommendationsLoading(true);
    void fetch('/api/employee/commendations')
      .then((r) => r.ok ? r.json() : [])
      .then((d: unknown) => { if (!cancelled) setCommendations(d as Commendation[]); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCommendationsLoading(false); });
    return () => { cancelled = true; };
  }, [employeeEmail]);

  // ── Pay Stubs (Profile → Pay Stubs) ──
  // Every PAID week's full statement (`GET /api/employee/paystub?all=1`, session-
  // scoped). Loaded lazily the first time the tab is opened; backs the week list,
  // the per-week modal, and the all-weeks PDF/XLSX export.
  const [payStubs, setPayStubs] = useState<PayStubSummaryRow[]>([]);
  const [payStubsLoading, setPayStubsLoading] = useState(false);
  const [payStubsError, setPayStubsError] = useState<string | null>(null);
  const [payStubModalFile, setPayStubModalFile] = useState<string | null>(null);
  const [payStubPage, setPayStubPage] = useState(0);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  // Fetch the lightweight summary list exactly once — the first time the tab is
  // opened. A ref (not state) gates it, so flipping `loading` can't re-trigger
  // the effect and cancel its own in-flight request. EmployeeProfile stays
  // mounted across tab switches, so no cleanup/cancellation is needed.
  const payStubsRequestedRef = useRef(false);
  // Cache of the FULL statements (with itemized breakdown) — fetched lazily on
  // the first export click, then reused for subsequent exports.
  const payStubsFullRef = useRef<PayStubWeek[] | null>(null);

  useEffect(() => {
    if (activeTab !== 'payStubs' || payStubsRequestedRef.current) return;
    payStubsRequestedRef.current = true;
    setPayStubsLoading(true);
    setPayStubsError(null);
    // Summary mode: totals + dates only (no heavy per-week engine) so the list
    // paints fast. Full statements load on demand (per-week modal / export).
    void fetch('/api/employee/paystub?summary=1', { cache: 'no-store' })
      .then(async (r) => {
        const json = (await r.json()) as { stubs?: PayStubSummaryRow[]; error?: string };
        if (!r.ok) {
          setPayStubsError(json.error || 'Could not load your pay stubs.');
          return;
        }
        setPayStubs(json.stubs ?? []);
      })
      .catch(() => setPayStubsError('Could not load your pay stubs.'))
      .finally(() => setPayStubsLoading(false));
  }, [activeTab]);

  /** Fetch (once) + cache the full statements for the all-weeks PDF/XLSX export. */
  const ensurePayStubsFull = async (): Promise<PayStubWeek[]> => {
    if (payStubsFullRef.current) return payStubsFullRef.current;
    const r = await fetch('/api/employee/paystub?all=1', { cache: 'no-store' });
    const json = (await r.json()) as { stubs?: PayStubWeek[]; error?: string };
    if (!r.ok) throw new Error(json.error || 'Could not load your pay stubs.');
    const stubs = json.stubs ?? [];
    payStubsFullRef.current = stubs;
    return stubs;
  };

  // Skill Sets - editable by the employee, read-only on the My Team page.
  const [skillSet, setSkillSet] = useState<SkillSetFields>(EMPTY_SKILL_SET);
  const [skillSetBaseline, setSkillSetBaseline] = useState<SkillSetFields>(EMPTY_SKILL_SET);
  const [skillSetLoading, setSkillSetLoading] = useState(false);
  const [skillSetLoaded, setSkillSetLoaded] = useState(false);
  const [skillSetSaving, setSkillSetSaving] = useState(false);
  const [skillSetSavedAt, setSkillSetSavedAt] = useState<string | null>(null);
  // True once the employee explicitly picks "Custom title…" so the free-text
  // input stays open even if the typed value happens to match a preset.
  const [roleTitleCustom, setRoleTitleCustom] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSkillSetLoading(true);
    setSkillSetLoaded(false);
    void fetch(`/api/employee-skill-sets?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { row: null }))
      .then((d: { row: SkillSetFields | null }) => {
        if (cancelled) return;
        const row = d.row ?? EMPTY_SKILL_SET;
        const fields: SkillSetFields = {
          role_title: row.role_title ?? '',
          currently_working_on: row.currently_working_on ?? '',
          skills: row.skills ?? '',
          strengths: row.strengths ?? '',
          member_notes: row.member_notes ?? '',
          projects: Array.isArray(row.projects) ? row.projects : [],
          current_projects: Array.isArray(row.current_projects) ? row.current_projects : [],
        };
        setSkillSet(fields);
        setSkillSetBaseline(fields);
        onSkillSetCompletionChange?.(hasAnySkillSetContent(fields));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setSkillSetLoading(false);
          setSkillSetLoaded(true);
        }
      });
    return () => { cancelled = true; };
  }, [employeeEmail]);

  const skillSetDirty =
    skillSet.role_title !== skillSetBaseline.role_title ||
    skillSet.skills !== skillSetBaseline.skills ||
    skillSet.strengths !== skillSetBaseline.strengths ||
    JSON.stringify(skillSet.projects) !== JSON.stringify(skillSetBaseline.projects) ||
    JSON.stringify(skillSet.current_projects) !== JSON.stringify(skillSetBaseline.current_projects);

  const saveSkillSet = async () => {
    setSkillSetSaving(true);
    try {
      const res = await fetch('/api/employee-skill-sets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: norm,
          role_title: skillSet.role_title,
          skills: skillSet.skills,
          strengths: skillSet.strengths,
          projects: skillSet.projects,
          current_projects: skillSet.current_projects,
        }),
      });
      const json = (await res.json()) as { row?: SkillSetFields; error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
      setSkillSetBaseline({ ...skillSet });
      onSkillSetCompletionChange?.(hasAnySkillSetContent(skillSet));
      setSkillSetSavedAt(new Date().toLocaleTimeString());
      toast.success('Skill Sets saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save Skill Sets');
    } finally {
      setSkillSetSaving(false);
    }
  };

  useEffect(() => {
    if (!bankInfo) {
      setPreferredProcessor('');
      setBankPreferred('');
      setPayout({ ...emptyPayout });
      setPayoutEditing(true);
      return;
    }
    const d = payoutDraftFromIdsRow(bankInfo as unknown as Record<string, unknown>);
    setPreferredProcessor(d.preferredProcessor);
    setBankPreferred(isProcessorId(bankInfo.bank_preferred ?? '') ? (bankInfo.bank_preferred as ProcessorId) : '');
    setPayout(d.payout);
    setPayoutEditing(false);
  }, [bankInfo]);

  const resetPayoutDraft = React.useCallback(() => {
    if (!bankInfo) {
      setPreferredProcessor('');
      setBankPreferred('');
      setPayout({ ...emptyPayout });
      setPayoutEditing(true);
      return;
    }
    const d = payoutDraftFromIdsRow(bankInfo as unknown as Record<string, unknown>);
    setPreferredProcessor(d.preferredProcessor);
    setBankPreferred(isProcessorId(bankInfo.bank_preferred ?? '') ? (bankInfo.bank_preferred as ProcessorId) : '');
    setPayout(d.payout);
    setPayoutEditing(false);
  }, [bankInfo]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      setLoading(true);
      try {
        // Server-side `?email=` filter: each route returns just this employee's
        // row instead of the full table. Same pattern documented in
        // memory/project_employee_portal_filtered_endpoints.md.
        const emailParam = `email=${encodeURIComponent(employeeEmail)}`;
        const [empRes, rateRes, idsRes, fxRes] = await Promise.all([
          fetch(`/api/employees?${emailParam}`, { cache: 'no-store' }),
          fetch(`/api/employee-hourly-rates?${emailParam}`, { cache: 'no-store' }),
          fetch(`/api/employee-ids?${emailParam}`, { cache: 'no-store' }),
          fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
        ]);

        const empJson = (await empRes.json()) as { employees?: EmployeeRow[]; error?: string | null };
        const rateJson = (await rateRes.json()) as { rows?: EmployeeHourlyRateRow[]; error?: string | null };
        const idsJson = (await idsRes.json()) as { rows?: EmployeeIdRow[]; error?: string | null };
        const fxJson = (await fxRes.json()) as { value: string | null };

        if (cancelled) return;

        if (fxRes.ok) {
          setUsdToPhpRate(effectiveUsdToPhpRateFromStored(fxJson.value));
        }

        if (empJson.error) setError(empJson.error);
        // Server already filtered to this employee; just take the first row.
        const me = (empJson.employees ?? [])[0];

        // Always also fetch /api/employee-master-record. It queries `global_master_list`
        // directly (where the address columns live) and works as both:
        //   1. Identity fallback when the user isn't in `active_employees` (devs/founders)
        //   2. Address-data supplement when the active_employees view hasn't been
        //      refreshed since the address migration (2026-05-02) — in that case,
        //      `me` is missing the home-address fields, so we merge them in here.
        let masterRecord: EmployeeRow | null = null;
        try {
          const mrRes = await fetch(
            `/api/employee-master-record?email=${encodeURIComponent(employeeEmail)}`,
            { cache: 'no-store' },
          );
          const mrJson = (await mrRes.json()) as { employee?: EmployeeRow | null };
          masterRecord = mrJson.employee ?? null;
        } catch {
          /* ignore — fall back to active_employees row alone */
        }

        if (!cancelled) {
          if (me) {
            setMaster({
              ...me,
              street: me.street ?? masterRecord?.street ?? null,
              city: me.city ?? masterRecord?.city ?? null,
              province: me.province ?? masterRecord?.province ?? null,
              postal_code: me.postal_code ?? masterRecord?.postal_code ?? null,
              full_address: me.full_address ?? masterRecord?.full_address ?? null,
            });
          } else {
            setMaster(masterRecord);
          }
        }

        if (rateJson.error && !empJson.error) setError(rateJson.error ?? null);
        const myRate = (rateJson.rows ?? [])[0];
        setRate(myRate ?? null);

        if (idsJson.error && !empJson.error && !rateJson.error) {
          setError(idsJson.error);
        }
        const myId = (idsJson.rows ?? [])[0];
        setBankInfo(myId ?? null);

        // A pending Bank Preferred change (awaiting accounting approval) shows as
        // a badge on the field; the live value stays whatever's on employee_ids.
        try {
          const bpRes = await fetch(`/api/bank-preferred-requests?${emailParam}`, { cache: 'no-store' });
          const bpJson = (await bpRes.json()) as { rows?: { to_value?: string; status?: string }[] };
          if (!cancelled) {
            const latest = (bpJson.rows ?? [])[0];
            setPendingBankPreferred(
              latest?.status === 'pending' && isProcessorId(latest.to_value ?? '')
                ? (latest.to_value as ProcessorId)
                : '',
            );
          }
        } catch {
          /* non-fatal — just no badge */
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load profile');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [norm, employeeEmail]);

  const displayName =
    master?.name?.trim() || employeeEmail.split('@')[0]?.replace(/\./g, ' ') || '—';

  const employmentDepartment = master?.department?.trim() || null;
  // Role / Title suggestions tailored to the employee's department (falls back
  // to the general list when the department is unknown).
  const roleTitleOptions = useMemo(
    () => getTitlesForDepartment(employmentDepartment),
    [employmentDepartment],
  );
  const reg = parseRate(rate?.regular_rate ?? null);
  const ot = parseRate(rate?.ot_rate ?? null);

  const avatarEmail =
    master?.work_email?.trim() || rate?.work_email?.trim() || employeeEmail.trim() || null;

  const displayProfilePhotoUrl =
    profilePhotoUrl?.trim() || master?.profile_photo_url?.trim() || null;
  const payoutReadOnly = payrollLocked || !payoutEditing;

  const hasAnyAddress = !!(
    master?.full_address ||
    master?.street ||
    master?.city ||
    master?.province ||
    master?.postal_code
  );

  const onAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingPhoto(true);
    try {
      const blob = await compressProfilePhotoForUpload(file);
      const fd = new FormData();
      fd.append('email', employeeEmail);
      fd.append('file', blob, 'avatar.jpg');
      const res = await fetch('/api/employee-profile-photo', { method: 'POST', body: fd });
      const json = (await res.json()) as { profilePhotoUrl?: string; error?: string };
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      if (!json.profilePhotoUrl) throw new Error('No photo URL returned');
      onProfilePhotoUpdated(json.profilePhotoUrl);
      toast.success('Profile photo updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not upload photo');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const onAvatarRemove = async () => {
    setRemovingPhoto(true);
    try {
      const res = await fetch(
        `/api/employee-profile-photo?email=${encodeURIComponent(employeeEmail)}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || 'Could not remove photo');
      onProfilePhotoUpdated(null);
      toast.success('Profile photo removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove photo');
    } finally {
      setRemovingPhoto(false);
    }
  };

  const avatarInitials = useMemo(() => {
    const n = displayName.replace(/—/g, '').trim();
    if (n) {
      const parts = n.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      if (parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + (parts[0][1] || parts[0][0])).toUpperCase();
    }
    return employeeEmail.slice(0, 2).toUpperCase();
  }, [displayName, employeeEmail]);

  const savePaymentDetails = async () => {
    if (payrollLocked) {
      toast.error('Payroll processing is in progress', {
        description: 'Bank and payout details cannot be edited until accounting finishes.',
      });
      return;
    }
    setPayoutSaving(true);
    try {
      const bootstrapName =
        displayName && displayName !== '—' ? displayName.trim() : '';

      const res = await fetch('/api/update-employee-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: norm,
          bootstrap_display_name: bootstrapName || undefined,
          preferred_processor: preferredProcessor || null,
          bank_preferred: bankPreferred || null,
          preferred_bank_slot: payout.preferredBankSlot || null,
          hurupay_email: payout.hurupayEmail,
          wepay_email: payout.wepayEmail,
          higlobe_email: payout.higlobeEmail,
          higlobe_account_name: payout.higlobeAccountName,
          wise_email: payout.wiseEmail,
          wise_tag: payout.wiseTag,
          phone_number: payout.phoneNumber,
          full_address: payout.fullAddress,
          bank_name: payout.bankName,
          account_holder_name: payout.accountHolderName,
          account_number: payout.accountNumber,
          swift_code: payout.swiftCode,
          alt_bank_name: payout.altBankName,
          alt_account_holder_name: payout.altAccountHolderName,
          alt_account_number: payout.altAccountNumber,
          alt_routing_number: payout.altSwiftCode,
        }),
      });
      const json = (await res.json()) as {
        error?: string | null;
        success?: boolean;
        bankPreferredRequested?: boolean;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');

      const idsRes = await fetch(
        `/api/employee-ids?email=${encodeURIComponent(employeeEmail)}`,
        { cache: 'no-store' },
      );
      const idsJson = (await idsRes.json()) as { rows?: EmployeeIdRow[] };
      const myId = (idsJson.rows ?? [])[0];
      setBankInfo(myId ?? null);
      onPayoutCompletionChange?.(isPayoutComplete((myId as unknown as Record<string, unknown>) ?? null));
      setPayoutSavedAt(new Date().toLocaleTimeString());
      setPayoutEditing(false);

      // A Bank Preferred change is held for accounting approval — reflect the
      // pending state immediately (the live dropdown reverts to the approved
      // value via the bankInfo reload above).
      if (json.bankPreferredRequested) {
        setPendingBankPreferred(bankPreferred);
        toast.success('Payment details saved', {
          description: 'Your Bank Preferred change was sent to Accounting for approval.',
        });
      } else {
        toast.success('Payment details saved');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save payment details');
    } finally {
      setPayoutSaving(false);
    }
  };

  const payStubExportName = displayName && displayName !== '—' ? displayName : employeeEmail;
  const payStubTotalPhp = payStubs.reduce((s, w) => s + w.totalPayPhp, 0);
  const payStubTotalUsd = payStubs.reduce((s, w) => s + w.totalPayUsd, 0);
  const payStubPageCount = Math.max(1, Math.ceil(payStubs.length / PAY_STUBS_PAGE_SIZE));
  const payStubPageSafe = Math.min(payStubPage, payStubPageCount - 1);
  const payStubPageRows = payStubs.slice(
    payStubPageSafe * PAY_STUBS_PAGE_SIZE,
    payStubPageSafe * PAY_STUBS_PAGE_SIZE + PAY_STUBS_PAGE_SIZE,
  );

  const handleExportPayStubsPdf = async () => {
    if (!payStubs.length) return;
    setExportingPdf(true);
    try {
      const full = await ensurePayStubsFull();
      await downloadPayStubsPdf(full, {
        employeeName: payStubExportName,
        department: employmentDepartment,
      });
      toast.success('Pay stubs PDF downloaded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not export PDF');
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportPayStubsXlsx = async () => {
    if (!payStubs.length) return;
    setExportingXlsx(true);
    try {
      const full = await ensurePayStubsFull();
      downloadPayStubsXlsx(full, {
        employeeName: payStubExportName,
        department: employmentDepartment,
      });
      toast.success('Pay stubs spreadsheet downloaded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not export spreadsheet');
    } finally {
      setExportingXlsx(false);
    }
  };

  if (loading) return <ProfileSkeleton />;

  const workEmail =
    master?.work_email?.trim() || rate?.work_email?.trim() || bankInfo?.work_email?.trim() || null;
  const personalEmail =
    bankInfo?.personal_email?.trim() ||
    master?.personal_email?.trim() ||
    rate?.personal_email?.trim() ||
    null;

  const fullAddressDisplay =
    master?.full_address ||
    [master?.street, master?.city, master?.province, master?.postal_code]
      .filter(Boolean)
      .join(', ') ||
    null;

  const needsProfilePhoto = !displayProfilePhotoUrl && !googlePhotoUrl;
  const needsPayoutSetup = !isPayoutComplete((bankInfo as unknown as Record<string, unknown>) ?? null);
  const needsSkillSetSetup = skillSetLoaded && !hasAnySkillSetContent(skillSet);

  // Show the free-text title input when the employee opted into "Custom title…"
  // or when a previously-saved title isn't one of this department's suggestions.
  const showCustomRoleInput =
    roleTitleCustom ||
    (!!skillSet.role_title.trim() && !roleTitleOptions.includes(skillSet.role_title));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-white dark:bg-[#0a0a0a]">
      <div className="mx-auto w-full max-w-[1400px] px-5 pb-16 pt-8 sm:px-8 sm:pt-12 sm:pb-20 lg:px-10 lg:pt-14">
        {/* ─────────── Hero ─────────── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="flex items-center gap-4 sm:gap-6"
        >
          <div className="group relative shrink-0">
            {/* Pulsing ring — draws the eye to an empty placeholder so the
                employee finishes their profile. */}
            {needsProfilePhoto && (
              <span
                className="pointer-events-none absolute -inset-1 rounded-full bg-amber-400/40 motion-safe:animate-ping dark:bg-amber-400/30"
                aria-hidden
              />
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingPhoto || removingPhoto}
              className={cn(
                'relative block h-16 w-16 overflow-hidden rounded-full ring-1 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 focus-visible:ring-offset-2 sm:h-20 sm:w-20',
                needsProfilePhoto
                  ? 'ring-2 ring-amber-400 dark:ring-amber-500'
                  : 'ring-zinc-200 hover:ring-zinc-300 dark:ring-zinc-800 dark:hover:ring-zinc-700',
              )}
              aria-label={needsProfilePhoto ? 'Add a profile photo' : 'Replace photograph'}
            >
              <EmployeeAvatar
                photoUrl={displayProfilePhotoUrl}
                googlePhotoUrl={googlePhotoUrl}
                email={avatarEmail}
                initials={avatarInitials}
                className="absolute inset-0 h-full w-full text-xl sm:text-2xl"
                pixelSize={192}
              />
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                {uploadingPhoto || removingPhoto ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              aria-label="Upload profile photo"
              onChange={onAvatarFileChange}
              disabled={uploadingPhoto || removingPhoto}
            />

            {/* Persistent change-photo badge — always visible so the avatar
                reads as editable whether or not a photo is set. */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingPhoto || removingPhoto}
              className={cn(
                'absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full text-white shadow-sm ring-2 ring-white transition-colors disabled:opacity-60 dark:ring-[#0a0a0a]',
                needsProfilePhoto
                  ? 'bg-amber-500 hover:bg-amber-600'
                  : 'bg-zinc-900 hover:bg-zinc-700 dark:bg-zinc-700 dark:hover:bg-zinc-600',
              )}
              title={needsProfilePhoto ? 'Add a profile photo' : 'Change photo'}
              aria-label={needsProfilePhoto ? 'Add a profile photo' : 'Change photo'}
            >
              {uploadingPhoto ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Camera className="h-3 w-3" aria-hidden />
              )}
            </button>

            {/* Remove badge — only for a manually-uploaded photo (a Google SSO
                photo can't be deleted; readers fall back to it). */}
            {displayProfilePhotoUrl && (
              <button
                type="button"
                onClick={onAvatarRemove}
                disabled={uploadingPhoto || removingPhoto}
                className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-zinc-500 shadow-sm ring-1 ring-zinc-200 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-700 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                title="Remove photo"
                aria-label="Remove photo"
              >
                {removingPhoto ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-2.5 w-2.5" aria-hidden />
                )}
              </button>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="truncate text-[20px] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-zinc-50 sm:text-[28px]">
              {displayName}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-zinc-500 dark:text-zinc-400">
              {employmentDepartment && (
                <span className="text-zinc-700 dark:text-zinc-200">{employmentDepartment}</span>
              )}
              {employmentDepartment && master?.employee_id && (
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
              )}
              {master?.employee_id && (
                <span className="text-[12.5px] text-zinc-500 dark:text-zinc-400">
                  ID {master.employee_id}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20">
                <span className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                Active
              </span>
              {payrollLocked && (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:ring-rose-500/20">
                  <Lock className="h-2.5 w-2.5" />
                  Payroll locked
                </span>
              )}
            </div>
          </div>

        </motion.section>

        {needsProfilePhoto && (
          <div className="mt-6">
            <SetupNudge
              title="Profile photo needed"
              description="Upload a clear profile photo so teammates and managers can recognize you across rosters."
              action={
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-lg bg-amber-600 text-xs text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingPhoto}
                >
                  {uploadingPhoto ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Camera className="mr-1.5 h-3 w-3" />}
                  Upload
                </Button>
              }
            />
          </div>
        )}

        {/* ─────────── Error / missing roster banner ─────────── */}
        {error && (
          <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-[13px] dark:border-amber-900/40 dark:bg-amber-950/30">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="leading-relaxed text-amber-900 dark:text-amber-200">{cleanErrorMessage(error)}</p>
          </div>
        )}
        {!master && !error && (
          <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50/60 px-4 py-3 text-[12.5px] dark:border-zinc-800 dark:bg-zinc-900/50">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
            <p className="leading-relaxed text-zinc-600 dark:text-zinc-400">
              {rate ? (
                <>
                  No <span className="font-medium text-zinc-700 dark:text-zinc-300">global_master_list</span> entry for{' '}
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {employeeEmail}
                  </span>{' '}
                  — rates only. Identity will appear once HR adds you to the roster.
                </>
              ) : (
                <>
                  No directory or payroll record on file for{' '}
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {employeeEmail}
                  </span>
                  .
                </>
              )}
            </p>
          </div>
        )}

        {/* ─────────── Tabs ─────────── */}
        <div className="mt-8 border-b border-zinc-200 dark:border-zinc-800 sm:mt-10">
          <TabBar
            active={activeTab}
            onChange={setActiveTab}
            hasAddress={hasAnyAddress}
            needsPhoto={needsProfilePhoto}
            needsBank={needsPayoutSetup}
            needsSkillSet={needsSkillSetSetup}
            paymentEscalated={escalatePayment && needsPayoutSetup}
            resignPending={resignation?.status === 'pending'}
          />
        </div>

        {/* ─────────── Tab content ─────────── */}
        <div className="mt-6 sm:mt-8">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-4"
            >
              {activeTab === 'overview' && (
                <>
                  <Section
                    title="Personal"
                    description="From the HR master roster"
                  >
                    <Row label="Full Name" value={displayName !== '—' ? displayName : null} />
                    <Row label="Work Email" value={workEmail} mono />
                    <Row label="Personal Email" value={personalEmail} mono />
                  </Section>

                  <Section
                    title="Employment"
                    description="Authoritative source: HR roster (same as payroll)"
                  >
                    <Row
                      label="Department"
                      value={employmentDepartment ?? '—'}
                    />
                    <Row
                      label="Start Date"
                      value={formatStartDate(master?.start_date ?? null) ?? '—'}
                    />
                    <Row label="Status" value="Active" status="active" />
                  </Section>

                  {hasAnyAddress && (
                    <Section
                      title="Address"
                      description="Home address on record"
                    >
                      {fullAddressDisplay && (
                        <div className="flex items-start gap-3 border-b border-zinc-100 py-4 dark:border-zinc-800/40">
                          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-orange-50 ring-1 ring-inset ring-orange-100 dark:bg-orange-500/10 dark:ring-orange-500/20">
                            <MapPin className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                              Full Address
                            </div>
                            <p className="mt-1 text-[14px] leading-snug text-zinc-900 dark:text-zinc-100">
                              {fullAddressDisplay}
                            </p>
                          </div>
                        </div>
                      )}
                      <Row label="Street" value={master?.street ?? null} />
                      <Row label="City" value={master?.city ?? null} />
                      <Row label="Province" value={master?.province ?? null} />
                      <Row label="Postal Code" value={master?.postal_code ?? null} mono />
                    </Section>
                  )}

                </>
              )}

              {activeTab === 'compensation' && (
                <>
                  <Section
                    title="Hourly Rates"
                    description="From employee_hourly_rates · per current period"
                  >
                    <div className="grid gap-6 py-5 sm:grid-cols-2">
                      <CompactStat
                        label="Regular"
                        value={reg != null ? formatPHP(reg) : '—'}
                        hint="per hour"
                      />
                      <CompactStat
                        label="Overtime"
                        value={ot != null ? formatPHP(ot) : '—'}
                        hint="per hour"
                      />
                    </div>
                    {!reg && !ot && (
                      <p className="border-t border-zinc-100 py-3 text-[12.5px] italic text-zinc-500 dark:border-zinc-800/40 dark:text-zinc-400">
                        No hourly rates on file. Reach out to HR.
                      </p>
                    )}
                  </Section>

                  <Section
                    title="Currency"
                    description="USD-denominated bonuses are converted using this rate"
                  >
                    <div className="flex items-end justify-between gap-4 py-3">
                      <CompactStat
                        label="USD → PHP"
                        value={`₱${usdToPhpRate.toLocaleString('en-PH', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 5,
                        })}`}
                        hint="= USD 1.00"
                      />
                      <span className="text-[11px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                        Live · payroll
                      </span>
                    </div>
                  </Section>

                  <p className="px-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                    Bonuses (Perfect Attendance, Technology) are not shown here — they're applied
                    during payroll processing and surface on your dashboard.
                  </p>
                </>
              )}

              {activeTab === 'payStubs' && (
                <>
                  <Section
                    title="Pay Stubs"
                    description="Every week you've been paid. Open a week for the full statement, or export them all."
                    action={
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={payStubsLoading || exportingPdf || payStubs.length === 0}
                          onClick={handleExportPayStubsPdf}
                          className="h-8 gap-1.5 rounded-lg text-[12px]"
                          title="Download all weeks as a PDF"
                        >
                          {exportingPdf ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <FileText className="h-3 w-3" />
                          )}
                          PDF
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={payStubsLoading || exportingXlsx || payStubs.length === 0}
                          onClick={handleExportPayStubsXlsx}
                          className="h-8 gap-1.5 rounded-lg text-[12px]"
                          title="Download all weeks as an Excel spreadsheet"
                        >
                          {exportingXlsx ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <FileSpreadsheet className="h-3 w-3" />
                          )}
                          XLSX
                        </Button>
                      </div>
                    }
                  >
                    {payStubsLoading ? (
                      <div className="flex items-center justify-center py-14">
                        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                      </div>
                    ) : payStubsError ? (
                      <div className="my-4 flex items-start gap-2.5 rounded-xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-[13px] dark:border-amber-900/40 dark:bg-amber-950/30">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                        <p className="leading-relaxed text-amber-900 dark:text-amber-200">{payStubsError}</p>
                      </div>
                    ) : payStubs.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
                          <Receipt className="h-5 w-5" aria-hidden />
                        </span>
                        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">No pay stubs yet</p>
                        <p className="max-w-xs text-xs text-zinc-400 dark:text-zinc-600">
                          Your weekly pay statements appear here once your pay for a week has been sent.
                        </p>
                      </div>
                    ) : (
                      <>
                        {/* At-a-glance band */}
                        <div className="grid gap-6 border-b border-zinc-100 py-5 dark:border-zinc-800/40 sm:grid-cols-3">
                          <CompactStat
                            label="Weeks on record"
                            value={String(payStubs.length)}
                          />
                          <CompactStat
                            label="Total net pay"
                            value={formatPHP(payStubTotalPhp)}
                            hint={`≈ $${payStubTotalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`}
                          />
                          <CompactStat
                            label="Latest week"
                            value={payStubs[0]?.weekHuman || '—'}
                            hint={payStubs[0]?.payDate ? `Paid ${formatStartDate(payStubs[0].payDate)}` : undefined}
                          />
                        </div>

                        {/* Weekly statements (paginated) */}
                        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
                          {payStubPageRows.map((w) => (
                            <li
                              key={w.sourceFile}
                              className="flex items-center justify-between gap-3 py-3.5"
                            >
                              <div className="flex min-w-0 items-center gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-200/60 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20">
                                  <Receipt className="h-4 w-4" aria-hidden />
                                </span>
                                <div className="min-w-0">
                                  <p className="truncate text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">
                                    Period ending {w.weekHuman || '—'}
                                  </p>
                                  <p className="mt-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                                    {w.payDate ? `Paid ${formatStartDate(w.payDate)}` : 'Statement ready'}
                                  </p>
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-3">
                                <div className="text-right">
                                  <p className="text-[13.5px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                                    {formatPHP(w.totalPayPhp)}
                                  </p>
                                  <p className="text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                                    ${w.totalPayUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setPayStubModalFile(w.sourceFile)}
                                  className="h-8 gap-1.5 rounded-lg text-[12px]"
                                >
                                  <ArrowUpRight className="h-3 w-3" />
                                  View
                                </Button>
                              </div>
                            </li>
                          ))}
                        </ul>

                        {/* Pagination — 10 per page */}
                        {payStubPageCount > 1 && (
                          <div className="flex items-center justify-between gap-3 border-t border-zinc-100 pt-3.5 dark:border-zinc-800/40">
                            <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                              Showing{' '}
                              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                                {payStubPageSafe * PAY_STUBS_PAGE_SIZE + 1}–
                                {Math.min((payStubPageSafe + 1) * PAY_STUBS_PAGE_SIZE, payStubs.length)}
                              </span>{' '}
                              of {payStubs.length}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={payStubPageSafe <= 0}
                                onClick={() => setPayStubPage((p) => Math.max(0, p - 1))}
                                className="h-8 gap-1 rounded-lg text-[12px]"
                              >
                                <ChevronLeft className="h-3.5 w-3.5" />
                                Prev
                              </Button>
                              <span className="px-1 text-[11.5px] tabular-nums text-zinc-500 dark:text-zinc-400">
                                {payStubPageSafe + 1} / {payStubPageCount}
                              </span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={payStubPageSafe >= payStubPageCount - 1}
                                onClick={() =>
                                  setPayStubPage((p) => Math.min(payStubPageCount - 1, p + 1))
                                }
                                className="h-8 gap-1 rounded-lg text-[12px]"
                              >
                                Next
                                <ChevronRight className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </Section>

                  {payStubs.length > 0 && (
                    <p className="px-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      The PDF and XLSX exports cover all {payStubs.length}{' '}
                      {payStubs.length === 1 ? 'week' : 'weeks'} with the full earnings breakdown.
                      {' '}These reflect the pay dispatched for each week.
                    </p>
                  )}
                </>
              )}

              {activeTab === 'payment' && (
                <>
                  <Section
                    title="Disbursement"
                    description="How and where you get paid"
                    action={
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {payoutSavedAt && (
                          <span className="hidden items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 sm:flex">
                            <CheckCircle className="h-3 w-3" />
                            Saved {payoutSavedAt}
                          </span>
                        )}
                        {!payrollLocked && bankInfo && !payoutEditing && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 rounded-lg text-[12px]"
                            onClick={() => setPayoutEditing(true)}
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </Button>
                        )}
                        {!payrollLocked && payoutEditing && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 rounded-lg text-[12px]"
                            disabled={payoutSaving}
                            onClick={resetPayoutDraft}
                          >
                            <X className="h-3 w-3" />
                            Cancel
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          disabled={payoutSaving || payrollLocked || !payoutEditing}
                          onClick={savePaymentDetails}
                          className="h-8 gap-1.5 rounded-lg bg-orange-500 text-[12px] text-white hover:bg-orange-600 disabled:opacity-50 dark:bg-orange-500 dark:hover:bg-orange-400"
                        >
                          {payoutSaving ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Save className="h-3 w-3" />
                          )}
                          Save
                        </Button>
                      </div>
                    }
                  >
                    <div className="space-y-5 py-4">
                      {payrollLocked && (
                        <div className="flex items-start gap-2.5 rounded-xl border border-rose-200/80 bg-rose-50/70 px-4 py-3 text-[12.5px] dark:border-rose-900/40 dark:bg-rose-950/30">
                          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                          <p className="leading-relaxed text-rose-900 dark:text-rose-200">
                            Payroll processing is in progress. Disbursement details are read-only
                            until accounting finishes the run.
                          </p>
                        </div>
                      )}
                      {escalatePayment && needsPayoutSetup && !payrollLocked && (
                        <div className="flex items-start gap-2.5 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 dark:border-rose-500/40 dark:bg-rose-950/30">
                          <span className="relative mt-0.5 flex h-4 w-4 shrink-0">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/50" />
                            <Bell className="relative h-4 w-4 text-rose-600 dark:text-rose-400" />
                          </span>
                          <div className="min-w-0">
                            <p className="text-[13px] font-semibold text-rose-800 dark:text-rose-200">Payroll needs your bank details</p>
                            <p className="mt-0.5 text-[12px] leading-relaxed text-rose-700 dark:text-rose-300">
                              Accounting asked you to add your payout details so they can send your pay. Please complete the fields below.
                            </p>
                          </div>
                        </div>
                      )}
                      {needsPayoutSetup && !payrollLocked && (
                        <SetupNudge
                          title="Payment details needed"
                          description="Add your preferred disbursement channel and required account details so payroll can route your pay."
                          action={
                            !payoutEditing ? (
                              <Button
                                type="button"
                                size="sm"
                                className="h-8 rounded-lg bg-amber-600 text-xs text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
                                onClick={() => setPayoutEditing(true)}
                              >
                                Add details
                              </Button>
                            ) : undefined
                          }
                        />
                      )}
                      {!bankInfo && !payrollLocked && (
                        <p className="text-[12.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                          Choose a payment channel and complete the corresponding fields. Your first
                          submission creates a payroll routing record linked to your work email.
                        </p>
                      )}
                      <PreferredPaymentMethodRadios
                        value={preferredProcessor}
                        onChange={setPreferredProcessor}
                        disabled={payoutReadOnly}
                      />
                      {preferredProcessor ? (
                        <PayoutDetailsFields
                          processor={preferredProcessor}
                          payout={payout}
                          setPayout={setPayout}
                          disabled={payoutReadOnly}
                        />
                      ) : null}
                    </div>
                  </Section>

                  <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/60">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[13px] font-medium text-zinc-900 dark:text-white">
                            Bank Preferred
                          </p>
                          {pendingBankPreferred && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                              <Clock className="h-3 w-3" />
                              Pending approval: {bankPreferredLabelForProcessor(pendingBankPreferred)}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                          {pendingBankPreferred
                            ? 'Your change is awaiting Accounting approval. Until then, your current setting below stays active.'
                            : isWiresPreferred(bankPreferred)
                              ? 'You are set to WIRES — salary is sent by bank wire, so Kolan/HiGlobe are not available. Changes need Accounting approval.'
                              : 'The bank Payment Dispatch routes your salary through. Changes need Accounting approval before they take effect. Independent of your disbursement channel above.'}
                        </p>
                      </div>
                      <SmoothSelect
                        aria-label="Bank Preferred"
                        value={bankPreferredLabelForProcessor(bankPreferred)}
                        onChange={(label) => {
                          setBankPreferred(processorForBankPreferredLabel(label) ?? '');
                        }}
                        disabled={payoutReadOnly}
                        triggerClassName="w-full sm:w-48"
                        options={[
                          ...(bankPreferredLabelForProcessor(bankPreferred)
                            ? []
                            : [{ value: '', label: 'Select…' }]),
                          ...BANK_PREFERRED_OPTIONS
                            // WIRES lock: a WIRES employee can only stay WIRES,
                            // so never offer hurupay/higlobe to them.
                            .filter((o) =>
                              isWiresPreferred(bankPreferred) ? isWiresPreferred(o.id) : true,
                            )
                            .map((o) => ({
                              value: o.label,
                              label: o.label,
                            })),
                        ]}
                      />
                    </div>
                  </div>

                  {preferredProcessor && (
                    <div className="flex items-center gap-2 px-1 text-[12px] text-zinc-500 dark:text-zinc-400">
                      <span>
                        Selected channel:{' '}
                        <span className="text-zinc-700 dark:text-zinc-200">
                          {PROCESSOR_OPTIONS.find((p) => p.id === preferredProcessor)?.label}
                        </span>
                      </span>
                      <ArrowUpRight className="h-3 w-3 text-zinc-400" />
                    </div>
                  )}
                </>
              )}

              {activeTab === 'skillsets' && (
                <>
                  <Section
                    title="Skill Sets"
                    description="Visible to your teammates as read-only on the My Team page"
                    action={
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {skillSetSavedAt && !skillSetDirty && (
                          <span className="hidden items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 sm:flex">
                            <CheckCircle className="h-3 w-3" />
                            Saved {skillSetSavedAt}
                          </span>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          disabled={skillSetSaving || skillSetLoading || !skillSetDirty}
                          onClick={saveSkillSet}
                          className="h-8 gap-1.5 rounded-lg bg-orange-500 text-[12px] text-white hover:bg-orange-600 disabled:opacity-50 dark:bg-orange-500 dark:hover:bg-orange-400"
                        >
                          {skillSetSaving ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Save className="h-3 w-3" />
                          )}
                          Save
                        </Button>
                      </div>
                    }
                  >
                    {skillSetLoading ? (
                      <div className="flex items-center justify-center py-10">
                        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                      </div>
                    ) : (
                      <div className="space-y-5 py-4">
                        {needsSkillSetSetup && (
                          <SetupNudge
                            title="Skill Sets needed"
                            description="Add your role, current focus, skills, or strengths so teammates can understand how to collaborate with you."
                          />
                        )}
                        <div className="block">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                              Role / Title
                            </span>
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                              {employmentDepartment
                                ? `${employmentDepartment} roles · shown on your My Team card`
                                : 'Shown on your My Team card'}
                            </span>
                          </div>
                          <SmoothSelect
                            aria-label="Role / Title"
                            value={showCustomRoleInput ? '__custom__' : skillSet.role_title}
                            onChange={(v) => {
                              if (v === '__custom__') {
                                setRoleTitleCustom(true);
                                return;
                              }
                              setRoleTitleCustom(false);
                              setSkillSet((s) => ({ ...s, role_title: v }));
                            }}
                            triggerClassName="mt-1.5 w-full"
                            options={[
                              { value: '', label: 'Select a title...' },
                              ...roleTitleOptions.map((title) => ({ value: title, label: title })),
                              { value: '__custom__', label: '✏️  Custom title…' },
                            ]}
                          />
                          {showCustomRoleInput && (
                            <input
                              type="text"
                              value={skillSet.role_title}
                              onChange={(e) =>
                                setSkillSet((s) => ({ ...s, role_title: e.target.value }))
                              }
                              placeholder="Type your own title…"
                              maxLength={80}
                              className="mt-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13.5px] text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-100 dark:focus:border-orange-500/40 dark:focus:ring-orange-500/20"
                            />
                          )}
                        </div>
                        <ProjectsField
                          projects={skillSet.projects}
                          current={skillSet.current_projects}
                          onChange={(projects, current_projects) =>
                            setSkillSet((s) => ({ ...s, projects, current_projects }))
                          }
                        />
                        <SkillSetField
                          label="Skills"
                          hint="Languages, tools, frameworks, methodologies"
                          value={skillSet.skills}
                          onChange={(v) => setSkillSet((s) => ({ ...s, skills: v }))}
                          placeholder="e.g. TypeScript, React, Postgres, Figma, copywriting"
                          rows={4}
                        />
                        <SkillSetField
                          label="Strengths"
                          hint="What you bring to the team"
                          value={skillSet.strengths}
                          onChange={(v) => setSkillSet((s) => ({ ...s, strengths: v }))}
                          placeholder="e.g. Calm under pressure, fast feedback loops, customer empathy"
                          rows={3}
                        />
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
                              Member Notes
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                              <Lock className="h-2.5 w-2.5" aria-hidden />
                              Manager only
                            </span>
                          </div>
                          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-500">
                            Added by your manager — visible to you and your team.
                          </p>
                          {skillSet.member_notes?.trim() ? (
                            <p className="whitespace-pre-wrap break-words rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-[13px] leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-200">
                              {skillSet.member_notes}
                            </p>
                          ) : (
                            <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-2.5 text-[12.5px] italic text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-600">
                              No notes from your manager yet.
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </Section>
                </>
              )}

              {activeTab === 'reports' && (
                <>
                  {commendationsLoading ? (
                    <div className="flex items-center justify-center py-20">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
                    </div>
                  ) : commendations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-zinc-200/80 bg-white py-20 text-center dark:border-zinc-800/80 dark:bg-zinc-950/40">
                      <span className="text-3xl" style={{ filter: 'hue-rotate(120deg)' }} aria-hidden>🚩</span>
                      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">No commendations yet</p>
                      <p className="max-w-xs text-xs text-zinc-400 dark:text-zinc-600">
                        When your manager shares a commendation with you it will appear here.
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 pt-2">
                      {commendations.map((c) => (
                        <div key={c.id} className="flex items-start gap-3 rounded-2xl border border-zinc-200/80 bg-white px-5 py-4 dark:border-zinc-800/80 dark:bg-zinc-950/40">
                          <span
                            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-base ring-1 ring-emerald-200/60 dark:bg-emerald-900/20 dark:ring-emerald-700/30"
                            style={{ filter: 'hue-rotate(120deg)' }}
                            aria-hidden
                          >
                            🚩
                          </span>
                          <div className="min-w-0 flex-1">
                            {c.note ? (
                              <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">&ldquo;{c.note}&rdquo;</p>
                            ) : (
                              <p className="text-sm italic text-zinc-400 dark:text-zinc-600">No note left.</p>
                            )}
                            <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-600">
                              From <span className="font-medium text-zinc-500 dark:text-zinc-400">{c.awarded_by}</span>
                              {' · '}
                              {new Date(c.awarded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {activeTab === 'requestDocuments' && (
                <RequestDocumentsTab
                  employeeEmail={norm}
                  employeeName={displayName && displayName !== '—' ? displayName : null}
                  department={employmentDepartment || null}
                />
              )}

              {activeTab === 'resign' && (
                <>
                  {resignation?.status === 'pending' ? (
                    <Section
                      title="Resignation submitted"
                      description="Awaiting your department manager's approval"
                    >
                      <div className="space-y-4 py-4">
                        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200/80 bg-amber-50/70 px-4 py-3 text-[12.5px] dark:border-amber-900/40 dark:bg-amber-950/30">
                          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                          <div className="min-w-0">
                            <p className="font-semibold text-amber-950 dark:text-amber-100">
                              Pending manager approval
                            </p>
                            <p className="mt-0.5 leading-relaxed text-amber-900/80 dark:text-amber-100/75">
                              Once your manager approves, HR will handle your offboarding. You can
                              withdraw this request any time before it's approved.
                            </p>
                          </div>
                        </div>
                        <Row
                          label="Effective date"
                          value={formatStartDate(resignation.effective_date) ?? resignation.effective_date}
                        />
                        {resignation.manager_email && (
                          <Row label="Awaiting" value={resignation.manager_email} mono />
                        )}
                        {resignation.message && (
                          <div className="border-b border-zinc-100 py-3.5 dark:border-zinc-800/40">
                            <div className="text-[12px] font-medium text-zinc-500 dark:text-zinc-400">
                              Your message
                            </div>
                            <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-zinc-900 dark:text-zinc-100">
                              {resignation.message}
                            </p>
                          </div>
                        )}
                        <div className="flex justify-end pt-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={resignWithdrawing}
                            onClick={withdrawResignation}
                            className="h-9 gap-1.5 rounded-lg border-zinc-300 text-zinc-700 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-rose-800 dark:hover:bg-rose-950/30 dark:hover:text-rose-300"
                          >
                            {resignWithdrawing ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <X className="h-3.5 w-3.5" />
                            )}
                            Withdraw request
                          </Button>
                        </div>
                      </div>
                    </Section>
                  ) : resignation?.status === 'approved' ? (
                    <Section
                      title="Resignation approved"
                      description="Your manager approved your resignation"
                    >
                      <div className="space-y-4 py-4">
                        <div className="flex items-start gap-2.5 rounded-xl border border-rose-200/80 bg-rose-50/70 px-4 py-3 text-[12.5px] dark:border-rose-900/40 dark:bg-rose-950/30">
                          <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                          <div className="min-w-0">
                            <p className="font-semibold text-rose-950 dark:text-rose-100">
                              Approved — HR will process your offboarding
                            </p>
                            <p className="mt-0.5 leading-relaxed text-rose-900/80 dark:text-rose-100/75">
                              Your resignation is now with HR. Reach out to them for any questions
                              about your final pay and handover.
                            </p>
                          </div>
                        </div>
                        <Row
                          label="Effective date"
                          value={formatStartDate(resignation.effective_date) ?? resignation.effective_date}
                        />
                        {resignation.approver_email && (
                          <Row label="Approved by" value={resignation.approver_email} mono />
                        )}
                        {resignation.message && (
                          <div className="py-3.5">
                            <div className="text-[12px] font-medium text-zinc-500 dark:text-zinc-400">
                              Your message
                            </div>
                            <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-zinc-900 dark:text-zinc-100">
                              {resignation.message}
                            </p>
                          </div>
                        )}
                      </div>
                    </Section>
                  ) : (
                    <>
                      {resignation?.status === 'rejected' && (
                        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-rose-200/80 bg-rose-50/70 px-4 py-3 text-[12.5px] dark:border-rose-900/40 dark:bg-rose-950/30">
                          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                          <div className="min-w-0">
                            <p className="font-semibold text-rose-950 dark:text-rose-100">
                              A previous resignation was declined
                            </p>
                            {resignation.approver_note && (
                              <p className="mt-0.5 leading-relaxed text-rose-900/80 dark:text-rose-100/75">
                                Manager's note: &ldquo;{resignation.approver_note}&rdquo;
                              </p>
                            )}
                            <p className="mt-0.5 leading-relaxed text-rose-900/70 dark:text-rose-100/65">
                              You can submit a new resignation below.
                            </p>
                          </div>
                        </div>
                      )}
                      <Section
                        title="Resign"
                        description="Notify your department manager that you intend to resign"
                      >
                        <div className="space-y-5 py-4">
                          <div className="flex items-start gap-2.5 rounded-xl border border-rose-200/80 bg-rose-50/60 px-4 py-3 text-[12.5px] dark:border-rose-900/40 dark:bg-rose-950/20">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                            <p className="leading-relaxed text-rose-900/90 dark:text-rose-100/80">
                              Submitting sends a resignation request to your
                              {employmentDepartment ? ` ${employmentDepartment}` : ''} manager. Once
                              they approve it, HR begins your offboarding. You choose your effective
                              (last working) date.
                            </p>
                          </div>

                          <label className="block">
                            <div className="mb-1.5 text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                              Effective date
                            </div>
                            <DatePicker
                              value={resignEffectiveDate}
                              min={new Date().toISOString().slice(0, 10)}
                              onChange={setResignEffectiveDate}
                              containerClassName="sm:max-w-[16rem]"
                              className="dark:bg-zinc-950/60 focus-visible:border-rose-300 focus-visible:ring-rose-200 dark:focus-visible:border-rose-500/40 dark:focus-visible:ring-rose-500/20"
                            />
                          </label>

                          <label className="block">
                            <div className="mb-1.5 text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                              Message to your manager{' '}
                              <span className="font-normal text-zinc-400 dark:text-zinc-500">(optional)</span>
                            </div>
                            <textarea
                              value={resignMessage}
                              onChange={(e) => setResignMessage(e.target.value)}
                              rows={4}
                              maxLength={2000}
                              placeholder="Share your reason for leaving, a note of thanks, or anything your manager should know."
                              className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13.5px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-rose-300 focus:outline-none focus:ring-1 focus:ring-rose-200 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-100 dark:focus:border-rose-500/40 dark:focus:ring-rose-500/20"
                            />
                          </label>

                          <Button
                            type="button"
                            onClick={() => setResignConfirmOpen(true)}
                            disabled={!resignEffectiveDate}
                            className="h-12 w-full gap-2 rounded-xl bg-red-600 text-base font-semibold text-white shadow-sm shadow-red-600/20 transition-colors hover:bg-red-700 disabled:opacity-50 dark:bg-red-600 dark:hover:bg-red-500"
                          >
                            <DoorOpen className="h-5 w-5" />
                            Resign
                          </Button>
                        </div>
                      </Section>
                    </>
                  )}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Pay statement modal — opens one paid week (session-scoped fetch inside). */}
      <PayStubModal
        open={payStubModalFile !== null}
        sourceFile={payStubModalFile}
        onClose={() => setPayStubModalFile(null)}
      />

      {/* Resignation confirmation modal */}
      {resignConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/60">
                <DoorOpen className="h-4 w-4 text-red-600 dark:text-red-400" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-zinc-900 dark:text-white">Submit your resignation?</h3>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  This notifies your{employmentDepartment ? ` ${employmentDepartment}` : ''} manager. After
                  they approve it, HR will begin your offboarding.
                </p>
              </div>
            </div>
            <div className="space-y-2 px-5 py-4 text-[13px]">
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500 dark:text-zinc-400">Effective date</span>
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {formatStartDate(resignEffectiveDate) ?? resignEffectiveDate}
                </span>
              </div>
              {resignMessage.trim() && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
                  <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                    {resignMessage.trim()}
                  </p>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resignSubmitting}
                onClick={() => setResignConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={resignSubmitting}
                onClick={submitResignation}
                className="gap-1.5 bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500"
              >
                {resignSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Submit resignation
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
