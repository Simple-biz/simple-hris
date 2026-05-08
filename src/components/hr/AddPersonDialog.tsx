'use client';

import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowRight,
  AtSign,
  Briefcase,
  Building2,
  Calendar,
  Check,
  Compass,
  Loader2,
  Mail,
  MapPin,
  NotebookPen,
  Phone,
  Sparkles,
  User,
  UserPlus,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DepartmentRateSummary } from '@/lib/supabase/department-rates';
import type { HrPendingEmployeeRow } from '@/lib/supabase/hr-pending-employees';

interface AddPersonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after a successful create — parent re-fetches the pending list. */
  onCreated: (row: HrPendingEmployeeRow) => void;
}

type FormState = {
  name: string;
  personal_email: string;
  work_email: string;
  department: string;
  job_description: string;
  start_date: string;
  source: string;
  phone: string;
  location: string;
  regular_rate: string;
  ot_rate: string;
  notes: string;
};

type TouchedKey = keyof FormState;

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const buildEmptyForm = (): FormState => ({
  name: '',
  personal_email: '',
  work_email: '',
  department: '',
  job_description: '',
  start_date: todayISO(),
  source: '',
  phone: '',
  location: '',
  regular_rate: '',
  ot_rate: '',
  notes: '',
});

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

type FieldErrors = Partial<Record<'name' | 'personal_email' | 'work_email' | 'department', string>>;

export default function AddPersonDialog({
  open,
  onOpenChange,
  onCreated,
}: AddPersonDialogProps) {
  const [form, setForm] = useState<FormState>(buildEmptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [departments, setDepartments] = useState<DepartmentRateSummary[]>([]);
  const [departmentsLoading, setDepartmentsLoading] = useState(false);
  const [touched, setTouched] = useState<Set<TouchedKey>>(new Set());
  const [autofilled, setAutofilled] = useState(false);

  // Load department → rate map once when the dialog first opens. Cached across
  // re-opens so a quick close/re-open doesn't refetch.
  useEffect(() => {
    if (!open || departments.length > 0 || departmentsLoading) return;
    setDepartmentsLoading(true);
    fetch('/api/hr/department-rates', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { departments?: DepartmentRateSummary[]; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setDepartments(j.departments ?? []);
      })
      .catch((e) =>
        toast.error(e instanceof Error ? e.message : 'Could not load departments'),
      )
      .finally(() => setDepartmentsLoading(false));
  }, [open, departments.length, departmentsLoading]);

  // Reset on close so the next open lands on a fresh slate.
  useEffect(() => {
    if (!open) {
      setForm(buildEmptyForm());
      setTouched(new Set());
      setAutofilled(false);
    }
  }, [open]);

  const deptByName = useMemo(() => {
    const m = new Map<string, DepartmentRateSummary>();
    for (const d of departments) m.set(d.department, d);
    return m;
  }, [departments]);

  const update = (patch: Partial<FormState>) =>
    setForm((p) => ({ ...p, ...patch }));

  const markTouched = (k: TouchedKey) =>
    setTouched((s) => {
      if (s.has(k)) return s;
      const n = new Set(s);
      n.add(k);
      return n;
    });

  /** Picking a department auto-fills typical rates from `employee_hourly_rates`.
   *  We track which rates were "untouched" (still equal to the previous dept's
   *  prefill or empty) so user-entered overrides are never overwritten. */
  const onDepartmentChange = (next: string) => {
    setForm((prev) => {
      const dept = deptByName.get(next);
      const prevDept = deptByName.get(prev.department);
      const regularUntouched =
        prev.regular_rate.trim() === '' ||
        prev.regular_rate === (prevDept?.regular_rate ?? '');
      const otUntouched =
        prev.ot_rate.trim() === '' || prev.ot_rate === (prevDept?.ot_rate ?? '');

      const willPrefill =
        ((regularUntouched && dept?.regular_rate) ||
          (otUntouched && dept?.ot_rate)) ?? false;
      if (willPrefill) setAutofilled(true);

      return {
        ...prev,
        department: next,
        regular_rate: regularUntouched ? dept?.regular_rate ?? '' : prev.regular_rate,
        ot_rate: otUntouched ? dept?.ot_rate ?? '' : prev.ot_rate,
      };
    });
    markTouched('department');
  };

  // Manually editing a rate dismisses the auto-fill badge — signals the user
  // has taken ownership of the value.
  const onRateChange = (key: 'regular_rate' | 'ot_rate', val: string) => {
    update({ [key]: val });
    setAutofilled(false);
  };

  const errors: FieldErrors = useMemo(() => {
    const e: FieldErrors = {};
    if (!form.name.trim()) e.name = 'Required';
    if (!form.personal_email.trim()) e.personal_email = 'Required';
    else if (!isPlausibleEmail(form.personal_email))
      e.personal_email = 'Doesn’t look like an email';
    if (form.work_email && !isPlausibleEmail(form.work_email))
      e.work_email = 'Doesn’t look like an email';
    if (!form.department.trim()) e.department = 'Required';
    return e;
  }, [form]);

  const isValid = Object.keys(errors).length === 0;

  const missing = useMemo(() => {
    const m: string[] = [];
    if (errors.name) m.push('name');
    if (errors.personal_email) m.push('personal email');
    if (errors.department) m.push('department');
    return m;
  }, [errors]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isValid) {
      // Surface every required error at once on submit.
      setTouched(new Set(['name', 'personal_email', 'work_email', 'department']));
      const first =
        errors.name ||
        errors.personal_email ||
        errors.work_email ||
        errors.department;
      if (first) toast.error(first);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/hr/pending-employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          personal_email: form.personal_email.trim(),
          work_email: form.work_email.trim() || null,
          department: form.department.trim(),
          job_description: form.job_description.trim() || null,
          start_date: form.start_date || null,
          source: form.source.trim() || null,
          phone: form.phone.trim() || null,
          location: form.location.trim() || null,
          regular_rate: form.regular_rate.trim() || null,
          ot_rate: form.ot_rate.trim() || null,
          notes: form.notes.trim() || null,
        }),
      });
      const json = (await res.json()) as {
        row?: HrPendingEmployeeRow;
        error?: string;
      };
      if (!res.ok || json.error || !json.row) {
        throw new Error(json.error ?? 'Failed to create');
      }
      toast.success(`Added ${form.name.trim()} to pending hires`, {
        description:
          json.row.status === 'pending_work_email'
            ? 'Set the @simple.biz work email when Payroll provides it.'
            : 'Ready to promote to the master list when you confirm orientation.',
      });
      onCreated(json.row);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  }

  const selectedDept = deptByName.get(form.department);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // Override base-ui defaults: full-bleed layout, no internal padding,
          // wider canvas for the timeline composition.
          'flex max-h-[92vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl',
          // Soft botanical wash — light & dark.
          'bg-[radial-gradient(ellipse_120%_70%_at_top_left,rgba(16,185,129,0.10)_0%,rgba(255,255,255,1)_55%),radial-gradient(ellipse_100%_60%_at_bottom_right,rgba(20,184,166,0.07)_0%,rgba(255,255,255,1)_60%)]',
          'dark:bg-[radial-gradient(ellipse_120%_70%_at_top_left,rgba(16,185,129,0.16)_0%,rgba(13,17,23,1)_55%),radial-gradient(ellipse_100%_60%_at_bottom_right,rgba(20,184,166,0.10)_0%,rgba(13,17,23,1)_60%)]',
          'border-emerald-200/70 dark:border-emerald-900/55',
          'rounded-2xl shadow-2xl shadow-emerald-950/10 dark:shadow-black/60',
        )}
      >
        <DialogHero />

        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
          noValidate
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-3 sm:px-9">
            <Timeline>
              {/* ─── 01 The basics ─────────────────────────────────── */}
              <SectionStep number="01" label="The basics" delay={0}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label="Full name"
                    icon={User}
                    required
                    error={touched.has('name') ? errors.name : undefined}
                  >
                    <FieldInput
                      value={form.name}
                      onChange={(e) => update({ name: e.target.value })}
                      onBlur={() => markTouched('name')}
                      placeholder="Last, First Middle"
                      aria-invalid={touched.has('name') && !!errors.name}
                      autoFocus
                    />
                  </FormField>

                  <FormField
                    label="Personal email"
                    icon={Mail}
                    required
                    error={
                      touched.has('personal_email')
                        ? errors.personal_email
                        : undefined
                    }
                  >
                    <FieldInput
                      type="email"
                      value={form.personal_email}
                      onChange={(e) => update({ personal_email: e.target.value })}
                      onBlur={() => markTouched('personal_email')}
                      placeholder="name@gmail.com"
                      aria-invalid={
                        touched.has('personal_email') && !!errors.personal_email
                      }
                    />
                  </FormField>
                </div>

                <div className="mt-4">
                  <FormField
                    label="Work email"
                    icon={AtSign}
                    trailing={<TrailingChip>optional now</TrailingChip>}
                    hint="Leave blank if Payroll hasn’t minted the @simple.biz address yet — the row stays in “awaiting work email” until you fill it."
                    error={
                      touched.has('work_email') ? errors.work_email : undefined
                    }
                  >
                    <FieldInput
                      type="email"
                      value={form.work_email}
                      onChange={(e) => update({ work_email: e.target.value })}
                      onBlur={() => markTouched('work_email')}
                      placeholder="namel@simple.biz"
                      aria-invalid={
                        touched.has('work_email') && !!errors.work_email
                      }
                    />
                  </FormField>
                </div>
              </SectionStep>

              {/* ─── 02 Their role ─────────────────────────────────── */}
              <SectionStep number="02" label="Their role" delay={0.05}>
                <FormField
                  label="Department"
                  icon={Building2}
                  required
                  hint={
                    departmentsLoading
                      ? 'Loading departments…'
                      : `${departments.length} departments on file — picking one auto-fills the typical rate.`
                  }
                  error={
                    touched.has('department') ? errors.department : undefined
                  }
                >
                  <DepartmentPicker
                    value={form.department}
                    onChange={onDepartmentChange}
                    onBlur={() => markTouched('department')}
                    departments={departments}
                    loading={departmentsLoading}
                  />
                </FormField>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <FormField label="Job description" icon={Briefcase}>
                    <FieldInput
                      value={form.job_description}
                      onChange={(e) =>
                        update({ job_description: e.target.value })
                      }
                      placeholder="Case Manager, Editor…"
                    />
                  </FormField>

                  <FormField
                    label="Source"
                    icon={Compass}
                    hint="Where this hire came from."
                  >
                    <FieldInput
                      value={form.source}
                      onChange={(e) => update({ source: e.target.value })}
                      placeholder="Referral – Maria"
                    />
                  </FormField>
                </div>
              </SectionStep>

              {/* ─── 03 Compensation ───────────────────────────────── */}
              <SectionStep number="03" label="Compensation" delay={0.1}>
                <AnimatePresence initial={false}>
                  {autofilled && selectedDept && (
                    <motion.div
                      key="autofill-pill"
                      initial={{ opacity: 0, y: -6, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.96 }}
                      transition={{
                        duration: 0.24,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                      className="mb-4 flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/80 px-3.5 py-1.5 text-[12px] text-emerald-900 shadow-sm shadow-emerald-500/10 backdrop-blur-sm dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100"
                    >
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <span className="leading-tight">
                        Pre-filled from{' '}
                        <span className="font-semibold tabular-nums">
                          {selectedDept.count}
                        </span>{' '}
                        {selectedDept.count === 1 ? 'peer' : 'peers'} in{' '}
                        <span className="font-semibold">
                          {selectedDept.department}
                        </span>{' '}
                        — change anytime.
                      </span>
                      <button
                        type="button"
                        onClick={() => setAutofilled(false)}
                        className="ml-auto rounded-full p-0.5 text-emerald-700/70 transition-colors hover:bg-emerald-200/60 hover:text-emerald-900 dark:text-emerald-300/70 dark:hover:bg-emerald-800/40 dark:hover:text-emerald-50"
                        aria-label="Dismiss"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="grid gap-4 sm:grid-cols-3">
                  <FormField label="Regular rate" trailing={<UnitChip>per hr</UnitChip>}>
                    <CurrencyInput
                      value={form.regular_rate}
                      onChange={(v) => onRateChange('regular_rate', v)}
                      placeholder="120.00"
                    />
                  </FormField>
                  <FormField label="OT rate" trailing={<UnitChip>per hr</UnitChip>}>
                    <CurrencyInput
                      value={form.ot_rate}
                      onChange={(v) => onRateChange('ot_rate', v)}
                      placeholder="156.00"
                    />
                  </FormField>
                  <FormField label="Start date" icon={Calendar}>
                    <FieldInput
                      type="date"
                      value={form.start_date}
                      onChange={(e) => update({ start_date: e.target.value })}
                    />
                  </FormField>
                </div>
              </SectionStep>

              {/* ─── 04 Optional ───────────────────────────────────── */}
              <SectionStep
                number="04"
                label="Anything else?"
                sublabel="optional"
                delay={0.15}
                terminal
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="Phone" icon={Phone}>
                    <FieldInput
                      value={form.phone}
                      onChange={(e) => update({ phone: e.target.value })}
                      placeholder="+63 9XX XXX XXXX"
                    />
                  </FormField>
                  <FormField label="Location" icon={MapPin}>
                    <FieldInput
                      value={form.location}
                      onChange={(e) => update({ location: e.target.value })}
                      placeholder="City, Province"
                    />
                  </FormField>
                </div>

                <div className="mt-4">
                  <FormField label="Notes for HR" icon={NotebookPen}>
                    <textarea
                      value={form.notes}
                      onChange={(e) => update({ notes: e.target.value })}
                      rows={3}
                      placeholder="Interview date, orientation cohort, anything HR should remember."
                      className={cn(
                        'w-full resize-y rounded-xl border border-zinc-200/90 bg-white/70 px-4 py-3 text-[13px] leading-relaxed text-zinc-900 placeholder:text-zinc-400',
                        'transition-colors focus:border-emerald-500 focus:bg-white focus:outline-none focus:ring-3 focus:ring-emerald-500/15',
                        'dark:border-zinc-700/80 dark:bg-zinc-900/50 dark:text-zinc-100 dark:placeholder:text-zinc-500',
                        'dark:focus:border-emerald-500 dark:focus:bg-zinc-900',
                      )}
                    />
                  </FormField>
                </div>
              </SectionStep>
            </Timeline>
          </div>

          <FormFooter
            submitting={submitting}
            isValid={isValid}
            missing={missing}
            onCancel={() => onOpenChange(false)}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Hero                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

function DialogHero() {
  return (
    <div className="relative overflow-hidden border-b border-emerald-100/80 px-6 pb-5 pt-7 dark:border-emerald-900/55 sm:px-9 sm:pt-8">
      {/* Soft glow blobs */}
      <div
        className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-gradient-to-br from-emerald-200/70 via-teal-200/50 to-transparent blur-2xl dark:from-emerald-700/45 dark:via-teal-800/30"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-12 left-[28%] h-24 w-40 rounded-full bg-emerald-300/30 blur-2xl dark:bg-emerald-800/25"
        aria-hidden
      />
      {/* Faint grid pattern */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04] dark:opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          color: '#10b981',
        }}
        aria-hidden
      />

      <div className="relative flex items-start gap-4">
        <motion.div
          initial={{ scale: 0.85, opacity: 0, rotate: -8 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 text-white shadow-lg shadow-emerald-600/35"
        >
          <UserPlus className="h-5 w-5" strokeWidth={2.25} />
        </motion.div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-700/90 dark:text-emerald-400/90">
            <span className="h-px w-4 bg-emerald-400/70 dark:bg-emerald-500/70" />
            HR · Onboarding
          </div>

          <DialogTitle className="text-[22px] font-semibold leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">
            Add a new hire
          </DialogTitle>

          <DialogDescription className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            Stage their record here. They’ll land on the master list — and
            in payroll, manager, and orphanage views — once you promote.
          </DialogDescription>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Timeline + Section Step                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function Timeline({ children }: { children: ReactNode }) {
  return <div className="relative space-y-7 pt-6">{children}</div>;
}

function SectionStep({
  number,
  label,
  sublabel,
  delay = 0,
  terminal,
  children,
}: {
  number: string;
  label: string;
  sublabel?: string;
  delay?: number;
  terminal?: boolean;
  children: ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="relative grid grid-cols-[40px_minmax(0,1fr)] gap-x-5 sm:grid-cols-[56px_minmax(0,1fr)] sm:gap-x-6"
    >
      {/* Number gutter — circle + ink line */}
      <div className="relative flex flex-col items-center">
        <div className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full border border-emerald-200 bg-white font-mono text-[11px] font-semibold tracking-tight text-emerald-700 shadow-sm shadow-emerald-500/10 dark:border-emerald-800 dark:bg-zinc-950 dark:text-emerald-400 dark:shadow-emerald-900/30">
          {number}
        </div>
        {!terminal && (
          <div
            className="mt-2 w-px flex-1 bg-gradient-to-b from-emerald-200/90 via-emerald-100/70 to-transparent dark:from-emerald-800/80 dark:via-emerald-900/50"
            aria-hidden
          />
        )}
      </div>

      {/* Content column */}
      <div className="min-w-0 pb-1">
        <div className="mb-3 flex items-baseline gap-2">
          <h3 className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {label}
          </h3>
          {sublabel && (
            <span className="text-[11px] font-medium italic text-zinc-400 dark:text-zinc-500">
              · {sublabel}
            </span>
          )}
        </div>
        <div>{children}</div>
      </div>
    </motion.section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Form field wrapper                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function FormField({
  label,
  icon: Icon,
  required,
  hint,
  error,
  trailing,
  children,
}: {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  required?: boolean;
  hint?: string;
  error?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700 dark:text-zinc-300">
          {Icon && (
            <Icon className="h-3.5 w-3.5 text-emerald-600/85 dark:text-emerald-400/85" />
          )}
          <span>{label}</span>
          {required && (
            <span className="ml-0.5 text-emerald-600 dark:text-emerald-400">
              *
            </span>
          )}
        </label>
        {trailing}
      </div>
      {children}
      {error ? (
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-rose-600 dark:text-rose-400">
          <span className="inline-block h-1 w-1 rounded-full bg-rose-500 dark:bg-rose-400" />
          {error}
        </span>
      ) : hint ? (
        <span className="text-[11px] leading-relaxed italic text-zinc-500 dark:text-zinc-500">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function TrailingChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-zinc-200 bg-white/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400">
      {children}
    </span>
  );
}

function UnitChip({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10.5px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
      {children}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Inputs                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

const FIELD_INPUT_BASE = cn(
  'h-10 w-full rounded-xl border border-zinc-200/90 bg-white/70 px-3.5 text-[13px] text-zinc-900',
  'placeholder:text-zinc-400 transition-colors',
  'focus:border-emerald-500 focus:bg-white focus:outline-none focus:ring-3 focus:ring-emerald-500/15',
  'aria-invalid:border-rose-400 aria-invalid:bg-rose-50/40 aria-invalid:ring-rose-500/15',
  'dark:border-zinc-700/80 dark:bg-zinc-900/50 dark:text-zinc-100 dark:placeholder:text-zinc-500',
  'dark:focus:bg-zinc-900 dark:focus:border-emerald-500',
  'dark:aria-invalid:border-rose-500 dark:aria-invalid:bg-rose-950/30',
);

function FieldInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(FIELD_INPUT_BASE, props.className)} />;
}

function CurrencyInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 select-none font-mono text-[13px] font-semibold text-emerald-600/80 dark:text-emerald-400/80">
        ₱
      </span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(FIELD_INPUT_BASE, 'pl-7 tabular-nums')}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Department picker — Base-UI Select with rich rows                          */
/* ────────────────────────────────────────────────────────────────────────── */

function DepartmentPicker({
  value,
  onChange,
  onBlur,
  departments,
  loading,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  departments: DepartmentRateSummary[];
  loading: boolean;
}) {
  const selected = departments.find((d) => d.department === value);

  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => v && onChange(v)}
      disabled={loading}
    >
      <SelectTrigger
        size="default"
        onBlur={onBlur}
        className={cn(
          'group/picker w-full rounded-xl border-zinc-200/90 bg-white/70 px-3.5 text-[13px]',
          'data-[size=default]:h-10',
          'hover:border-emerald-300 dark:hover:border-emerald-700',
          'data-[popup-open]:border-emerald-500 data-[popup-open]:bg-white data-[popup-open]:ring-3 data-[popup-open]:ring-emerald-500/15',
          'dark:border-zinc-700/80 dark:bg-zinc-900/50 dark:data-[popup-open]:bg-zinc-900',
          !value && 'data-placeholder:text-zinc-400',
        )}
      >
        <SelectValue
          placeholder={loading ? 'Loading departments…' : 'Pick a department'}
        >
          {value && (
            <span className="flex w-full items-center justify-between gap-3">
              <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                {value}
              </span>
              {selected?.regular_rate ? (
                <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 font-mono text-[10.5px] text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                  ₱{selected.regular_rate}/hr
                </span>
              ) : null}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>

      <SelectContent
        className="max-h-72 overflow-hidden rounded-xl border border-emerald-100/80 bg-white p-0 shadow-2xl shadow-emerald-950/10 dark:border-emerald-900/60 dark:bg-zinc-950 dark:shadow-black/50"
        alignItemWithTrigger={false}
        sideOffset={6}
      >
        <div className="max-h-72 overflow-y-auto p-1.5">
          {departments.length === 0 && !loading && (
            <div className="px-3 py-6 text-center text-[12px] italic text-zinc-500">
              No departments on file yet.
            </div>
          )}
          {departments.map((d) => (
            <SelectItem
              key={d.department}
              value={d.department}
              className="rounded-lg px-3 py-2.5 data-[highlighted]:bg-emerald-50 data-[highlighted]:text-emerald-950 dark:data-[highlighted]:bg-emerald-950/50 dark:data-[highlighted]:text-emerald-50"
            >
              <div className="flex w-full items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                    {d.department}
                  </span>
                  <span className="text-[10.5px] text-zinc-500 dark:text-zinc-500">
                    {d.count} {d.count === 1 ? 'employee' : 'employees'} on file
                  </span>
                </div>
                {d.regular_rate ? (
                  <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 font-mono text-[10.5px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                    ₱{d.regular_rate}/hr
                  </span>
                ) : (
                  <span className="shrink-0 text-[10px] italic text-zinc-400">
                    no rate set
                  </span>
                )}
              </div>
            </SelectItem>
          ))}
        </div>
      </SelectContent>
    </Select>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Sticky footer                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function FormFooter({
  submitting,
  isValid,
  missing,
  onCancel,
}: {
  submitting: boolean;
  isValid: boolean;
  missing: string[];
  onCancel: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-emerald-100/80 bg-white/85 px-6 py-3.5 backdrop-blur-md dark:border-emerald-900/45 dark:bg-[#0d1117]/85 sm:px-9">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 text-[11.5px]">
          {submitting ? (
            <span className="inline-flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving…
            </span>
          ) : isValid ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              Ready to save.
            </span>
          ) : missing.length > 0 ? (
            <span className="italic text-zinc-500 dark:text-zinc-500">
              Still need: {missing.join(', ')}.
            </span>
          ) : (
            <span className="italic text-zinc-500 dark:text-zinc-500">
              Fill the required fields above.
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={submitting}
            className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Cancel
          </Button>

          <Button
            type="submit"
            size="lg"
            disabled={submitting || !isValid}
            className={cn(
              'group/cta relative h-9 gap-1.5 overflow-hidden rounded-xl border-emerald-700/30 bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 px-4 text-white shadow-md shadow-emerald-600/30 transition-all',
              'hover:shadow-lg hover:shadow-emerald-600/45',
              'disabled:opacity-50 disabled:shadow-none',
            )}
          >
            {/* Shine sweep on hover */}
            <span
              className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 ease-out group-hover/cta:translate-x-full"
              aria-hidden
            />
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <UserPlus className="h-3.5 w-3.5" />
            )}
            <span className="relative">
              {submitting ? 'Saving' : 'Add to pending hires'}
            </span>
            {!submitting && (
              <ArrowRight
                className="h-3.5 w-3.5 -translate-x-1 opacity-0 transition-all duration-300 group-hover/cta:translate-x-0 group-hover/cta:opacity-100"
                aria-hidden
              />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
