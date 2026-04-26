'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  RefreshCw,
  Send,
  XCircle,
} from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DEFAULT_DISPUTE_REASON_CODES,
  type PabDisputeReasonCode,
} from '@/lib/supabase/pab-dispute-reasons';
import type { PabDayDisputeRow } from '@/lib/supabase/pab-day-disputes';
import EmployeePabCalendar from './EmployeePabCalendar';

type Prefill = {
  date: string;
  /** Hours-worked in seconds, for display only. Optional. */
  seconds?: number;
};

type MyDisputesProps = {
  employeeEmail: string;
  employeeName?: string | null;
  prefill?: Prefill | null;
  /** Called once the prefill has been consumed so the parent can clear it. */
  onPrefillConsumed?: () => void;
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'border-amber-400/60 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300',
  approved: 'border-emerald-400/60 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-300',
  denied: 'border-rose-400/60 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-300',
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatLongDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function MyDisputes({
  employeeEmail,
  employeeName,
  prefill,
  onPrefillConsumed,
}: MyDisputesProps) {
  const [reasonCodes, setReasonCodes] = useState<PabDisputeReasonCode[]>(DEFAULT_DISPUTE_REASON_CODES);
  const [disputes, setDisputes] = useState<PabDayDisputeRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [disputeDate, setDisputeDate] = useState<string>(() => todayIso());
  const [reason, setReason] = useState<string>('orphanage_visit');
  const [explanation, setExplanation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** Bump to force the embedded PAB calendar to re-fetch its disputes after a successful submit. */
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(0);
  /** Hubstaff seconds for the currently-selected date — shown as a hint in the form. */
  const [prefilledHours, setPrefilledHours] = useState<number | null>(null);

  const formRef = useRef<HTMLFormElement | null>(null);

  // Load reason codes (settings → fallback to defaults)
  useEffect(() => {
    let cancelled = false;
    fetch('/api/app-settings?key=pab_dispute_reason_codes', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { value: string | null }) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(json.value ?? 'null') as unknown;
          if (Array.isArray(parsed) && parsed.length > 0) {
            const filtered = parsed.filter(
              (r): r is PabDisputeReasonCode =>
                typeof r === 'object' && r !== null && typeof (r as { code?: unknown }).code === 'string',
            );
            if (filtered.length > 0) setReasonCodes(filtered);
          }
        } catch {
          // keep defaults
        }
      })
      .catch(() => {
        // keep defaults
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load existing disputes for this employee
  const loadDisputes = useCallback(async () => {
    setListError(null);
    try {
      const res = await fetch(
        `/api/pab-disputes?email=${encodeURIComponent(employeeEmail)}&limit=200`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { rows?: PabDayDisputeRow[]; error?: string | null };
      if (!res.ok) throw new Error(json.error ?? 'Failed to load disputes');
      setDisputes(json.rows ?? []);
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Failed to load disputes');
      setDisputes([]);
    }
  }, [employeeEmail]);

  useEffect(() => {
    setListLoading(true);
    loadDisputes().finally(() => setListLoading(false));
  }, [loadDisputes]);

  // Apply prefill (from dashboard redirect): set date, scroll the form into view, focus reason
  useEffect(() => {
    if (!prefill) return;
    setDisputeDate(prefill.date);
    setReason((prev) => prev || 'orphanage_visit');
    setPrefilledHours(prefill.seconds ?? null);
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  // Inline calendar click → drop the date+hours into the form
  const handleCalendarCellClick = useCallback(
    (payload: { date: string; seconds: number; dispute: PabDayDisputeRow | null }) => {
      setDisputeDate(payload.date);
      setPrefilledHours(payload.seconds);
      if (!payload.dispute) {
        setReason((prev) => prev || 'orphanage_visit');
      }
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    [],
  );

  const existingForSelectedDate = useMemo(
    () => disputes.find((d) => d.dispute_date === disputeDate) ?? null,
    [disputes, disputeDate],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadDisputes();
    } finally {
      setRefreshing(false);
    }
  }, [loadDisputes]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!disputeDate) {
        toast.error('Pick a date for the dispute');
        return;
      }
      if (!reason) {
        toast.error('Select a main reason');
        return;
      }
      if (reason === 'other' && !explanation.trim()) {
        toast.error('Please describe the reason in the explanation');
        return;
      }
      if (existingForSelectedDate) {
        toast.error('A dispute for that date already exists');
        return;
      }
      setSubmitting(true);
      try {
        const res = await fetch('/api/pab-disputes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            work_email: employeeEmail,
            dispute_date: disputeDate,
            reason,
            explanation: explanation.trim() || null,
            created_by: employeeName ?? employeeEmail,
          }),
        });
        const json = (await res.json()) as { error?: string | null };
        if (!res.ok) throw new Error(json.error ?? 'Failed to submit dispute');
        toast.success('Dispute submitted', {
          description: 'Your dispute is now pending review.',
        });
        setExplanation('');
        setPrefilledHours(null);
        setCalendarRefreshKey((k) => k + 1);
        await loadDisputes();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to submit dispute');
      } finally {
        setSubmitting(false);
      }
    },
    [disputeDate, reason, explanation, existingForSelectedDate, employeeEmail, employeeName, loadDisputes],
  );

  const counts = useMemo(() => {
    return disputes.reduce(
      (acc, d) => {
        acc[d.status] = (acc[d.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [disputes]);

  const reasonLabel = useCallback(
    (code: string) => reasonCodes.find((r) => r.code === code)?.label ?? code,
    [reasonCodes],
  );

  return (
    <div className="box-border flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-3 py-2 sm:px-4 sm:py-3 md:px-5 lg:py-3 dark:bg-none dark:bg-[#0d1117]">
      {/* Header */}
      <header className="flex shrink-0 flex-col gap-3 border-b border-zinc-200/70 pb-3 dark:border-zinc-800/70 lg:flex-row lg:items-end lg:justify-between lg:gap-6">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-amber-700/80 dark:text-amber-500/70">
            Employee
            <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">/</span>
            PAB Day Disputes
          </p>
          <h1 className="mt-1 font-mono text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl lg:text-[2.25rem] lg:leading-none dark:text-white">
            My Disputes
          </h1>
          <p className="mt-1.5 text-xs leading-snug text-zinc-500 dark:text-zinc-500">
            File a dispute for any day where your hours fell below the 7-hour PAB threshold. Approved
            disputes restore PAB eligibility for that day.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-zinc-200 bg-white/70 text-xs font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
            aria-label="Refresh disputes"
          >
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
            Refresh
          </Button>
        </div>
      </header>

      {/* Inline PAB calendar — same color/status grid as the Overview */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="shrink-0"
      >
        <EmployeePabCalendar
          employeeEmail={employeeEmail}
          refreshKey={calendarRefreshKey}
          onCellClick={handleCalendarCellClick}
          className="max-h-[22rem]"
        />
      </motion.div>

      {/* Body */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-5">
        {/* File-a-dispute form */}
        <motion.section
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col gap-3"
        >
          <form
            ref={formRef}
            onSubmit={handleSubmit}
            className="flex min-w-0 flex-col gap-3 rounded-xl border border-zinc-200/80 bg-white/70 p-4 shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900/40"
          >
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-400">
                File a Dispute
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                Pick the date and explain why hours dipped below 7. Supervisors review every submission
                manually.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="dispute-date" className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Date
              </label>
              <div className="relative">
                <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  id="dispute-date"
                  type="date"
                  value={disputeDate}
                  max={todayIso()}
                  onChange={(e) => {
                    setDisputeDate(e.target.value);
                    setPrefilledHours(null);
                  }}
                  className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 font-mono text-xs text-zinc-700 transition-colors focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:focus:border-emerald-400"
                />
              </div>
              {prefilledHours != null && (
                <p className="font-mono text-[10px] text-amber-700 dark:text-amber-400">
                  Hubstaff logged {(prefilledHours / 3600).toFixed(2)}h on this day.
                </p>
              )}
              {existingForSelectedDate && (
                <p className="rounded-md border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300">
                  A dispute already exists for this date — see the list on the right.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="dispute-reason" className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Main Reason
              </label>
              <select
                id="dispute-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 pr-8 text-xs text-zinc-700 transition-colors focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:focus:border-emerald-400"
              >
                {reasonCodes.map((rc) => (
                  <option key={rc.code} value={rc.code}>
                    {rc.label}
                  </option>
                ))}
              </select>
              <p className="text-[10px] leading-snug text-zinc-400 dark:text-zinc-500">
                Default is <span className="font-medium text-zinc-600 dark:text-zinc-400">Orphanage Visit</span>.
                Pick the closest match — health issues, power outage, intermittent internet, etc.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="dispute-explanation" className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Explanation {reason === 'other' ? <span className="text-rose-500">(required)</span> : <span className="text-zinc-400">(optional)</span>}
              </label>
              <textarea
                id="dispute-explanation"
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
                rows={4}
                placeholder={
                  reason === 'orphanage_visit'
                    ? 'e.g., Visited the San Pablo orphanage with the team. Left the office at 1pm.'
                    : reason === 'medical'
                      ? 'e.g., Doctor appointment from 2–4pm. Returned to work after.'
                      : reason === 'power_outage'
                        ? 'e.g., Power outage in our area from 10am to 2pm.'
                        : reason === 'internet_issue'
                          ? 'e.g., Provider had a long outage; switched to mobile data, throughput was poor.'
                          : reason === 'family_emergency'
                            ? 'e.g., Had to take a family member to the ER.'
                            : 'Describe what happened…'
                }
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-emerald-400"
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] leading-snug text-zinc-400 dark:text-zinc-500">
                Submissions cover the day picked and the day after.
              </p>
              <Button
                type="submit"
                size="sm"
                className="h-8 gap-1.5 bg-emerald-600 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting || !!existingForSelectedDate}
              >
                {submitting ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Send className="size-3.5" aria-hidden />
                )}
                Submit
              </Button>
            </div>
          </form>

          {/* Counts */}
          <div className="grid grid-cols-3 divide-x divide-zinc-200/80 rounded-xl border border-zinc-200/80 bg-white/40 dark:divide-zinc-800/80 dark:border-zinc-800/70 dark:bg-zinc-900/30">
            <div className="px-3 py-2.5 text-center">
              <p className="text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Pending
              </p>
              <p className="mt-1 font-mono text-base font-bold tabular-nums text-zinc-900 dark:text-white">
                {counts['pending'] ?? 0}
              </p>
            </div>
            <div className="px-3 py-2.5 text-center">
              <p className="text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Approved
              </p>
              <p className="mt-1 font-mono text-base font-bold tabular-nums text-zinc-900 dark:text-white">
                {counts['approved'] ?? 0}
              </p>
            </div>
            <div className="px-3 py-2.5 text-center">
              <p className="text-[10px] font-medium uppercase tracking-wider text-rose-700 dark:text-rose-400">
                Denied
              </p>
              <p className="mt-1 font-mono text-base font-bold tabular-nums text-zinc-900 dark:text-white">
                {counts['denied'] ?? 0}
              </p>
            </div>
          </div>
        </motion.section>

        {/* List */}
        <motion.section
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
          className="flex min-w-0 flex-col gap-2 rounded-xl border border-zinc-200/80 bg-white/50 p-3 shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900/30 sm:p-4"
        >
          <div className="flex items-baseline justify-between gap-2 border-b border-zinc-200/70 pb-2 dark:border-zinc-800/70">
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
              History
            </p>
            <p className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
              {disputes.length} dispute{disputes.length === 1 ? '' : 's'}
            </p>
          </div>

          {listLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 py-12 text-xs text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading your disputes…
            </div>
          ) : listError ? (
            <div className="flex flex-1 items-start gap-3 rounded-lg border border-rose-200/70 bg-rose-50/40 p-3 text-xs text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{listError}</span>
            </div>
          ) : disputes.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center text-xs text-zinc-400 dark:text-zinc-500">
              <FileText className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
              <p>No disputes filed yet.</p>
              <p className="max-w-sm text-[11px] leading-relaxed">
                When a day in your PAB calendar dips under 7 hours, click it to come back here with the
                date pre-filled.
              </p>
            </div>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
              {disputes.map((d) => (
                <li
                  key={d.id}
                  className="rounded-lg border border-zinc-200/80 bg-white/80 p-3 transition-colors hover:border-zinc-300 dark:border-zinc-800/80 dark:bg-zinc-900/40 dark:hover:border-zinc-700"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-medium text-zinc-900 dark:text-white">
                        {formatLongDate(d.dispute_date)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">
                          {reasonLabel(d.reason)}
                        </span>
                        <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">·</span>
                        Filed {formatRelative(d.created_at)}
                      </p>
                    </div>
                    <Badge variant="outline" className={`gap-1 ${STATUS_BADGE[d.status] ?? ''}`}>
                      {d.status === 'approved' ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : d.status === 'denied' ? (
                        <XCircle className="h-3 w-3" />
                      ) : (
                        <Clock className="h-3 w-3" />
                      )}
                      {d.status[0].toUpperCase() + d.status.slice(1)}
                    </Badge>
                  </div>
                  {d.explanation && (
                    <p className="mt-2 rounded-md border border-zinc-200 bg-zinc-50/80 p-2 text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300">
                      {d.explanation}
                    </p>
                  )}
                  {(d.decided_by || d.decision_note || d.override_hours != null) && (
                    <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50/60 p-2 text-[11px] dark:border-zinc-800 dark:bg-zinc-900/40">
                      {d.decided_by && (
                        <p className="text-zinc-500 dark:text-zinc-400">
                          Decided by{' '}
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            {d.decided_by}
                          </span>
                          {d.decided_at ? ` on ${formatRelative(d.decided_at)}` : ''}
                        </p>
                      )}
                      {d.override_hours != null && d.override_hours > 0 && (
                        <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">
                          Hours set to{' '}
                          <span className="font-mono font-medium text-emerald-700 dark:text-emerald-400">
                            {d.override_hours}h
                          </span>
                        </p>
                      )}
                      {d.decision_note && (
                        <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">{d.decision_note}</p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </motion.section>
      </div>
    </div>
  );
}
