'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import {
  Briefcase,
  Eye,
  EyeOff,
  IdCard,
  Loader2,
  Mail,
  MapPin,
  NotebookPen,
  ReceiptText,
  Save,
  CalendarDays,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { SkillBlock, TeamAvatar } from '@/components/team/team-ui';
import { formatCurrentProjects } from '@/lib/skill-set-titles';
import ManagerMemberHoursMini from './ManagerMemberHoursMini';

type TabId = 'work' | 'notes' | 'payments';

/** Shared-profile fields the manager can view in the dialog (read-only). */
interface DialogSkillSet {
  role_title: string;
  currently_working_on: string;
  skills: string;
  strengths: string;
  member_notes: string;
  projects: string[];
  current_projects: string[];
}

interface ManagerMemberDialogProps {
  member: EmployeeRow | null;
  onClose: () => void;
  /** Shared-profile (skills / strengths / projects) shown read-only in the dialog. */
  skillSet?: DialogSkillSet;
  /** Current manager-authored member notes for this teammate (seed value). */
  initialMemberNotes?: string;
  /** Fired after a successful save so the caller can update its roster cache. */
  onMemberNotesSaved?: (notes: string) => void;
}

const MEMBER_NOTES_MAX = 4000;

/**
 * Manager-only editor for a teammate's member notes. Employees see these notes
 * read-only on their profile / My Team; only managers write them, via
 * PUT /api/manager/member-notes.
 */
function MemberNotesEditor({
  workEmail,
  initialNotes,
  onSaved,
}: {
  workEmail: string | null;
  initialNotes: string;
  onSaved?: (notes: string) => void;
}) {
  const [value, setValue] = useState(initialNotes);
  const [baseline, setBaseline] = useState(initialNotes);
  const [saving, setSaving] = useState(false);

  // Reseed when the dialog switches to a different member.
  useEffect(() => {
    setValue(initialNotes);
    setBaseline(initialNotes);
  }, [initialNotes, workEmail]);

  const dirty = value !== baseline;

  const save = async () => {
    if (!workEmail) {
      toast.error('No work email on file — notes cannot be saved for this member.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/manager/member-notes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: workEmail, member_notes: value }),
      });
      const json = (await res.json()) as { member_notes?: string; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || 'Save failed');
      const saved = json.member_notes ?? value;
      setBaseline(saved);
      setValue(saved);
      onSaved?.(saved);
      toast.success('Member notes saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save member notes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-amber-200/70 bg-amber-50/40 p-3 dark:border-amber-500/20 dark:bg-amber-500/5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
          <NotebookPen className="h-3.5 w-3.5" />
          Member notes
        </div>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={!dirty || saving || !workEmail}
          className="h-7 gap-1.5 bg-amber-600 text-xs text-white hover:bg-amber-700 disabled:opacity-50 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Save
        </Button>
      </div>
      <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/70">
        Manager-only. Visible to the teammate and their team — they cannot edit it.
      </p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, MEMBER_NOTES_MAX))}
        rows={4}
        disabled={!workEmail || saving}
        placeholder={
          workEmail
            ? 'e.g. Strong on async comms; mentoring two juniors this quarter.'
            : 'No work email on file for this member.'
        }
        className="mt-2 w-full resize-y rounded-lg border border-amber-200 bg-white px-3 py-2 text-[13px] leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-500/30 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-amber-500/60 dark:focus:ring-amber-500/20"
      />
    </div>
  );
}

function formatPhp(v: number | null | undefined): string {
  if (v == null) return '—';
  return `₱${v.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function memberHourlyRate(member: EmployeeRow): number | null {
  return member.hsl_hourly_rate ?? member.regular_rate ?? null;
}

function memberOtRate(member: EmployeeRow): number | null {
  return member.hsl_ot_rate ?? member.ot_rate ?? null;
}

function formatDate(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Lightweight rate masking: opacity + translate only — no `filter: blur`, which is
// GPU-expensive on mid-tier mobile and causes janky frames during the swap. The
// translate carries enough motion to read as a transition.
function MaskedRate({
  value,
  hidden,
}: {
  value: number | null | undefined;
  hidden: boolean;
}) {
  const transition = { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const };
  return (
    <span className="relative inline-block transform-gpu">
      <AnimatePresence mode="wait" initial={false}>
        {hidden ? (
          <motion.span
            key="hidden"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 3 }}
            transition={transition}
            className="inline-block select-none tracking-widest text-zinc-400 dark:text-zinc-600"
          >
            ••••••
          </motion.span>
        ) : value != null ? (
          <motion.span
            key="shown"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 3 }}
            transition={transition}
            className="inline-block"
          >
            {formatPhp(value)}
          </motion.span>
        ) : (
          <motion.span
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="inline-block text-zinc-300 dark:text-zinc-700"
          >
            —
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function TabBar({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  const tabs: { id: TabId; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'work', label: 'Work', Icon: Briefcase },
    { id: 'notes', label: 'Notes', Icon: NotebookPen },
    { id: 'payments', label: 'Payments', Icon: ReceiptText },
  ];
  return (
    <LayoutGroup id="manager-member-tabs">
      <div
        className="flex gap-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Member sections"
      >
        {tabs.map((t) => {
          const isActive = active === t.id;
          const Icon = t.Icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(t.id)}
              className={cn(
                'relative flex shrink-0 items-center gap-1.5 px-3.5 py-3 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#0a0a0a]',
                isActive
                  ? 'text-blue-700 dark:text-blue-300'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              {isActive && (
                <motion.span
                  layoutId="manager-member-tab-underline"
                  className="absolute -bottom-px left-1 right-1 h-[2px] rounded-full bg-gradient-to-r from-blue-500 to-blue-700"
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

/** Right-panel "Work" tab — the teammate's shared profile (read-only). */
function WorkTab({ skillSet }: { skillSet?: DialogSkillSet }) {
  const currentWork = formatCurrentProjects(
    skillSet?.current_projects,
    skillSet?.currently_working_on,
  );
  const hasSharedProfile = Boolean(
    currentWork || skillSet?.skills?.trim() || skillSet?.strengths?.trim(),
  );

  if (!hasSharedProfile) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-200 bg-white/60 px-4 py-12 text-center dark:border-zinc-800 dark:bg-zinc-950/30">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-400 dark:bg-blue-500/10">
          <Briefcase className="h-5 w-5" />
        </div>
        <p className="text-[13px] font-medium text-zinc-600 dark:text-zinc-300">Nothing shared yet</p>
        <p className="max-w-xs text-[12px] text-zinc-400 dark:text-zinc-600">
          This teammate hasn’t added their projects, skills, or strengths to their profile.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {currentWork && <SkillBlock label="Currently Working On" value={currentWork} />}
      <SkillBlock label="Skills" value={skillSet?.skills ?? ''} chip chipPageSize={60} />
      <SkillBlock label="Strengths" value={skillSet?.strengths ?? ''} />
    </div>
  );
}

/** A labelled identity fact in the left rail. Hidden when empty. */
function RailRow({
  label,
  value,
  mono,
  icon: Icon,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  if (!value?.toString().trim()) return null;
  return (
    <div className="flex items-start gap-2.5">
      {Icon && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600 ring-1 ring-inset ring-blue-100 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/20">
          <Icon className="h-3 w-3" />
        </div>
      )}
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          {label}
        </div>
        <div
          className={cn(
            'mt-0.5 break-words text-[12.5px] leading-snug text-zinc-800 dark:text-zinc-100',
            mono && 'font-mono text-[12px]',
          )}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

export default function ManagerMemberDialog({
  member,
  onClose,
  skillSet,
  initialMemberNotes = '',
  onMemberNotesSaved,
}: ManagerMemberDialogProps) {
  const [activeTab, setActiveTab] = useState<TabId>('work');
  const [ratesHidden, setRatesHidden] = useState(true);

  useEffect(() => {
    if (member) setActiveTab('work');
  }, [member]);

  const roleTitle = skillSet?.role_title?.trim() || member?.hsl_role?.trim() || null;
  const avatarEmail = member?.work_email ?? member?.personal_email ?? null;
  const fullAddress = member
    ? member.full_address?.trim() ||
      [member.street, member.city, member.province, member.postal_code]
        .filter((v) => !!v?.trim())
        .join(', ') ||
      null
    : null;

  return (
    <Dialog open={!!member} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100%-1.5rem)] gap-0 overflow-hidden border-blue-100/70 p-0 dark:border-blue-950/50 sm:max-w-3xl">
        {member && (
          <div className="grid max-h-[86vh] grid-cols-1 sm:grid-cols-[16rem_1fr] md:grid-cols-[18rem_1fr]">
            {/* ── Identity rail ─────────────────────────────────────────── */}
            <aside className="flex max-h-[38vh] flex-col gap-4 overflow-y-auto border-b border-zinc-200/70 bg-gradient-to-b from-blue-50 via-blue-50/30 to-white px-5 py-6 dark:border-zinc-800 dark:from-blue-950/30 dark:via-blue-950/10 dark:to-zinc-950 sm:max-h-[86vh] sm:border-b-0 sm:border-r">
              {/* Identity */}
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="rounded-full p-1 ring-1 ring-blue-200/70 dark:ring-blue-500/20">
                  <TeamAvatar name={member.name ?? '—'} email={avatarEmail} size="xl" />
                </div>
                <div className="min-w-0">
                  <DialogTitle className="text-[17px] font-semibold leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">
                    {member.name ?? '—'}
                  </DialogTitle>
                  {roleTitle && (
                    <p className="mt-1 text-[12.5px] font-medium text-blue-700 dark:text-blue-300">
                      {roleTitle}
                    </p>
                  )}
                  <DialogDescription className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5">
                    {member.department && (
                      <span className="rounded-md border border-blue-200 bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                        {member.department}
                      </span>
                    )}
                    {member.mesa_member && (
                      <span
                        title="MESA Program — ₱100 deducted per paycheck"
                        className="rounded-md border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300"
                      >
                        MESA −₱100
                      </span>
                    )}
                  </DialogDescription>
                </div>
              </div>

              {/* Pay rates + visibility toggle */}
              <div className="rounded-xl border border-blue-100/80 bg-white/80 p-3 shadow-sm dark:border-blue-950/50 dark:bg-zinc-950/50">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    Pay rates
                  </span>
                  <button
                    type="button"
                    onClick={() => setRatesHidden((v) => !v)}
                    title={ratesHidden ? 'Show rates' : 'Hide rates'}
                    aria-label={ratesHidden ? 'Show rates' : 'Hide rates'}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-blue-600 transition-colors hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={ratesHidden ? 'eye' : 'eye-off'}
                        initial={{ rotate: -45, scale: 0.6, opacity: 0 }}
                        animate={{ rotate: 0, scale: 1, opacity: 1 }}
                        exit={{ rotate: 45, scale: 0.6, opacity: 0 }}
                        transition={{ duration: 0.16, ease: 'easeOut' }}
                        className="inline-flex"
                      >
                        {ratesHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      </motion.span>
                    </AnimatePresence>
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                      Hourly
                    </div>
                    <div className="font-mono text-[15px] tabular-nums text-zinc-900 dark:text-zinc-100">
                      <MaskedRate value={memberHourlyRate(member)} hidden={ratesHidden} />
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                      Overtime
                    </div>
                    <div className="font-mono text-[15px] tabular-nums text-zinc-900 dark:text-zinc-100">
                      <MaskedRate value={memberOtRate(member)} hidden={ratesHidden} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Identity facts */}
              <div className="space-y-3">
                <RailRow label="Employee ID" value={member.employee_id ?? null} mono icon={IdCard} />
                <RailRow label="Start date" value={formatDate(member.start_date)} icon={CalendarDays} />
                <RailRow label="Work email" value={member.work_email ?? null} mono icon={Mail} />
                <RailRow label="Personal email" value={member.personal_email ?? null} mono icon={Mail} />
                <RailRow label="Address" value={fullAddress} icon={MapPin} />
              </div>
            </aside>

            {/* ── Tabbed detail panel ───────────────────────────────────── */}
            <div className="flex min-h-0 min-w-0 flex-col">
              <div className="border-b border-zinc-200/70 bg-white/70 px-3 dark:border-zinc-800 dark:bg-zinc-950/40 sm:px-4">
                <TabBar active={activeTab} onChange={setActiveTab} />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50/50 px-4 py-4 transform-gpu dark:bg-zinc-950/30 sm:px-5">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={activeTab}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -3 }}
                    transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                    className="transform-gpu"
                  >
                    {activeTab === 'work' && <WorkTab skillSet={skillSet} />}
                    {activeTab === 'notes' && (
                      <MemberNotesEditor
                        workEmail={member.work_email ?? null}
                        initialNotes={initialMemberNotes}
                        onSaved={onMemberNotesSaved}
                      />
                    )}
                    {activeTab === 'payments' && (
                      <ManagerMemberHoursMini
                        workEmail={member.work_email ?? null}
                        personalEmail={member.personal_email ?? null}
                        ratesHidden={ratesHidden}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
