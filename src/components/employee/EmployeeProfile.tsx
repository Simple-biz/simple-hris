'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Download,
} from 'lucide-react';
import { motion, AnimatePresence, LayoutGroup, useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { DatePicker } from '@/components/ui/date-picker';
import EmployeeAvatar from './EmployeeAvatar';
import EmployeeIdCard from './EmployeeIdCard';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import {
  PROFILE_SECTIONS,
  profileSectionDomId,
  profileSectionTabDomId,
  type ProfileTarget,
  type SectionId,
  type TabId,
} from '@/lib/employee/profile-tabs';
import {
  resolveCompensationSection,
  sectionSlideDirection,
} from '@/lib/employee/compensation-sections';
import { CompensationSections } from './CompensationSections';
import { EMPLOYEE_CACHE_KEYS } from '@/lib/employee/tab-cache';
import { buildIdCard } from '@/lib/employee/id-card';
import { downloadIdCardPng, IdCardRenderError } from '@/lib/employee/id-card-render';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { formatDateOnly } from '@/lib/date-only';
import { useEmployeeCachedState } from '@/hooks/useEmployeeCachedState';
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

/**
 * The Compensation tab's section swap (Rates | Pay Stubs | Payout).
 *
 * `custom` carries the slide direction from `sectionSlideDirection()` — or `0`
 * when the viewer asked for reduced motion, which collapses the slide to a plain
 * cross-fade without needing a second set of variants to fall out of sync with
 * this one. Declared at module scope so it is not rebuilt per render.
 */
const COMPENSATION_PANE_VARIANTS = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 14 }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: direction * -14 }),
};
import RequestDocumentsTab from '@/components/employee/RequestDocumentsTab';
import {
  PROCESSOR_OPTIONS,
  type ProcessorId,
  isProcessorId,
  bankPreferredLabelForProcessor,
  processorForBankPreferredLabel,
  selectableBankPreferredOptions,
  walletFromReceiving,
  mirroredBankPreferredFor,
  walletRailEffectiveFromPayload,
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
  /**
   * A resolved deep link from a nudge (dashboard completion card, shell
   * profile-setup navigation). ONE prop, not three: it carries the tab, the
   * optional section within it, and a nonce that changes on every fire, so the
   * same nudge pressed twice still moves the pane even though no visited tab
   * ever unmounts.
   */
  focusTarget?: ProfileTarget;
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

/**
 * Alias, not a second implementation. This used to build `new Date(raw)`
 * directly, which parses a bare `YYYY-MM-DD` as UTC midnight — a day early for
 * every viewer west of UTC. Manila (UTC+8) never saw this; it was every
 * US-side viewer reading the same roster. `formatDateOnly` (`@/lib/date-only`)
 * is the ONE renderer for a date-only column, already used by the ID card;
 * every call site below (Start Date row, pay-stub dates, resignation
 * effective dates) now agrees with it byte for byte.
 */
const formatStartDate = formatDateOnly;

function matchesEmployeeEmail(emp: EmployeeRow, n: string): boolean {
  const we = normEmail(emp.work_email ?? '');
  const pe = normEmail(emp.personal_email ?? '');
  return we === n || pe === n;
}

/* ───────── Visual primitives ───────── */

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
  needsPhoto,
  needsBank,
  needsSkillSet,
  paymentEscalated = false,
  resignPending = false,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
  needsPhoto: boolean;
  needsBank: boolean;
  needsSkillSet: boolean;
  /** Escalate the Payment tab's ping to rose (accounting requested bank info). */
  paymentEscalated?: boolean;
  /** A resignation request is awaiting the manager — show a rose dot on Resign. */
  resignPending?: boolean;
}) {
  const tabs: { id: TabId; label: string; sub: string }[] = [
    { id: 'overview', label: 'Overview', sub: 'Identity, employment & ID' },
    { id: 'compensation', label: 'Compensation', sub: 'Rates, stubs & payout' },
    { id: 'skills', label: 'Skill Sets', sub: 'Skills & commendations' },
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
            (t.id === 'compensation' && needsBank) ||
            (t.id === 'skills' && needsSkillSet) ||
            (t.id === 'resign' && resignPending);
          const escalated =
            (t.id === 'compensation' && paymentEscalated) || (t.id === 'resign' && resignPending);
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
  focusTarget,
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

  const [error, setError] = useState<string | null>(null);
  // Identity + rate survive a reload (sessionStorage, identity-stamped — see
  // docs/features/employee-dashboard-cache.md). A cached value only SEEDS the
  // first paint; the fetch effect below still runs unconditionally and
  // overwrites it. The bank/payout row is deliberately NOT cached — account
  // numbers stay out of storage — so the Payment pane keeps its own loaded flag
  // and shows a skeleton until the live row lands.
  const [master, setMaster] = useEmployeeCachedState<EmployeeRow | null>(
    EMPLOYEE_CACHE_KEYS.profileMaster,
    null,
  );
  const [rate, setRate] = useEmployeeCachedState<EmployeeHourlyRateRow | null>(
    EMPLOYEE_CACHE_KEYS.profileRate,
    null,
  );
  const [bankInfo, setBankInfo] = useState<EmployeeIdRow | null>(null);
  const [bankInfoLoaded, setBankInfoLoaded] = useState(false);
  // Whole-page skeleton ONLY while nothing is known yet. A cached identity paints
  // at once and refreshes in place when the live fetch lands.
  const [loading, setLoading] = useState(() => master === null);
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
  // The EFFECTIVE send-from rail across all three routing tiers, resolved
  // SERVER-side (`/api/employee-ids?email=` → resolveWalletRailLock). Used as
  // the dropdown's DISPLAY DEFAULT for the 1,796 people whose tier 1 is NULL —
  // "defaulted to what they are" (Kane, 2026-08-31): a tier-2 Kolan payee sees
  // Kolan, not an empty "Select…".
  const [walletRailEffective, setWalletRailEffective] = useState<ProcessorId | null>(null);
  const [payout, setPayout] = useState<PayoutFields>(() => ({ ...emptyPayout }));
  const [payoutSaving, setPayoutSaving] = useState(false);
  const [payoutSavedAt, setPayoutSavedAt] = useState<string | null>(null);
  const [payoutEditing, setPayoutEditing] = useState(false);

  const [activeTab, setActiveTab] = useState<TabId>('overview');
  // The section a deep link asked for, consumed by the Compensation and Skill
  // Sets panes. Declared HERE, with the rest of the state and ABOVE the
  // whole-page ProfileSkeleton bail-out further down: a hook below that early
  // return is skipped on the cold loading render and called on the loaded one,
  // which throws and blanks the route. profile-hook-order.test.ts guards it —
  // and scans SOURCE, so do not spell that early return out literally nearby.
  const [pendingSection, setPendingSection] = useState<SectionId | null>(null);

  // ── The Compensation tab's inner section: Rates | Pay Stubs | Payout ──
  //
  // Declared HERE — in the state block, above the ProfileSkeleton bail-out and
  // OUTSIDE the `activeTab === 'compensation'` render branch — for two
  // independent reasons, either one of which is fatal on its own:
  //
  //  1. The lazy pay-stub fetch below reads `activeCompensationSection` to
  //     decide whether to fire. A const declared inside a render branch is not
  //     in scope there, and the only way to "fix" that from inside the branch is
  //     to re-gate the fetch on the TAB — which is the bug this task exists to
  //     close (see the effect's own comment).
  //  2. A hook declared in a render branch, or anywhere below the bail-out, is
  //     skipped on the cold loading render and called on the loaded one. React
  //     throws, and with no error boundary anywhere the whole /employee route
  //     blanks. Same reason as `pendingSection` above; same guard covers it.
  const [storedSection, setStoredSection] = useState<SectionId | null>(null);
  // A deep link aimed at ANOTHER tab's section (skillSets, commendations) is not
  // this pane's business. Filtered out here rather than handed to
  // `resolveCompensationSection`, which would see an unavailable section and
  // fall back to 'rates' — throwing away the employee's own Pay Stubs selection
  // for as long as the foreign target stayed pending.
  const pendingCompensationSection =
    pendingSection && PROFILE_SECTIONS.compensation.includes(pendingSection)
      ? pendingSection
      : null;
  // DERIVED on every render, never stored as the truth: a stored section can
  // outlive the condition that offered it, so `resolveCompensationSection`
  // re-checks it against what this tab actually has.
  const activeCompensationSection = resolveCompensationSection(
    pendingCompensationSection ?? storedSection,
    PROFILE_SECTIONS.compensation,
  );
  // Slide direction for the section swap, computed from the CANONICAL order.
  // A ref, not state: the direction is a presentation detail of a transition
  // that has already been decided, so recording it must not schedule another
  // render. The write is idempotent — a re-render with the same active section
  // leaves both refs untouched — so a StrictMode double-invoke cannot flip it.
  const previousCompensationSection = useRef<SectionId>(activeCompensationSection);
  const compensationSlideRef = useRef<1 | -1>(1);
  if (previousCompensationSection.current !== activeCompensationSection) {
    compensationSlideRef.current = sectionSlideDirection(
      previousCompensationSection.current,
      activeCompensationSection,
    );
    previousCompensationSection.current = activeCompensationSection;
  }
  // Named to avoid shadowing the invocation-time `reduceMotion` the two
  // callback refs below read straight off matchMedia (they run outside render).
  const prefersReducedMotion = useReducedMotion();
  const compensationSlide = prefersReducedMotion ? 0 : compensationSlideRef.current;

  // ONE derived visibility, read by BOTH the payout skeleton and the payout
  // form, so the matched pair cannot drift: re-pointing one and not the other
  // stacks two Disbursement cards or renders none. It deliberately does NOT
  // gate on `bankInfoLoaded` — that is the payout section's OWN readiness, and
  // folding it in here would make Rates and Pay Stubs, which paint from the
  // session cache instantly, wait on the one uncacheable call in the wave.
  const payoutPaneVisible =
    activeTab === 'compensation' && activeCompensationSection === 'payout';

  // Keyed on the NONCE, not the value. No visited tab ever unmounts, so firing
  // the same nudge twice would otherwise set state to the value it already
  // holds, React would bail out of the re-render, and the employee would not move.
  useEffect(() => {
    if (!focusTarget) return;
    setActiveTab(focusTarget.tab);
    if (focusTarget.section) setPendingSection(focusTarget.section);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget?.nonce]);

  // Scrolls the pending section into view — as a REF, not an effect, and
  // declared here (not "near the pane") for the same reason as pendingSection
  // itself, see the comment above it.
  //
  // A nonce/pendingSection-keyed effect provably cannot do this safely: the
  // tab content is `<AnimatePresence mode="wait"><motion.div key={activeTab}>`,
  // and with mode="wait" ONLY the exiting pane renders until its ~220ms exit
  // finishes — the incoming pane's anchors do not exist in the DOM yet. The
  // same gap opens on a cold mount, where `ProfileSkeleton` stands in for
  // every pane until `loading` flips false. An effect fires on that gap,
  // finds no element, and — if it clears pendingSection unconditionally, as
  // an earlier draft of this did — throws the target away with no anchor to
  // retry against once the real pane mounts 220ms later. The first nudge
  // from any other tab would never scroll.
  //
  // A callback ref sidesteps the gap entirely: React only invokes it with a
  // real node once that node actually mounts, so it cannot fire into empty
  // air. Attached to BOTH anchors below, it also re-fires when pendingSection
  // changes while an anchor is already mounted (a changed useCallback identity
  // makes React detach and reattach the ref), which is what makes the same
  // nudge fired twice from an already-open pane move it again. It clears
  // pendingSection ONLY on an actual match — never speculatively — so a
  // section meant for another pane (e.g. Compensation's 'payout') is left
  // untouched for that pane's own copy of this ref to consume.
  //
  // `prefers-reduced-motion` follows the house pattern at
  // EmployeeDashboard.tsx's `revealPabCalendar`.
  const scrollToSectionAnchor = useCallback((node: HTMLDivElement | null) => {
    if (!node || !pendingSection) return;
    if (!PROFILE_SECTIONS.skills.includes(pendingSection)) return;
    if (node.id !== profileSectionDomId(pendingSection)) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    setPendingSection(null);
  }, [pendingSection]);

  // The Compensation pane's own copy of the ref above — same mechanism, same
  // reasons (the anchor does not exist during the outgoing pane's 0.22s exit,
  // so an effect would fire into empty air and destroy the pending target),
  // scoped to ITS OWN sections so the two panes cannot consume each other's.
  //
  // One thing this copy must do that the Skills one does not: HAND THE SECTION
  // OVER before clearing. `activeCompensationSection` is derived from
  // `pendingCompensationSection ?? storedSection`, so clearing `pendingSection`
  // on its own would snap a bank nudge's Payout pane straight back to Rates the
  // instant it finished scrolling. Writing `storedSection` first makes the two
  // derivations agree across the clear, so nothing moves.
  const scrollToCompensationAnchor = useCallback((node: HTMLDivElement | null) => {
    if (!node || !pendingCompensationSection) return;
    if (node.id !== profileSectionDomId(pendingCompensationSection)) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    setStoredSection(pendingCompensationSection);
    setPendingSection(null);
  }, [pendingCompensationSection]);

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
  // Cached across reloads (RAW summary rows — plain JSON); the fetch below still
  // runs on the first open and overwrites them. Paints, never decides.
  const [payStubs, setPayStubs] = useEmployeeCachedState<PayStubSummaryRow[]>(
    EMPLOYEE_CACHE_KEYS.paystubSummary,
    [],
  );
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
  // The department the exported PDF/XLSX header names: the roster's CURRENT
  // one, straight off the `?all=1` response, NOT any week's frozen
  // `view.department`. Filled by `ensurePayStubsFull` alongside the weeks.
  const exportDepartmentRef = useRef<string | null>(null);

  useEffect(() => {
    // Gated on the SECTION, not the tab. Pay Stubs is one of three sections
    // inside Compensation now, so gating on the tab would fire this for every
    // employee who opens Compensation to read a rate or check a bank detail —
    // and under SHOW_UNPAID_STAGED_PAYSTUBS that route runs per-week recovery,
    // so the wasted call is expensive, not merely wasted.
    //
    // The `activeTab` half is a second lock, not the gate: `storedSection` is
    // remembered across tab switches, so a viewer who opened Pay Stubs and then
    // left for another tab still has `activeCompensationSection === 'payStubs'`.
    // The request ref already covers that case; this keeps the invariant true by
    // construction ("only ever fetched while the pane is on screen") instead of
    // by relying on a ref that a later edit could reset.
    if (activeTab !== 'compensation') return;
    if (activeCompensationSection !== 'payStubs' || payStubsRequestedRef.current) return;
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
  }, [activeTab, activeCompensationSection]);

  // Reset the pager when the LIST ITSELF changes — the cached rows being
  // replaced by live ones, a refetch that adds this week's statement, a shorter
  // list after a correction. The render below only CLAMPS the page into range,
  // which is not the same thing: a viewer left on page 4 of a list that just
  // became two pages long lands on page 2 looking at weeks they never asked for,
  // and the clamp cannot tell that from a deliberate page choice.
  //
  // Keyed on the identity of the list (its ordered source files), not its
  // length: replacing ten weeks with ten different weeks is a new list too.
  const payStubListIdentity = JSON.stringify(payStubs.map((w) => w.sourceFile));
  useEffect(() => {
    setPayStubPage(0);
  }, [payStubListIdentity]);

  /** Fetch (once) + cache the full statements for the all-weeks PDF/XLSX export. */
  const ensurePayStubsFull = async (): Promise<PayStubWeek[]> => {
    if (payStubsFullRef.current) return payStubsFullRef.current;
    const r = await fetch('/api/employee/paystub?all=1', { cache: 'no-store' });
    const json = (await r.json()) as {
      stubs?: PayStubWeek[];
      currentDepartment?: string | null;
      error?: string;
    };
    if (!r.ok) throw new Error(json.error || 'Could not load your pay stubs.');
    const stubs = json.stubs ?? [];
    payStubsFullRef.current = stubs;
    // The department the export header names. Taken from the SAME response as
    // the weeks so the PDF, the XLSX and the single-week download all resolve
    // it one way (the route's master-record read) instead of three.
    exportDepartmentRef.current = json.currentDepartment ?? null;
    return stubs;
  };

  // Skill Sets - editable by the employee, read-only on the My Team page.
  // Cached across reloads (normalised plain-JSON fields); the fetch effect below
  // still runs unconditionally and overwrites it.
  const [skillSet, setSkillSet] = useEmployeeCachedState<SkillSetFields>(
    EMPLOYEE_CACHE_KEYS.profileSkillSet,
    EMPTY_SKILL_SET,
  );
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
      try {
        // Server-side `?email=` filter: each route returns just this employee's
        // row instead of the full table. Same pattern documented in
        // memory/project_employee_portal_filtered_endpoints.md.
        //
        // ONE wave. None of these six reads depends on another's result — the
        // master-record and bank-preferred calls used to wait for the first four
        // and then for each other (three serial hops behind one skeleton).
        // The two optional ones resolve to `null` on a network failure so a
        // missing badge or address supplement can never fail the whole profile.
        const emailParam = `email=${encodeURIComponent(employeeEmail)}`;
        const optional = (url: string) => fetch(url, { cache: 'no-store' }).catch(() => null);
        const [empRes, rateRes, idsRes, fxRes, mrRes, bpRes] = await Promise.all([
          fetch(`/api/employees?${emailParam}`, { cache: 'no-store' }),
          fetch(`/api/employee-hourly-rates?${emailParam}`, { cache: 'no-store' }),
          fetch(`/api/employee-ids?${emailParam}`, { cache: 'no-store' }),
          fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
          optional(`/api/employee-master-record?${emailParam}`),
          optional(`/api/bank-preferred-requests?${emailParam}`),
        ]);

        const empJson = (await empRes.json()) as { employees?: EmployeeRow[]; error?: string | null };
        const rateJson = (await rateRes.json()) as { rows?: EmployeeHourlyRateRow[]; error?: string | null };
        const idsJson = (await idsRes.json()) as {
          rows?: EmployeeIdRow[];
          error?: string | null;
          walletRail?: unknown;
        };
        const fxJson = (await fxRes.json()) as { value: string | null };

        // /api/employee-master-record queries `global_master_list` directly (where
        // the address columns live) and works as both:
        //   1. Identity fallback when the user isn't in `active_employees` (devs/founders)
        //   2. Address-data supplement when the active_employees view hasn't been
        //      refreshed since the address migration (2026-05-02) — in that case,
        //      `me` is missing the home-address fields, so we merge them in here.
        let masterRecord: EmployeeRow | null = null;
        if (mrRes) {
          try {
            const mrJson = (await mrRes.json()) as { employee?: EmployeeRow | null };
            masterRecord = mrJson.employee ?? null;
          } catch {
            /* ignore — fall back to active_employees row alone */
          }
        }

        // A pending Bank Preferred change (awaiting accounting approval) shows as
        // a badge on the field; the live value stays whatever's on employee_ids.
        let pendingBp: ProcessorId | '' = '';
        if (bpRes) {
          try {
            const bpJson = (await bpRes.json()) as { rows?: { to_value?: string; status?: string }[] };
            const latest = (bpJson.rows ?? [])[0];
            pendingBp =
              latest?.status === 'pending' && isProcessorId(latest.to_value ?? '')
                ? (latest.to_value as ProcessorId)
                : '';
          } catch {
            /* non-fatal — just no badge */
          }
        }

        if (cancelled) return;

        if (fxRes.ok) {
          setUsdToPhpRate(effectiveUsdToPhpRateFromStored(fxJson.value));
        }

        if (empJson.error) setError(empJson.error);
        // Server already filtered to this employee; just take the first row.
        const me = (empJson.employees ?? [])[0];

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
        setBankInfoLoaded(true);
        setWalletRailEffective(walletRailEffectiveFromPayload(idsJson.walletRail));
        setPendingBankPreferred(pendingBp);
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
      const idsJson = (await idsRes.json()) as { rows?: EmployeeIdRow[]; walletRail?: unknown };
      const myId = (idsJson.rows ?? [])[0];
      setBankInfo(myId ?? null);
      // Re-read the effective rail too — this save may have moved it.
      setWalletRailEffective(walletRailEffectiveFromPayload(idsJson.walletRail));
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

  /**
   * Paging rewrites ten rows that may sit entirely above the fold — the pager
   * itself does not move, so on a long page the viewer presses Next and nothing
   * visibly changes. Bring the section's own top back into view, honouring
   * `prefers-reduced-motion` the same way the deep-link anchor does.
   */
  const goToPayStubPage = (next: number) => {
    setPayStubPage(next);
    if (typeof document === 'undefined') return;
    document
      .getElementById(profileSectionDomId('payStubs'))
      ?.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
  };

  const handleExportPayStubsPdf = async () => {
    if (!payStubs.length) return;
    setExportingPdf(true);
    try {
      const full = await ensurePayStubsFull();
      await downloadPayStubsPdf(full, {
        employeeName: payStubExportName,
        department: exportDepartmentRef.current ?? employmentDepartment,
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
        department: exportDepartmentRef.current ?? employmentDepartment,
      });
      toast.success('Pay stubs spreadsheet downloaded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not export spreadsheet');
    } finally {
      setExportingXlsx(false);
    }
  };

  const workEmail =
    master?.work_email?.trim() || rate?.work_email?.trim() || bankInfo?.work_email?.trim() || null;

  // The ID card reads the ROSTER address (`global_master_list.full_address`), the
  // same column Overview shows — never `employee_ids.full_address`, which the
  // Payment tab lets the employee edit for payout purposes. The two can disagree,
  // and an identity document follows the roster.
  //
  // This memo and the `savingId` guard below it live ABOVE `if (loading)`: a hook
  // below an early return is skipped on the loading render and called on the
  // loaded one, which is the "Rendered more hooks than during the previous
  // render" crash. Guarded by src/lib/employee/profile-hook-order.test.ts.
  const idCard = useMemo(
    () =>
      buildIdCard({
        name: master?.name ?? null,
        workEmail,
        fallbackEmail: employeeEmail,
        department: master?.department ?? null,
        fullAddress: master?.full_address ?? null,
        street: master?.street ?? null,
        city: master?.city ?? null,
        province: master?.province ?? null,
        postalCode: master?.postal_code ?? null,
        startDate: master?.start_date ?? null,
        employeeId: master?.employee_id ?? null,
        photoUrl: displayProfilePhotoUrl,
        googlePhotoUrl,
      }),
    [master, workEmail, employeeEmail, displayProfilePhotoUrl, googlePhotoUrl],
  );

  // The PNG is painted on a canvas from the same view model the badge renders
  // (src/lib/employee/id-card-render.ts). `savingId` is the double-click guard:
  // without it a second click starts a second canvas and hands over two files.
  const [savingId, setSavingId] = useState(false);
  const handleDownloadId = async () => {
    if (savingId) return;
    setSavingId(true);
    try {
      await downloadIdCardPng(idCard);
    } catch (e) {
      // Every failure inside the painter degrades except an unloadable wordmark
      // and an unencodable canvas, and both arrive here already worded for a
      // human. Anything else is unexpected and says so rather than staying quiet.
      toast.error(
        e instanceof IdCardRenderError
          ? e.message
          : 'Could not save your ID card. Please try again.',
      );
    } finally {
      setSavingId(false);
    }
  };

  if (loading) return <ProfileSkeleton />;

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
                      value={employmentDepartment ? formatDeptLabel(employmentDepartment) : '—'}
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

                  {/* The badge is container-query sized — every dimension inside
                      EmployeeIdCard.tsx is `cqw` against a `@container w-full max-w-[372px]`.
                      The exported PNG is painted from data at a fixed size, so if this host
                      narrows below 372px the on-screen badge and its typography shrink while
                      the download does not, and the two diverge with no error. Keep this block
                      full-width in the content column; never nest it in a grid track. */}
                  <div className="flex flex-col items-center gap-5 py-2">
                    <EmployeeIdCard card={idCard} />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleDownloadId}
                      disabled={savingId}
                      className="gap-2"
                    >
                      {savingId ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <Download className="h-4 w-4" aria-hidden />
                      )}
                      {savingId ? 'Saving…' : 'Download PNG'}
                    </Button>
                    <p className="max-w-xs text-center text-[12.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      Read-only, from the HR master roster. Anything missing or wrong here is
                      corrected by HR, not on this screen.
                    </p>
                  </div>
                </>
              )}

              {activeTab === 'compensation' && (
                <>
                  <CompensationSections
                    active={activeCompensationSection}
                    onChange={setStoredSection}
                    needsPayout={needsPayoutSetup}
                    payoutEscalated={escalatePayment && needsPayoutSetup}
                  />

                  {/* ONE panel node per section, keyed on the active section so
                      AnimatePresence can slide the swap. It carries that section's
                      DERIVED dom id, which makes the deep-link scroll anchor and the
                      strip's aria-controls target the same element — neither can drift
                      away from the other, or from the section's name. */}
                  <AnimatePresence mode="wait" initial={false} custom={compensationSlide}>
                    <motion.div
                      key={activeCompensationSection}
                      custom={compensationSlide}
                      variants={COMPENSATION_PANE_VARIANTS}
                      initial="enter"
                      animate="center"
                      exit="exit"
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                      id={profileSectionDomId(activeCompensationSection)}
                      ref={scrollToCompensationAnchor}
                      role="tabpanel"
                      aria-labelledby={profileSectionTabDomId(activeCompensationSection)}
                      className="space-y-4"
                    >
                      {activeCompensationSection === 'rates' && (
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

                          {/* Re-scoped, not deleted. "Bonuses are not shown here" was
                              true of a standalone Rates TAB; one section away there is
                              now a statement list that itemises Perfect Attendance and
                              Technology by week, so the old sentence read as a flat
                              contradiction of the pane next door. The claim it was
                              actually making — these two figures are RATES, and no
                              bonus is folded into them — is the one worth keeping. */}
                          <p className="px-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                            These are your hourly rates only — no bonus is folded into them.
                            Bonuses (Perfect Attendance, Technology) are applied during payroll
                            processing, and appear itemised on each week's statement under Pay
                            Stubs as well as on your dashboard.
                          </p>
                        </>
                      )}

                      {activeCompensationSection === 'payStubs' && (
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
                            {payStubsLoading && payStubs.length === 0 ? (
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
                                        onClick={() => goToPayStubPage(Math.max(0, payStubPageSafe - 1))}
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
                                          goToPayStubPage(Math.min(payStubPageCount - 1, payStubPageSafe + 1))
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

                      {/* Three readiness states share this pane, and they stay
                          independent. Rates and Pay Stubs paint from the session
                          cache immediately; the bank/payout row is deliberately
                          never cached (account numbers stay out of storage), so
                          PAYOUT ALONE waits for the live row — its own skeleton,
                          never the empty "add your details" form flashing over
                          real saved details. `loading` is not widened to cover
                          this, and no combined effect awaits `bankInfoLoaded`. */}
                      {payoutPaneVisible && !bankInfoLoaded && (
                        <Section title="Disbursement" description="How and where you get paid">
                          <div className="space-y-3 py-4" aria-busy="true" aria-label="Loading payout details">
                            {[0, 1, 2, 3].map((i) => (
                              <div
                                key={i}
                                className="h-10 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900"
                              />
                            ))}
                          </div>
                        </Section>
                      )}
                      {payoutPaneVisible && bankInfoLoaded && (
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
                                onChange={(id) => {
                                  setPreferredProcessor(id);
                                  // THE 1:1 MIRROR (Kane, 2026-08-31 PM): picking Kolan
                                  // or HiGlobe as the receiving bank pins the sending
                                  // rail to the same wallet. In-form only — the save
                                  // FILES the Bank Preferred change through the
                                  // Accounting approval gate; the server applies the
                                  // same mirror regardless, so this is display, not
                                  // enforcement. Bank rails impose nothing.
                                  const wallet = mirroredBankPreferredFor(id);
                                  if (wallet) setBankPreferred(wallet);
                                }}
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
                                    : walletFromReceiving(preferredProcessor)
                                      ? `Your receiving bank is ${PROCESSOR_OPTIONS.find((p) => p.id === walletFromReceiving(preferredProcessor))?.label} — your salary is sent from that same wallet, 1:1. Changes need Accounting approval.`
                                      : 'The bank Payment Dispatch routes your salary through. Kolan/HiGlobe follow your receiving bank automatically; Wise can only be set by Accounting. Changes need Accounting approval.'}
                                </p>
                              </div>
                              <SmoothSelect
                                aria-label="Bank Preferred"
                                value={
                                  // "Defaulted to what they are": the stored tier-1 pick
                                  // wins; else a wallet receiving bank pins the display
                                  // (1:1); else the server-resolved EFFECTIVE rail, so a
                                  // tier-2/tier-3-routed person sees their real rail
                                  // instead of an empty "Select…". Display only — no
                                  // write happens until the user changes something.
                                  bankPreferredLabelForProcessor(bankPreferred) ||
                                  bankPreferredLabelForProcessor(
                                    walletFromReceiving(preferredProcessor) ?? walletRailEffective ?? '',
                                  )
                                }
                                onChange={(label) => {
                                  setBankPreferred(processorForBankPreferredLabel(label) ?? '');
                                }}
                                disabled={payoutReadOnly}
                                triggerClassName="w-full sm:w-48"
                                options={[
                                  ...(bankPreferredLabelForProcessor(bankPreferred) ||
                                  bankPreferredLabelForProcessor(
                                    walletFromReceiving(preferredProcessor) ?? walletRailEffective ?? '',
                                  )
                                    ? []
                                    : [{ value: '', label: 'Select…' }]),
                                  // THE 1:1 RULE, option-list edition: keyed on the LIVE
                                  // receiving pick above. A wallet receiver sees exactly
                                  // their wallet (the send-from is pinned); a bank-rail
                                  // receiver sees the bank options; someone with no
                                  // receiving channel sees everything, and a wallet pick
                                  // here mirrors the receiving channel server-side. Wise
                                  // is absent for employees — Accounting sets Wise as a
                                  // sending bank in People → Banking.
                                  ...selectableBankPreferredOptions(preferredProcessor, 'employee').map(
                                    (o) => ({
                                      value: o.label,
                                      label: o.label,
                                    }),
                                  ),
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
                    </motion.div>
                  </AnimatePresence>
                </>
              )}

              {activeTab === 'skills' && (
                <>
                  <div
                    id={profileSectionDomId('skillSets')}
                    ref={scrollToSectionAnchor}
                    className="scroll-mt-24"
                  >
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
                  </div>

                  <div
                    id={profileSectionDomId('commendations')}
                    ref={scrollToSectionAnchor}
                    className="scroll-mt-24"
                  >
                    <div className="mb-3 px-5 sm:px-6">
                      <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">
                        Commendations
                      </h3>
                      <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        Shared by your manager
                      </p>
                    </div>
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
                  </div>
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
