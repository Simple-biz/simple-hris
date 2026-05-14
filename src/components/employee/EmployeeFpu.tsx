'use client';

import React, { useMemo, useState } from 'react';
import {
  GraduationCap,
  CalendarDays,
  Clock,
  CalendarRange,
  CalendarClock,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Mail,
  User,
  Building2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface Props {
  employeeEmail: string;
  employeeName?: string | null;
  department?: string | null;
  /** Hire date as stored in global_master_list (MM/DD/YY or ISO). Used to gate
   *  the form behind the 3-month tenure requirement. */
  startDate?: string | null;
  /** When true, omits the standalone page wrapper (background/padding/scroll
   *  container) so the page can be embedded inside another scroll container. */
  embedded?: boolean;
}

/** Parse the master-list start date (MM/DD/YY or YYYY-MM-DD). Returns null on garbage. */
function parseStartDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // MM/DD/YY or MM/DD/YYYY
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (slash) {
    const mm = +slash[1];
    const dd = +slash[2];
    let yy = +slash[3];
    if (yy < 100) yy += yy < 70 ? 2000 : 1900;
    const d = new Date(yy, mm - 1, dd);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const d = new Date(+iso[1], +iso[2] - 1, +iso[3]);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** Months elapsed between `from` and `to` (date-aware, not 30-day buckets). */
function monthsBetween(from: Date, to: Date): number {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return months;
}

type FormState = {
  email: string;
  fullName: string;
  department: string;
  shiftSchedule: string;
};

const CLASS_DETAILS = [
  { icon: CalendarDays, label: 'Start Date', value: 'April 24, 2025' },
  { icon: CalendarRange, label: 'Duration', value: '6 weeks · April 24 – May 29, 2025' },
  { icon: Clock, label: 'Session Length', value: 'Approximately 2 hours per session (may vary)' },
  { icon: CalendarClock, label: 'Schedule', value: 'Every Thursday EST 5:00 PM · Friday PHT 5:00 AM' },
];

export default function EmployeeFpu({
  employeeEmail,
  employeeName,
  department,
  startDate,
  embedded = false,
}: Props) {
  const [form, setForm] = useState<FormState>({
    email: employeeEmail ?? '',
    fullName: employeeName ?? '',
    department: department ?? '',
    shiftSchedule: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const update = (key: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Tenure gate — the FPU info sheet requires ≥ 3 months in Simple. We compute
  // calendar-month tenure from the master-list start_date. If start_date is
  // missing we fail OPEN (don't punish people with bad records).
  const start = useMemo(() => parseStartDate(startDate ?? null), [startDate]);
  const tenureMonths = useMemo(
    () => (start ? monthsBetween(start, new Date()) : null),
    [start],
  );
  const tenureMet = tenureMonths == null || tenureMonths >= 3;
  const monthsRemaining =
    tenureMonths != null && tenureMonths < 3 ? Math.max(0, 3 - tenureMonths) : 0;

  const canSubmit =
    tenureMet &&
    !!form.email.trim() &&
    !!form.fullName.trim() &&
    !!form.department.trim() &&
    !!form.shiftSchedule.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/fpu-enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email.trim(),
          full_name: form.fullName.trim(),
          department: form.department.trim(),
          shift_schedule_est: form.shiftSchedule.trim(),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setSubmitted(true);
      toast.success('FPU enrollment submitted', {
        description: 'We received your details — see you in class!',
      });
    } catch (err) {
      toast.error('Could not submit enrollment', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    const successCard = (
      <div className="mx-auto w-full max-w-2xl">
        <Card className="border-teal-100/80 bg-gradient-to-br from-teal-50/60 to-emerald-50/40 shadow-sm dark:border-teal-900/40 dark:from-teal-950/30 dark:to-emerald-950/20">
            <CardContent className="p-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-white text-teal-600 shadow-sm ring-1 ring-teal-100 dark:bg-teal-950/60 dark:text-teal-300 dark:ring-teal-900/60">
                <CheckCircle2 className="h-7 w-7" />
              </div>
              <h2 className="mt-4 text-xl font-bold text-zinc-900 dark:text-white">
                You’re enrolled — see you in class!
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                Thank you for signing up for Financial Peace University. We’ll follow up by
                email with calendar invites and pre-class reading. Once you complete the
                6-week course you’ll be eligible to join the next MESA enrollment window.
              </p>
            </CardContent>
          </Card>
      </div>
    );
    return embedded ? (
      successCard
    ) : (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-teal-50/30 to-emerald-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
        {successCard}
      </div>
    );
  }

  const body = (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      {/* Hero */}
        <div className="overflow-hidden rounded-2xl border border-orange-100/80 bg-gradient-to-br from-slate-700 via-slate-600 to-sky-700 p-6 text-white shadow-sm sm:p-8 dark:border-blue-950/60 dark:from-slate-900 dark:via-slate-800 dark:to-blue-950">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 text-white ring-1 ring-white/25 backdrop-blur-sm">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                Financial Peace University
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
                Sign Up
              </h2>
            </div>
          </div>
        </div>

        {/* Welcome */}
        <Card className="border-orange-100/80 shadow-sm dark:border-blue-950/60">
          <CardContent className="space-y-4 p-5 sm:p-6">
            <div>
              <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
                Welcome to Financial Peace University!
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                We are thrilled to welcome you to our upcoming class. Financial Peace
                University is dedicated to providing you with the tools and knowledge to
                achieve financial freedom and peace of mind. As you prepare to embark on this
                journey with us, please review the details below and complete the survey to
                confirm your enrollment.
              </p>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300">
                Class details
              </p>
              <ul className="mt-2 space-y-2">
                {CLASS_DETAILS.map((d) => (
                  <li
                    key={d.label}
                    className="flex items-start gap-3 rounded-lg border border-zinc-100 bg-white p-3 dark:border-zinc-800/80 dark:bg-zinc-900/40"
                  >
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-orange-50 text-orange-600 ring-1 ring-orange-100 dark:bg-orange-950/40 dark:text-orange-300 dark:ring-orange-900/40">
                      <d.icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                        {d.label}
                      </p>
                      <p className="mt-0.5 text-sm text-zinc-900 dark:text-zinc-100">
                        {d.value}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-lg border border-amber-200/80 bg-amber-50/70 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
                <AlertTriangle className="h-4 w-4" />
                Important
              </h4>
              <ul className="mt-2 space-y-1.5 pl-6 text-sm leading-relaxed text-amber-900/90 dark:text-amber-100/90">
                <li className="list-disc">
                  Should be at least{' '}
                  <strong className="font-semibold italic underline">3 months</strong> in
                  Simple to join.
                </li>
                <li className="list-disc">
                  If you are <strong>uncertain</strong> about your schedule or availability for
                  the entire duration of the course, we recommend that you{' '}
                  <strong>do not enroll at this time</strong>.
                </li>
              </ul>
            </div>

            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              To complete your enrollment, please provide the following information.
            </p>
          </CardContent>
        </Card>

        {/* Tenure-gate banner */}
        {!tenureMet && (
          <div className="rounded-lg border border-rose-200/80 bg-rose-50/70 p-4 dark:border-rose-500/30 dark:bg-rose-500/10">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-rose-900 dark:text-rose-100">
              <AlertTriangle className="h-4 w-4" />
              You’re not yet eligible to enroll
            </h4>
            <p className="mt-1.5 text-sm leading-relaxed text-rose-900/90 dark:text-rose-100/90">
              FPU enrollment requires at least{' '}
              <strong className="font-semibold">3 months</strong> of tenure at Simple. You
              currently have <strong>{tenureMonths ?? 0}</strong>{' '}
              {tenureMonths === 1 ? 'month' : 'months'} — you’ll be eligible in roughly{' '}
              <strong>{monthsRemaining}</strong>{' '}
              {monthsRemaining === 1 ? 'month' : 'months'}.
              {start && (
                <>
                  {' '}Your hire date on file is{' '}
                  <span className="font-mono">{start.toLocaleDateString()}</span>.
                </>
              )}
            </p>
          </div>
        )}

        {/* Form */}
        <Card
          className={cn(
            'border-orange-100/80 shadow-sm transition-[opacity,filter] duration-200 dark:border-blue-950/60',
            !tenureMet && 'pointer-events-none select-none opacity-50 grayscale',
          )}
          aria-disabled={!tenureMet}
        >
          <CardContent className="p-5 sm:p-6">
            <form
              className="space-y-5"
              onSubmit={handleSubmit}
            >
              <Field
                id="fpu-email"
                label="Simple.biz Email"
                icon={Mail}
                required
                type="email"
                placeholder="you@simple.biz"
                value={form.email}
                onChange={(v) => update('email', v)}
                disabled={!tenureMet}
              />
              <Field
                id="fpu-name"
                label="Full Name"
                icon={User}
                required
                placeholder="Your full name"
                value={form.fullName}
                onChange={(v) => update('fullName', v)}
                disabled={!tenureMet}
              />
              <Field
                id="fpu-dept"
                label="Department"
                icon={Building2}
                required
                placeholder="e.g. Accounting, HSL, AI/API Team"
                value={form.department}
                onChange={(v) => update('department', v)}
                disabled={!tenureMet}
              />
              <Field
                id="fpu-shift"
                label="Shift Schedule (EST)"
                icon={Clock}
                required
                placeholder="e.g. 9:00 AM – 5:00 PM EST"
                value={form.shiftSchedule}
                onChange={(v) => update('shiftSchedule', v)}
                highlight
                disabled={!tenureMet}
              />

              <div className="flex flex-wrap items-center justify-end gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800/80">
                <p className="mr-auto text-xs text-zinc-500 dark:text-zinc-500">
                  <span className="text-rose-500">*</span> Required
                </p>
                <Button
                  type="submit"
                  disabled={!canSubmit || submitting}
                  className="bg-orange-500 text-white shadow-sm hover:bg-orange-600 focus-visible:ring-orange-500/40 dark:bg-orange-500 dark:hover:bg-orange-400"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      Submitting…
                    </>
                  ) : (
                    'Submit enrollment'
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
    </div>
  );

  return embedded ? (
    body
  ) : (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      {body}
    </div>
  );
}

function Field({
  id,
  label,
  icon: Icon,
  required,
  type = 'text',
  placeholder,
  value,
  onChange,
  highlight = false,
  disabled = false,
}: {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  required?: boolean;
  type?: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  highlight?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      className={`space-y-1.5 ${
        highlight
          ? '-mx-2 rounded-lg bg-zinc-50 px-2 py-2 dark:bg-zinc-900/40'
          : ''
      }`}
    >
      <Label
        htmlFor={id}
        className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-white"
      >
        <Icon className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
        {label}
        {required && <span className="text-rose-500">*</span>}
      </Label>
      <Input
        id={id}
        type={type}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 border-zinc-200 bg-white text-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900/60 dark:focus:border-orange-400"
      />
    </div>
  );
}
