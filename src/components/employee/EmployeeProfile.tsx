'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
} from 'lucide-react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { PROCESSOR_OPTIONS, type ProcessorId } from '@/lib/employee-payment-processors';
import { SKILL_SET_TITLES, hasAnySkillSetContent } from '@/lib/skill-set-titles';
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

type TabId = 'overview' | 'compensation' | 'payment' | 'skillsets' | 'reports';

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
}: {
  active: TabId;
  onChange: (id: TabId) => void;
  hasAddress: boolean;
  needsPhoto: boolean;
  needsBank: boolean;
  needsSkillSet: boolean;
}) {
  const tabs: { id: TabId; label: string; sub: string }[] = [
    { id: 'overview', label: 'Overview', sub: hasAddress ? 'Identity, employment, address' : 'Identity & employment' },
    { id: 'compensation', label: 'Compensation', sub: 'Rates & currency' },
    { id: 'payment', label: 'Payment', sub: 'Disbursement details' },
    { id: 'skillsets', label: 'Skill Sets', sub: 'Visible to teammates' },
    { id: 'reports', label: 'Reports', sub: 'Commendations & recognition' },
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
            (t.id === 'skillsets' && needsSkillSet);
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(t.id)}
              className={[
                'relative shrink-0 px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#0a0a0a] sm:px-4',
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
                  aria-label={`${t.label} setup needed`}
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500/70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-[#0a0a0a]" />
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
      <div className="mx-auto w-full max-w-[1024px] px-5 pb-16 pt-8 sm:px-8 sm:pt-12 lg:px-10">
        <div className="flex items-center gap-5">
          <div className="h-16 w-16 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-900 sm:h-20 sm:w-20" />
          <div className="flex-1 space-y-2.5">
            <div className="h-6 w-44 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900" />
            <div className="h-3.5 w-32 animate-pulse rounded bg-zinc-100/70 dark:bg-zinc-900/70" />
            <div className="flex gap-1.5">
              <div className="h-5 w-16 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-900" />
              <div className="h-5 w-20 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-900" />
            </div>
          </div>
        </div>
        <div className="mt-8 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
          {[1, 2, 3].map((i) => (
            <div key={i} className="px-4 py-3">
              <div className="h-3.5 w-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
              <div className="mt-1 h-2 w-28 animate-pulse rounded bg-zinc-100/70 dark:bg-zinc-900/70" />
            </div>
          ))}
        </div>
        <div className="mt-8 space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-zinc-200/80 bg-white p-5 dark:border-zinc-800/80 dark:bg-zinc-950/40"
            >
              <div className="h-4 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
              <div className="mt-4 space-y-3">
                {[1, 2, 3].map((j) => (
                  <div
                    key={j}
                    className="h-3.5 animate-pulse rounded bg-zinc-100/70 dark:bg-zinc-900/70"
                    style={{ animationDelay: `${j * 100}ms` }}
                  />
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
  const [payout, setPayout] = useState<PayoutFields>(() => ({ ...emptyPayout }));
  const [payoutSaving, setPayoutSaving] = useState(false);
  const [payoutSavedAt, setPayoutSavedAt] = useState<string | null>(null);
  const [payoutEditing, setPayoutEditing] = useState(false);

  const [activeTab, setActiveTab] = useState<TabId>('overview');

  useEffect(() => {
    setActiveTab(focusTab);
  }, [focusTab]);

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

  // Skill Sets - editable by the employee, read-only on the My Team page.
  const [skillSet, setSkillSet] = useState<SkillSetFields>(EMPTY_SKILL_SET);
  const [skillSetBaseline, setSkillSetBaseline] = useState<SkillSetFields>(EMPTY_SKILL_SET);
  const [skillSetLoading, setSkillSetLoading] = useState(false);
  const [skillSetLoaded, setSkillSetLoaded] = useState(false);
  const [skillSetSaving, setSkillSetSaving] = useState(false);
  const [skillSetSavedAt, setSkillSetSavedAt] = useState<string | null>(null);

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
      setPayout({ ...emptyPayout });
      setPayoutEditing(true);
      return;
    }
    const d = payoutDraftFromIdsRow(bankInfo as unknown as Record<string, unknown>);
    setPreferredProcessor(d.preferredProcessor);
    setPayout(d.payout);
    setPayoutEditing(false);
  }, [bankInfo]);

  const resetPayoutDraft = React.useCallback(() => {
    if (!bankInfo) {
      setPreferredProcessor('');
      setPayout({ ...emptyPayout });
      setPayoutEditing(true);
      return;
    }
    const d = payoutDraftFromIdsRow(bankInfo as unknown as Record<string, unknown>);
    setPreferredProcessor(d.preferredProcessor);
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
      const json = (await res.json()) as { error?: string | null; success?: boolean };
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
      toast.success('Payment details saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save payment details');
    } finally {
      setPayoutSaving(false);
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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-white dark:bg-[#0a0a0a]">
      <div className="mx-auto w-full max-w-[1024px] px-5 pb-16 pt-8 sm:px-8 sm:pt-12 sm:pb-20 lg:px-10 lg:pt-14">
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
            <p className="leading-relaxed text-amber-900 dark:text-amber-200">{error}</p>
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
                        <label className="block">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                              Role / Title
                            </span>
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                              Shown on your My Team card
                            </span>
                          </div>
                          <select
                            value={skillSet.role_title}
                            onChange={(e) =>
                              setSkillSet((s) => ({ ...s, role_title: e.target.value }))
                            }
                            className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px] text-zinc-900 focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-blue-800 dark:focus:ring-blue-900/40"
                          >
                            <option value="">Select a title...</option>
                            {SKILL_SET_TITLES.map((title) => (
                              <option key={title} value={title}>
                                {title}
                              </option>
                            ))}
                          </select>
                        </label>
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
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
