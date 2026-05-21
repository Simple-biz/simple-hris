'use client';

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { CheckIcon, ChevronDownIcon, Loader2, UserPlus } from 'lucide-react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { HrPendingEmployeeRow } from '@/lib/supabase/hr-pending-employees';

interface HubstaffProject {
  id: string | number;
  name: string;
}

interface DeptRate {
  department: string;
  regular_rate: string | null;
  ot_rate: string | null;
}

interface AddPersonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (row: HrPendingEmployeeRow) => void;
}

type FormState = {
  name: string;
  personal_email: string;
  work_email: string;
  department: string;
  job_description: string;
  job_description_custom: string;
  start_date: string;
  source: string;
  phone: string;
  location: string;
  regular_rate: string;
  ot_rate: string;
  notes: string;
};

type RequiredKey = 'name' | 'personal_email' | 'work_email' | 'department';
type FieldErrors = Partial<Record<RequiredKey, string>>;

const JOB_TITLES = [
  'Case Manager',
  'Team Leader',
  'Quality Analyst',
  'Editor',
  'Data Entry Specialist',
  'Customer Service Representative',
  'HR Coordinator',
  'Payroll Coordinator',
  'Developer',
  'Designer',
  'Marketing Coordinator',
  'Administrative Assistant',
  'Supervisor',
  'Operations Manager',
  'Other',
];

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const buildEmptyForm = (): FormState => ({
  name: '',
  personal_email: '',
  work_email: '',
  department: '',
  job_description: '',
  job_description_custom: '',
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

export default function AddPersonDialog({
  open,
  onOpenChange,
  onCreated,
}: AddPersonDialogProps) {
  const [form, setForm] = useState<FormState>(buildEmptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [departments, setDepartments] = useState<HubstaffProject[]>([]);
  const [departmentsLoading, setDepartmentsLoading] = useState(false);
  const [deptRates, setDeptRates] = useState<DeptRate[]>([]);
  const [touched, setTouched] = useState<Set<RequiredKey>>(new Set());

  useEffect(() => {
    if (!open || departments.length > 0 || departmentsLoading) return;
    setDepartmentsLoading(true);
    Promise.all([
      fetch('/api/secondary/hubstaff-projects', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/hr/department-rates', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(([dj, rj]: [{ projects?: HubstaffProject[]; error?: string }, { departments?: DeptRate[]; error?: string }]) => {
        if (dj.error) throw new Error(dj.error);
        setDepartments(dj.projects ?? []);
        setDeptRates(rj.departments ?? []);
      })
      .catch((e) =>
        toast.error(e instanceof Error ? e.message : 'Could not load departments'),
      )
      .finally(() => setDepartmentsLoading(false));
  }, [open, departments.length, departmentsLoading]);

  useEffect(() => {
    if (!open) {
      setForm(buildEmptyForm());
      setTouched(new Set());
    }
  }, [open]);

  const update = (patch: Partial<FormState>) =>
    setForm((p) => ({ ...p, ...patch }));

  const markTouched = (k: RequiredKey) =>
    setTouched((s) => (s.has(k) ? s : new Set(s).add(k)));

  const onDepartmentChange = (next: string) => {
    const match = deptRates.find(
      (r) => r.department.trim().toLowerCase() === next.trim().toLowerCase(),
    );
    setForm((prev) => ({
      ...prev,
      department: next,
      regular_rate: match?.regular_rate ?? prev.regular_rate,
      ot_rate: match?.ot_rate ?? prev.ot_rate,
    }));
    markTouched('department');
  };

  const errors: FieldErrors = useMemo(() => {
    const e: FieldErrors = {};
    if (!form.name.trim()) e.name = 'Required';
    if (!form.personal_email.trim()) e.personal_email = 'Required';
    else if (!isPlausibleEmail(form.personal_email))
      e.personal_email = "Doesn't look like an email";
    if (form.work_email && !isPlausibleEmail(form.work_email))
      e.work_email = "Doesn't look like an email";
    if (!form.department.trim()) e.department = 'Required';
    return e;
  }, [form]);

  const isValid = Object.keys(errors).length === 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isValid) {
      setTouched(new Set(['name', 'personal_email', 'work_email', 'department']));
      const first = errors.name || errors.personal_email || errors.work_email || errors.department;
      if (first) toast.error(first);
      return;
    }
    setSubmitting(true);
    const resolvedJob =
      form.job_description === 'Other'
        ? form.job_description_custom.trim()
        : form.job_description.trim();
    try {
      const res = await fetch('/api/hr/pending-employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          personal_email: form.personal_email.trim(),
          work_email: form.work_email.trim() || null,
          department: form.department.trim(),
          job_description: resolvedJob || null,
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
            : 'Ready to promote when you confirm orientation.',
      });
      onCreated(json.row);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="pb-1">
          <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-sm">
              <UserPlus className="h-3.5 w-3.5" />
            </span>
            Add new hire
          </DialogTitle>
          <p className="text-[12px] text-muted-foreground">
            Staged hire — visible in payroll once promoted.
          </p>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate>
          {/* ── Identity */}
          <Section label="Identity">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Full name"
                required
                error={touched.has('name') ? errors.name : undefined}
              >
                <Input
                  value={form.name}
                  onChange={(e) => update({ name: e.target.value })}
                  onBlur={() => markTouched('name')}
                  placeholder="Last, First"
                  autoFocus
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={form.phone}
                  onChange={(e) => update({ phone: e.target.value })}
                  placeholder="+63 9XX XXX XXXX"
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Personal email"
                required
                error={touched.has('personal_email') ? errors.personal_email : undefined}
              >
                <Input
                  type="email"
                  value={form.personal_email}
                  onChange={(e) => update({ personal_email: e.target.value })}
                  onBlur={() => markTouched('personal_email')}
                  placeholder="name@gmail.com"
                />
              </Field>
              <Field
                label="Work email"
                hint="Leave blank if not minted yet. Off-boarded addresses are free to reuse."
                error={touched.has('work_email') ? errors.work_email : undefined}
              >
                <Input
                  type="email"
                  value={form.work_email}
                  onChange={(e) => update({ work_email: e.target.value })}
                  onBlur={() => markTouched('work_email')}
                  placeholder="namel@simple.biz"
                />
              </Field>
            </div>
          </Section>

          {/* ── Role */}
          <Section label="Role">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Department"
                required
                error={touched.has('department') ? errors.department : undefined}
              >
                {/* Custom dept select — rate badge lives outside ItemText so it
                    doesn't get squished by Base-UI's whitespace-nowrap wrapper */}
                <SelectPrimitive.Root
                  value={form.department}
                  onValueChange={(v) => v && onDepartmentChange(v)}
                  disabled={departmentsLoading}
                >
                  <SelectPrimitive.Trigger
                    onBlur={() => markTouched('department')}
                    className={cn(
                      'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none select-none dark:border-input',
                      'data-placeholder:text-muted-foreground',
                      'hover:border-zinc-400 dark:hover:border-zinc-500',
                      'focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                      'dark:bg-input/30',
                    )}
                  >
                    <SelectPrimitive.Value
                      placeholder={departmentsLoading ? 'Loading…' : 'Select department'}
                      className="flex-1 text-left"
                    />
                    <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </SelectPrimitive.Trigger>
                  <SelectPrimitive.Portal>
                    <SelectPrimitive.Positioner side="bottom" sideOffset={4} alignItemWithTrigger className="isolate z-50">
                      <SelectPrimitive.Popup className="w-(--anchor-width) min-w-48 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-black/8 dark:border-zinc-700 dark:bg-zinc-900 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                        <SelectPrimitive.ScrollUpArrow className="flex w-full cursor-default items-center justify-center bg-white py-1 dark:bg-zinc-900">
                          <ChevronDownIcon className="h-3.5 w-3.5 rotate-180 text-zinc-400" />
                        </SelectPrimitive.ScrollUpArrow>
                        <SelectPrimitive.List className="max-h-64 overflow-y-auto p-1">
                          {departments.length === 0 && !departmentsLoading && (
                            <div className="px-3 py-4 text-center text-xs italic text-muted-foreground">
                              No departments on file yet.
                            </div>
                          )}
                          {departments.map((d) => (
                            <SelectPrimitive.Item
                              key={String(d.id)}
                              value={d.name}
                              className={cn(
                                'relative flex w-full cursor-default items-center justify-between rounded-lg px-3 py-2 text-sm outline-none select-none',
                                'focus:bg-emerald-50 focus:text-emerald-900 dark:focus:bg-emerald-950/50 dark:focus:text-emerald-100',
                                'data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 dark:data-highlighted:bg-emerald-950/50 dark:data-highlighted:text-emerald-100',
                              )}
                            >
                              <SelectPrimitive.ItemText className="flex-1 truncate pr-2">
                                {d.name}
                              </SelectPrimitive.ItemText>
                              <SelectPrimitive.ItemIndicator className="flex h-4 w-4 items-center justify-center">
                                <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
                              </SelectPrimitive.ItemIndicator>
                            </SelectPrimitive.Item>
                          ))}
                        </SelectPrimitive.List>
                        <SelectPrimitive.ScrollDownArrow className="flex w-full cursor-default items-center justify-center bg-white py-1 dark:bg-zinc-900">
                          <ChevronDownIcon className="h-3.5 w-3.5 text-zinc-400" />
                        </SelectPrimitive.ScrollDownArrow>
                      </SelectPrimitive.Popup>
                    </SelectPrimitive.Positioner>
                  </SelectPrimitive.Portal>
                </SelectPrimitive.Root>
              </Field>

              <Field label="Job title">
                <SelectPrimitive.Root
                  value={form.job_description}
                  onValueChange={(v) => update({ job_description: v ?? '', job_description_custom: '' })}
                >
                  <SelectPrimitive.Trigger
                    className={cn(
                      'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none select-none dark:border-input',
                      'data-placeholder:text-muted-foreground',
                      'hover:border-zinc-400 dark:hover:border-zinc-500',
                      'focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
                      'dark:bg-input/30',
                    )}
                  >
                    <SelectPrimitive.Value placeholder="Select a title" className="flex-1 text-left" />
                    <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </SelectPrimitive.Trigger>
                  <SelectPrimitive.Portal>
                    <SelectPrimitive.Positioner side="bottom" sideOffset={4} alignItemWithTrigger className="isolate z-50">
                      <SelectPrimitive.Popup className="w-(--anchor-width) min-w-40 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-black/8 dark:border-zinc-700 dark:bg-zinc-900 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                        <SelectPrimitive.List className="max-h-56 overflow-y-auto p-1">
                          {JOB_TITLES.map((t) => (
                            <SelectPrimitive.Item
                              key={t}
                              value={t}
                              className={cn(
                                'relative flex w-full cursor-default items-center justify-between rounded-lg px-3 py-2 text-sm outline-none select-none',
                                'focus:bg-emerald-50 focus:text-emerald-900 dark:focus:bg-emerald-950/50 dark:focus:text-emerald-100',
                                'data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 dark:data-highlighted:bg-emerald-950/50 dark:data-highlighted:text-emerald-100',
                              )}
                            >
                              <SelectPrimitive.ItemText>{t}</SelectPrimitive.ItemText>
                              <SelectPrimitive.ItemIndicator className="flex h-4 w-4 shrink-0 items-center justify-center">
                                <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
                              </SelectPrimitive.ItemIndicator>
                            </SelectPrimitive.Item>
                          ))}
                        </SelectPrimitive.List>
                      </SelectPrimitive.Popup>
                    </SelectPrimitive.Positioner>
                  </SelectPrimitive.Portal>
                </SelectPrimitive.Root>
              </Field>
            </div>

            {form.job_description === 'Other' && (
              <Field label="Custom job title">
                <Input
                  value={form.job_description_custom}
                  onChange={(e) => update({ job_description_custom: e.target.value })}
                  placeholder="Type the job title"
                  autoFocus
                />
              </Field>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Location">
                <Input
                  value={form.location}
                  onChange={(e) => update({ location: e.target.value })}
                  placeholder="City, Province"
                />
              </Field>
              <Field label="Source">
                <Input
                  value={form.source}
                  onChange={(e) => update({ source: e.target.value })}
                  placeholder="Referral – Maria"
                />
              </Field>
            </div>
          </Section>

          {/* ── Compensation */}
          <Section label="Compensation">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Regular rate (₱/hr)">
                <Input
                  inputMode="decimal"
                  value={form.regular_rate}
                  onChange={(e) => update({ regular_rate: e.target.value })}
                  placeholder="120.00"
                />
              </Field>
              <Field label="OT rate (₱/hr)">
                <Input
                  inputMode="decimal"
                  value={form.ot_rate}
                  onChange={(e) => update({ ot_rate: e.target.value })}
                  placeholder="156.00"
                />
              </Field>
              <Field label="Start date">
                <Input
                  type="date"
                  value={form.start_date}
                  onChange={(e) => update({ start_date: e.target.value })}
                />
              </Field>
            </div>
          </Section>

          {/* ── Notes */}
          <Section label="Notes" last>
            <textarea
              value={form.notes}
              onChange={(e) => update({ notes: e.target.value })}
              rows={2}
              placeholder="Interview date, orientation cohort, anything HR should remember."
              className={cn(
                'w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm dark:border-input',
                'placeholder:text-muted-foreground',
                'focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20',
                'dark:bg-input/30',
              )}
            />
          </Section>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitting || !isValid}
              className="gap-1.5 bg-gradient-to-br from-emerald-500 to-teal-700 text-white hover:from-emerald-500 hover:to-teal-600 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserPlus className="h-3.5 w-3.5" />
              )}
              {submitting ? 'Saving…' : 'Add hire'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  label,
  last,
  children,
}: {
  label: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('space-y-3 pt-4', !last && 'border-b border-zinc-200 pb-4 dark:border-zinc-800')}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
        {label}
      </p>
      {children}
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-400">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </Label>
      {children}
      {error ? (
        <p className="text-[11px] text-rose-500">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-500">{hint}</p>
      ) : null}
    </div>
  );
}
