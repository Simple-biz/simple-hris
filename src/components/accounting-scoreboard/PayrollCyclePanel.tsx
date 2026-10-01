'use client';

/**
 * Payroll Timing: Carla's "Payroll Scoreboard (Timing)" table, filled from HRIS itself.
 * Nothing on it is typed. Started = the Payroll Wizard's first Start Processing on the week's pay
 * cycle; Closed = Close Pay Cycle for that cycle. See payroll-cycle.ts for the rules and
 * docs/features/accounting-scoreboard.md § Payroll Timing fills itself.
 */

import { cn } from '@/lib/utils';
import type { ResolvedSection } from '@/lib/accounting-scoreboard/sections';
import { addDays, formatEasternDateTime, rangeLabel, weekLabel, weekStartOf } from '@/lib/accounting-scoreboard/week';
import {
  CLOSE_DEADLINE,
  SCORE_WEIGHTS,
  START_DEADLINE,
  cycleAverages,
  cycleLight,
  cycleWeek,
  type CheckState,
  type CycleWeek,
  type PayrollEvent,
} from '@/lib/accounting-scoreboard/payroll-cycle';
import { LIGHT_LABEL } from '@/lib/accounting-scoreboard/stoplight';
import { DIM, LIGHT_STYLE, SectionHeader, StopLight, TINY_CAPS } from './shared';

interface Props {
  section: ResolvedSection;
  weekStart: string;
  today: string;
  events: PayrollEvent[];
  /** The period end of the first cycle ever closed (BoardPayload.firstClosedPeriodEnd). */
  firstClosedPeriodEnd: string | null;
}

const TH = cn(TINY_CAPS, 'whitespace-nowrap px-3 py-2 text-zinc-500 dark:text-zinc-400');
const TD = 'px-3 py-3 align-middle';

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n)}%`;
}

function CheckChip({ state }: { state: CheckState }) {
  if (state === 'pending' || state === 'no_record') return <span className={DIM}>—</span>;
  const good = state === 'on_time';
  return (
    <span
      className={cn(
        'inline-flex min-w-14 justify-center rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        good ? LIGHT_STYLE.green.chip : LIGHT_STYLE.red.chip,
      )}
    >
      {good ? 'Yes' : 'Late'}
    </span>
  );
}

/** What a week with nothing to judge says, and why. Neither ever counts against anyone. */
const NO_RECORD = {
  start: { label: 'Not in Wizard', why: 'No Start Processing in the Payroll Wizard on this pay cycle: payroll ran outside HRIS, or was started only from Payment Dispatch.' },
  close: { label: 'Before close-outs', why: 'Close Pay Cycle did not exist yet when this pay week ended.' },
} as const;

function When({
  at,
  state,
  kind,
  reopened,
}: {
  at: string | null;
  state: CheckState;
  kind: 'start' | 'close';
  reopened?: boolean;
}) {
  if (at) {
    return (
      <span className="whitespace-nowrap font-mono text-[13px] tabular-nums text-zinc-800 dark:text-zinc-200">
        {formatEasternDateTime(at)}
      </span>
    );
  }
  if (reopened) return <span className={cn('text-xs font-semibold', LIGHT_STYLE.amber.text)}>Reopened</span>;
  if (state === 'no_record') {
    return (
      <span className="whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400" title={NO_RECORD[kind].why}>
        {NO_RECORD[kind].label}
      </span>
    );
  }
  if (state === 'missed') return <span className={cn('text-xs font-semibold', LIGHT_STYLE.red.text)}>Not yet</span>;
  return <span className={DIM}>—</span>;
}

export function PayrollCyclePanel({ section, weekStart, today, events, firstClosedPeriodEnd }: Props) {
  // Recomputed every render (three weeks of a few dozen events): "now" decides pending vs missed, so a
  // deadline that passes while the page is open turns the cycle red on the next refresh.
  const nowIso = new Date().toISOString();
  const weeks = [0, -7, -14].map((offset) => cycleWeek(events, addDays(weekStart, offset), nowIso, firstClosedPeriodEnd));
  const avg = cycleAverages(weeks);
  const isCurrent = weekStart === weekStartOf(today);
  const label = (w: CycleWeek, i: number) =>
    isCurrent ? ['This week', 'Last week', 'Two weeks ago'][i] : weekLabel(w.weekStart);
  const thisLight = cycleLight(weeks[0]);

  return (
    <div className="space-y-4">
      <SectionHeader
        title={section.title}
        help={section.help}
        right={
          <>
            <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium', LIGHT_STYLE[thisLight].chip)}>
              Start by {START_DEADLINE.label}
            </span>
            <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium', LIGHT_STYLE[thisLight].chip)}>
              Close by {CLOSE_DEADLINE.label}
            </span>
          </>
        }
      />

      <div className="min-w-0 overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="table-keep w-full border-collapse text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
            <tr>
              <th className={cn(TH, 'text-left')} rowSpan={2}>
                Week
              </th>
              <th className={cn(TH, 'text-center')}>Tuesday</th>
              <th className={cn(TH, 'text-center')}>Friday</th>
              <th className={cn(TH, 'text-center')} rowSpan={2}>
                Started on time?
              </th>
              <th className={cn(TH, 'text-center')} rowSpan={2}>
                Closed on time?
              </th>
              <th className={cn(TH, 'text-right')} rowSpan={2}>
                Cycle score
              </th>
            </tr>
            <tr>
              <th className={cn(TH, 'pt-0 text-center font-mono text-[9px]')}>Cycle started</th>
              <th className={cn(TH, 'pt-0 text-center font-mono text-[9px]')}>Cycle closed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {weeks.map((w, i) => {
              const light = cycleLight(w);
              return (
                <tr key={w.weekStart} className={cn(i === 0 && isCurrent && 'bg-orange-50/30 dark:bg-orange-950/10')}>
                  <td className={TD}>
                    <div className="flex items-center gap-3">
                      <StopLight light={light} className="scale-75" />
                      <div>
                        <div className="whitespace-nowrap font-semibold text-zinc-900 dark:text-zinc-100">{label(w, i)}</div>
                        <div className="whitespace-nowrap text-[11px] text-zinc-500">pays {rangeLabel(w.paysWeek.start, w.paysWeek.end)}</div>
                      </div>
                    </div>
                  </td>
                  <td className={cn(TD, 'text-center')}>
                    <When at={w.startedAt} state={w.start} kind="start" />
                  </td>
                  <td className={cn(TD, 'text-center')}>
                    <When at={w.closedAt} state={w.close} kind="close" reopened={w.reopened} />
                  </td>
                  <td className={cn(TD, 'text-center')}>
                    <CheckChip state={w.start} />
                  </td>
                  <td className={cn(TD, 'text-center')}>
                    <CheckChip state={w.close} />
                  </td>
                  <td className={cn(TD, 'text-right')}>
                    <span
                      className={cn('font-mono text-lg font-semibold tabular-nums', w.score === null || light === 'none' ? DIM : LIGHT_STYLE[light].text)}
                      title={w.score === null ? LIGHT_LABEL[light] : undefined}
                    >
                      {pct(w.score)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
            <tr>
              <td className={cn(TD, TINY_CAPS, 'text-zinc-500')} colSpan={3}>
                Average
              </td>
              <td className={cn(TD, 'text-center font-mono font-semibold tabular-nums', avg.startOnTime === null && DIM)}>{pct(avg.startOnTime)}</td>
              <td className={cn(TD, 'text-center font-mono font-semibold tabular-nums', avg.closeOnTime === null && DIM)}>{pct(avg.closeOnTime)}</td>
              <td className={cn(TD, 'text-right font-mono text-lg font-semibold tabular-nums', avg.score === null && DIM)}>{pct(avg.score)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        Filled from HRIS, nothing to type. <strong className="font-semibold">Started</strong> is the first Start Processing in
        the Payroll Wizard on that week&rsquo;s pay cycle, whenever it happened. <strong className="font-semibold">Closed</strong> is
        Close Pay Cycle in Payment Dispatch for the same cycle. Times are Eastern. &ldquo;Not in Wizard&rdquo; and
        &ldquo;Before close-outs&rdquo; are weeks with nothing to judge, and never count against anyone. Cycle score: {SCORE_WEIGHTS.start}% for starting by{' '}
        {START_DEADLINE.label} + {SCORE_WEIGHTS.close}% for closing by {CLOSE_DEADLINE.label}, once both are in.
      </p>
    </div>
  );
}
