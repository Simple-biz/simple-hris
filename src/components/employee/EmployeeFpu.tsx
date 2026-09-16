'use client';

/**
 * Employee → MESA → FPU Class. One card: the current class, one line saying
 * whether this person may enroll (the server's verdict, painted), one button.
 * Governing doc: docs/features/fpu-enrollment.md.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { GraduationCap, Loader2, CheckCircle2, XCircle, Clock, Award, Ban } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatDateOnly } from '@/lib/date-only';
import { fpuClassLabel, fpuClassPhase, type FpuClass, type FpuEnrollmentStatus } from '@/lib/mesa/fpu-class';
import type { FpuVerdict } from '@/lib/mesa/fpu-eligibility';

interface Enrollment {
  id: string;
  class_id: string | null;
  status: FpuEnrollmentStatus;
  created_at: string;
  review_notes: string | null;
  completed_on: string | null;
  class_label?: string | null;
}

interface SelfState {
  today: string;
  class: FpuClass | null;
  enrollment: Enrollment | null;
  verdict: FpuVerdict;
  history: Enrollment[];
  fpuCompletedOn: string | null;
  isMesaMember: boolean;
  migrated: boolean;
  error: string | null;
}

interface Props {
  employeeEmail: string;
}

const fmt = (iso: string | null | undefined) => (iso ? formatDateOnly(iso) : '—');

export default function EmployeeFpu({ employeeEmail }: Props) {
  const [state, setState] = useState<SelfState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shift, setShift] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/fpu-enroll?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' });
      const text = await res.text();
      let json: SelfState;
      try {
        json = JSON.parse(text) as SelfState;
      } catch {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setState(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load FPU class');
    } finally {
      setLoading(false);
    }
  }, [employeeEmail]);

  useEffect(() => {
    void load();
  }, [load]);

  const enroll = async () => {
    if (!shift.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/fpu-enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: employeeEmail, shift_schedule_est: shift.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.success('Enrolled — HR will review it.');
      setShift('');
      await load();
    } catch (e) {
      toast.error('Could not enroll', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !state) {
    return (
      <div className="rounded-2xl border border-teal-100/80 bg-white/80 p-8 text-center text-sm text-zinc-500 shadow-sm dark:border-teal-900/40 dark:bg-zinc-900/40 dark:text-zinc-400">
        <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (error || !state) {
    return (
      <div className="rounded-lg border border-rose-200/80 bg-rose-50/70 px-4 py-3 text-sm text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100">
        {error ?? 'Could not load FPU class.'}
      </div>
    );
  }

  const cls = state.class;
  const phase = cls ? fpuClassPhase(cls, state.today) : null;
  const mine = state.enrollment;
  const past = state.history.filter((h) => !mine || h.id !== mine.id);

  return (
    <div className="space-y-4">
      {/* Class card */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-gradient-to-br from-slate-700 via-slate-600 to-sky-700 p-5 text-white shadow-sm sm:p-6 dark:border-blue-950/60 dark:from-slate-900 dark:via-slate-800 dark:to-blue-950">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/25">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">Financial Peace University</p>
              <h2 className="mt-0.5 text-xl font-bold tracking-tight sm:text-2xl">{cls ? fpuClassLabel(cls) : 'No class scheduled'}</h2>
            </div>
          </div>
          {phase && (
            <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ring-1', phase === 'open' ? 'bg-emerald-400/20 text-emerald-100 ring-emerald-300/40' : phase === 'upcoming' ? 'bg-sky-400/20 text-sky-100 ring-sky-300/40' : 'bg-white/10 text-white/70 ring-white/20')}>
              {phase === 'open' ? 'Enrollment open' : phase === 'upcoming' ? 'Opens soon' : 'Enrollment closed'}
            </span>
          )}
        </div>
        {cls && (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <Fact label="Enrollment" value={`${fmt(cls.opens_on)} – ${fmt(cls.closes_on)}`} />
            <Fact label="Class" value={cls.class_ends_on ? `${fmt(cls.class_starts_on)} – ${fmt(cls.class_ends_on)}` : `Starts ${fmt(cls.class_starts_on)}`} />
            <Fact label="Schedule" value={cls.schedule_note ?? 'To be announced'} />
          </dl>
        )}
      </div>

      {/* Status / action */}
      <Card className="border-teal-100/80 shadow-sm dark:border-teal-900/40">
        <CardContent className="p-5">
          {!state.migrated ? (
            <Line icon={Ban} tone="zinc">FPU enrollment is not open yet.</Line>
          ) : mine ? (
            <EnrollmentLine e={mine} />
          ) : state.verdict.ok ? (
            <div className="space-y-3">
              <Line icon={CheckCircle2} tone="emerald">You are eligible — with Simple since {fmt(state.verdict.startDate)}.</Line>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[220px] flex-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Your shift (EST)</span>
                  <Input value={shift} onChange={(e) => setShift(e.target.value)} placeholder="9:00 AM – 5:00 PM EST" disabled={submitting} className="mt-1 h-10" maxLength={120} />
                </label>
                <Button type="button" onClick={() => void enroll()} disabled={!shift.trim() || submitting} className="h-10 bg-orange-500 text-white hover:bg-orange-600 dark:bg-orange-500 dark:hover:bg-orange-400">
                  {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                  Enroll
                </Button>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Only enroll if you can attend the whole class. HR approves seats; completing the class enrolls you in MESA.</p>
            </div>
          ) : (
            <VerdictLine verdict={state.verdict} fpuCompletedOn={state.fpuCompletedOn} />
          )}
        </CardContent>
      </Card>

      {past.length > 0 && (
        <Card className="border-zinc-200/80 dark:border-zinc-800">
          <CardContent className="p-0">
            <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              {past.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">{h.class_label ?? 'FPU class'}</span>
                  <EnrollmentBadge status={h.status} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/10 px-3 py-2 ring-1 ring-white/15">
      <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-white/60">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-white">{value}</dd>
    </div>
  );
}

function Line({ icon: Icon, tone, children }: { icon: React.ComponentType<{ className?: string }>; tone: 'emerald' | 'amber' | 'rose' | 'zinc' | 'teal'; children: React.ReactNode }) {
  const cls = {
    emerald: 'text-emerald-700 dark:text-emerald-300',
    amber: 'text-amber-700 dark:text-amber-300',
    rose: 'text-rose-700 dark:text-rose-300',
    zinc: 'text-zinc-600 dark:text-zinc-400',
    teal: 'text-teal-700 dark:text-teal-300',
  }[tone];
  return (
    <p className={cn('flex items-start gap-2 text-sm font-medium', cls)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function EnrollmentLine({ e }: { e: Enrollment }) {
  switch (e.status) {
    case 'pending':
      return <Line icon={Clock} tone="amber">Enrolled {fmt(e.created_at.slice(0, 10))} — HR is reviewing your seat.</Line>;
    case 'approved':
      return <Line icon={CheckCircle2} tone="teal">You have a seat. See you in class.</Line>;
    case 'denied':
      return <Line icon={XCircle} tone="rose">Not this time{e.review_notes ? ` — ${e.review_notes}` : '.'}</Line>;
    case 'completed':
      return <Line icon={Award} tone="emerald">Completed {fmt(e.completed_on)} — you are in MESA.</Line>;
  }
}

function VerdictLine({ verdict, fpuCompletedOn }: { verdict: FpuVerdict; fpuCompletedOn: string | null }) {
  if (verdict.ok) return null;
  if (verdict.reason === 'already_completed') {
    return <Line icon={Award} tone="emerald">You completed FPU{fpuCompletedOn ? ` on ${fmt(fpuCompletedOn)}` : ''}. Use the Request tab for MESA.</Line>;
  }
  const tone = verdict.reason === 'closed' || verdict.reason === 'not_open_yet' || verdict.reason === 'no_class' ? 'zinc' : 'amber';
  return <Line icon={verdict.reason === 'closed' ? Ban : Clock} tone={tone}>{verdict.detail}</Line>;
}

function EnrollmentBadge({ status }: { status: FpuEnrollmentStatus }) {
  const cls = {
    pending: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200',
    approved: 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200',
    denied: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200',
    completed: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200',
  }[status];
  return <span className={cn('rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide', cls)}>{status}</span>;
}
