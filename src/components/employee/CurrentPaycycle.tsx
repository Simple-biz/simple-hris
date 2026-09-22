'use client';

import React, { useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check, Loader2, Minus, CalendarClock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPhp, formatHours, showsOrphanageLine, type PayStubView } from '@/lib/payroll/paystub-view';
import type { PaycycleStep, PaycycleTrack } from '@/lib/employee/paycycle-steps';
import {
  ARRIVAL_NOTE,
  arrivalDayForRail,
  arrivalDayName,
  arrivalGroups,
} from '@/lib/employee/paycycle-arrival';
import type { ProcessorId } from '@/lib/employee-payment-processors';

/**
 * Profile → Compensation → Current Paycycle.
 *
 * The pay week that is being processed right now, disassembled: the hours day
 * by day, every line that will land on the statement, and where payroll has got
 * to. The point is anticipation — the employee watches the figure assemble
 * instead of finding out on Friday.
 *
 * PRESENTATION ONLY. Every judgement was made server-side
 * (`app/api/employee/current-paycycle/route.ts` → `derivePaycycleSteps`); this
 * file decides nothing about money or status. In particular it must never infer
 * a status from an amount — a ₱0 line and an unread line look identical here
 * and only the server can tell them apart.
 */

export interface PaycycleDay {
  iso: string;
  label: string;
  /** Null = the upload has no cell for this day. NOT the same as zero hours,
   *  and rendered as "—" rather than "0.00" for exactly that reason. */
  hours: number | null;
}

export interface CurrentPaycyclePayload {
  week: { sourceFile: string; weekStart: string | null; weekEnd: string | null; weekHuman: string } | null;
  days: PaycycleDay[];
  stub: PayStubView | null;
  track: PaycycleTrack;
  rail: ProcessorId | null;
  error: string | null;
}

/* ─────────────────────────────── the track ────────────────────────────────── */

function StepDot({ status }: { status: PaycycleStep['status'] }) {
  const reduce = useReducedMotion();
  if (status === 'done') {
    return (
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm ring-2 ring-white dark:ring-zinc-950">
        <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (status === 'not_applicable') {
    return (
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-300 bg-zinc-100 text-zinc-400 ring-2 ring-white dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500 dark:ring-zinc-950">
        <Minus className="h-3 w-3" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  // pending — neutral, never a warning. The employee has nothing to fix here.
  return (
    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-300 bg-white ring-2 ring-white dark:border-zinc-700 dark:bg-zinc-900 dark:ring-zinc-950">
      {!reduce && (
        <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-sky-400 opacity-60" />
      )}
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-400 dark:bg-sky-500" />
    </span>
  );
}

const STATUS_WORD: Record<PaycycleStep['status'], string> = {
  done: 'Done',
  pending: 'Waiting',
  not_applicable: 'Not applicable',
};

function TrackRail({ track }: { track: PaycycleTrack }) {
  const reduce = useReducedMotion();
  return (
    <ol className="relative space-y-0" aria-label="Payroll progress">
      {track.steps.map((step, i) => {
        const last = i === track.steps.length - 1;
        return (
          <motion.li
            key={step.key}
            initial={reduce ? false : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.28, delay: reduce ? 0 : i * 0.035, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex gap-3 pb-4 last:pb-0"
          >
            {/* The spine. It stops at the last dot rather than trailing past it. */}
            {!last && (
              <span
                aria-hidden
                className={cn(
                  'absolute left-[9.5px] top-5 h-full w-px',
                  step.status === 'done'
                    ? 'bg-emerald-300 dark:bg-emerald-800'
                    : 'bg-zinc-200 dark:bg-zinc-800',
                )}
              />
            )}
            <StepDot status={step.status} />
            <div className="min-w-0 flex-1 pt-px">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'text-[13px] font-medium',
                    step.status === 'done'
                      ? 'text-zinc-900 dark:text-zinc-100'
                      : step.status === 'not_applicable'
                        ? 'text-zinc-400 dark:text-zinc-500'
                        : 'text-zinc-600 dark:text-zinc-400',
                  )}
                >
                  {step.label}
                </span>
                <span className="sr-only">{STATUS_WORD[step.status]}</span>
              </div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                {step.detail}
              </p>
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

/* ──────────────────────────── the day ladder ─────────────────────────────── */

function DayLadder({ days }: { days: PaycycleDay[] }) {
  const reduce = useReducedMotion();
  const total = days.reduce((sum, d) => sum + (d.hours ?? 0), 0);
  const max = Math.max(1, ...days.map((d) => d.hours ?? 0));

  return (
    <div>
      <ul className="space-y-1">
        {days.map((d, i) => {
          const hasHours = d.hours != null;
          const pct = hasHours ? Math.min(100, ((d.hours ?? 0) / max) * 100) : 0;
          return (
            <motion.li
              key={d.iso}
              initial={reduce ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: reduce ? 0 : i * 0.03, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                'relative flex items-center justify-between gap-3 overflow-hidden rounded-lg border px-2.5 py-1.5',
                hasHours && (d.hours ?? 0) > 0
                  ? 'border-zinc-100 bg-white/60 dark:border-zinc-800/60 dark:bg-zinc-900/20'
                  : 'border-transparent bg-zinc-50/60 dark:bg-zinc-900/30',
              )}
            >
              {/* The fill sits BEHIND the text and is decorative — the number is
                  always the source of truth, so a mis-scaled bar can never be
                  read as a different amount of time. */}
              {pct > 0 && (
                <motion.span
                  aria-hidden
                  initial={reduce ? false : { width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.5, delay: reduce ? 0 : 0.1 + i * 0.03, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-100/70 to-transparent dark:from-emerald-950/40"
                />
              )}
              <span className="relative w-[4.5rem] shrink-0 text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">
                {d.label}
              </span>
              <span
                className={cn(
                  'relative font-mono text-[11px] tabular-nums',
                  hasHours
                    ? 'font-medium text-zinc-700 dark:text-zinc-300'
                    : 'text-zinc-400 dark:text-zinc-600',
                )}
              >
                {hasHours ? `${formatHours(d.hours ?? 0)} h` : '—'}
              </span>
            </motion.li>
          );
        })}
      </ul>
      <div className="mt-2 flex items-center justify-between border-t border-zinc-100 pt-2 dark:border-zinc-800/60">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Total
        </span>
        <span className="font-mono text-[12px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
          {formatHours(total)} h
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────── the disassembled statement ─────────────────────── */

function MoneyRow({
  label,
  amount,
  hint,
  strong,
  negative,
}: {
  label: string;
  amount: number;
  hint?: string | null;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <span
          className={cn(
            'text-[12.5px]',
            strong
              ? 'font-semibold text-zinc-900 dark:text-zinc-100'
              : 'text-zinc-600 dark:text-zinc-400',
          )}
        >
          {label}
        </span>
        {hint && (
          <span className="ml-2 text-[11px] text-zinc-400 dark:text-zinc-500">{hint}</span>
        )}
      </div>
      <span
        className={cn(
          'shrink-0 font-mono text-[12.5px] tabular-nums',
          strong
            ? 'text-[14px] font-semibold text-zinc-900 dark:text-zinc-100'
            : negative
              ? 'text-rose-600 dark:text-rose-400'
              : 'text-zinc-700 dark:text-zinc-300',
        )}
      >
        {negative ? `− ${formatPhp(Math.abs(amount))}` : formatPhp(amount)}
      </span>
    </div>
  );
}

/**
 * The statement, line for line.
 *
 * The visibility rules are IMPORTED (`showsOrphanageLine`, `view.hasWeekend`)
 * rather than restated, because `paystub-view.ts` keeps them beside the view
 * expressly so the renderers cannot answer the question differently for the
 * same week. A fourth opinion here is how this pane and the Pay Stub would come
 * to disagree about whether someone was paid for the orphanage.
 */
function StatementLines({ view }: { view: PayStubView }) {
  const rows = useMemo(() => {
    const out: React.ReactNode[] = [];
    out.push(
      <MoneyRow
        key="regular"
        label={view.otIsDifferential ? 'M-F Hours' : 'Regular Hours'}
        hint={`${formatHours(view.weekdayHours ?? view.mfHours)} h`}
        amount={view.weekdayPay ?? view.mfPay}
      />,
      <MoneyRow
        key="ot"
        label={view.otIsDifferential ? 'OT Differential' : 'Overtime'}
        hint={`${formatHours(view.weekdayOtHours ?? view.mfOtHours)} h`}
        amount={view.weekdayOtPay ?? view.otPay}
      />,
    );
    if (view.hasWeekend) {
      out.push(
        <MoneyRow
          key="weekend"
          label="Weekend Hours"
          hint={`${formatHours(view.weekendHours)} h`}
          amount={view.weekendPay}
        />,
      );
    }
    out.push(
      <MoneyRow key="tech" label="Tech Allowance" amount={view.techBonus} />,
      <MoneyRow key="attendance" label="Attendance Incentive" amount={view.attendanceBonus} />,
      <MoneyRow key="performance" label="KPI / Performance Bonus" amount={view.performanceBonus} />,
      <MoneyRow
        key="adjustment"
        label="Adjustment"
        hint={view.adjustmentNote}
        amount={view.adjustment}
        negative={view.adjustment < 0}
      />,
    );
    if (showsOrphanageLine(view)) {
      out.push(<MoneyRow key="orphanage" label="Orphanage" amount={view.orphanagePay} />);
    }
    out.push(
      <MoneyRow key="mesa-in" label="MESA Reimbursement" amount={view.mesaDisbursement} />,
      <MoneyRow
        key="mesa-out"
        label="MESA Deduction"
        amount={view.mesaDeduction}
        negative={view.mesaDeduction > 0}
      />,
    );
    return out;
  }, [view]);

  return (
    <div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">{rows}</div>
      <div className="mt-1 border-t-2 border-zinc-200 pt-1 dark:border-zinc-700">
        <MoneyRow label="Net pay" amount={view.totalPayPhp} strong />
        <div className="flex items-baseline justify-between gap-3 pb-1.5">
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
            at ₱{view.fxRate} / $1
          </span>
          <span className="font-mono text-[12px] tabular-nums text-zinc-500 dark:text-zinc-400">
            ${view.totalPayUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>
      {view.proration && (
        <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          Part of this week was paid at a different rate.
        </p>
      )}
    </div>
  );
}

/* ───────────────────────────── the arrival note ───────────────────────────── */

/**
 * When to expect the money.
 *
 * Deliberately prints NO date. The Pay Stubs section one pane away renders the
 * real `payDate`, and two dates on one screen that disagree is worse than one
 * date. Friday leads and Friday closes; the earlier days are described as
 * processing lead time, never as an entitlement.
 */
function ArrivalNote({ rail }: { rail: ProcessorId | null }) {
  const mine = arrivalDayForRail(rail);
  const groups = useMemo(() => arrivalGroups(), []);
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800/80 dark:bg-zinc-900/30">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" aria-hidden />
        <span className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
          {ARRIVAL_NOTE.headline}
        </span>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        {ARRIVAL_NOTE.body}
      </p>
      <ul className="mt-2.5 space-y-1">
        {groups.map((g) => (
          <li key={g.dayName} className="flex items-baseline gap-2 text-[11.5px]">
            <span
              className={cn(
                'w-[5.5rem] shrink-0 font-medium',
                mine === g.day
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-zinc-600 dark:text-zinc-400',
              )}
            >
              {g.dayName}
            </span>
            <span className="text-zinc-500 dark:text-zinc-500">{g.labels.join(' · ')}</span>
          </li>
        ))}
      </ul>
      {mine != null && (
        <p className="mt-2.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
          Yours usually releases on{' '}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">{arrivalDayName(mine)}</span>.{' '}
          {ARRIVAL_NOTE.expect}
        </p>
      )}
      {mine == null && (
        <p className="mt-2.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
          {ARRIVAL_NOTE.expect}
        </p>
      )}
    </div>
  );
}

/* ──────────────────────────────── the pane ────────────────────────────────── */

export function CurrentPaycycleSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="space-y-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-8 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900/40" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-6 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900/40" />
        ))}
      </div>
    </div>
  );
}

export function CurrentPaycycle({
  data,
  loading,
  error,
}: {
  data: CurrentPaycyclePayload | null;
  loading: boolean;
  error: string | null;
}) {
  // The four states, in the order every other pane in this Profile uses:
  // loading-and-empty → error → empty → content.
  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" aria-hidden />
        <span className="sr-only">Loading your current pay cycle</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{error}</span>
      </div>
    );
  }

  if (!data || !data.week) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 py-10 text-center">
        <CalendarClock className="h-5 w-5 text-zinc-300 dark:text-zinc-700" aria-hidden />
        <p className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
          No pay week is being processed yet
        </p>
        <p className="max-w-xs text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          This fills in as soon as the week&rsquo;s hours are uploaded. Nothing is missing.
        </p>
      </div>
    );
  }

  const { week, days, stub, track, rail } = data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
            {week.weekHuman}
          </span>
          <span className="ml-2 text-[11.5px] text-zinc-400 dark:text-zinc-500">
            Sunday to Saturday
          </span>
        </div>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {track.doneCount} of {track.totalCount} steps done
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="space-y-5">
          <div>
            <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Your hours
            </h4>
            <DayLadder days={days} />
          </div>

          <div>
            <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Your pay, line by line
            </h4>
            {stub ? (
              <StatementLines view={stub} />
            ) : (
              <p className="py-3 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                The figures appear once this week&rsquo;s pay has been worked out. Your hours above
                are already counted.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4 lg:border-l lg:border-zinc-100 lg:pl-5 lg:dark:border-zinc-800/60">
          <div>
            <h4 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Where payroll is
            </h4>
            <TrackRail track={track} />
          </div>
          <ArrivalNote rail={rail} />
        </div>
      </div>
    </div>
  );
}

export default CurrentPaycycle;
