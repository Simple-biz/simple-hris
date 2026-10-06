'use client';

/**
 * One grid section of the Accounting Scoreboard (every section except Collections, Payroll Timing
 * and Payroll Problems, which have panels of their own): rows down the side, the section's days
 * across, the computed columns on the right, and a team total row. Every number is computed by
 * src/lib/accounting-scoreboard/scoring.ts; nothing here sums.
 */

import { useMemo, type ReactNode } from 'react';
import { CalendarX2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WEEKDAY_LABEL, type BoardSection, type GoalRule, type Slot } from '@/lib/accounting-scoreboard/sections';
import { datesFor, dayHeader } from '@/lib/accounting-scoreboard/week';
import {
  amountCountSectionStats,
  amPmSectionStats,
  dailySectionStats,
  noMeetingStreak,
  timeSpanSectionHours,
  type AmPmRowStats,
  type EntryLookup,
} from '@/lib/accounting-scoreboard/scoring';
import type { BoardRow } from '@/lib/accounting-scoreboard/types';
import { summarizeSection } from '@/lib/accounting-scoreboard/board';
import { goalLight } from '@/lib/accounting-scoreboard/stoplight';
import {
  DIM,
  EmptyRows,
  Flash,
  GoalChip,
  LIGHT_STYLE,
  NumberCell,
  RowTag,
  SCORE_STATUS_TEXT,
  SCORE_STATUS_TITLE,
  SectionHeader,
  TimeCell,
  TINY_CAPS,
  fmtNum,
  fmtScore,
  fmtUsd,
  handle,
  type EditingSignal,
} from './shared';

export type SaveEntry = (rowId: string, date: string, slot: Slot, value: number | null) => Promise<boolean>;

interface Props {
  section: BoardSection;
  rows: BoardRow[];
  weekStart: string;
  lastWeekStart: string;
  today: string;
  lookup: EntryLookup;
  isManager: boolean;
  onSave: SaveEntry;
  onEditing: EditingSignal;
  /** PM Buckets: the latest day any meeting was ticked (the No Meeting Streak counts from it). */
  lastMeetingDate?: string | null;
}

const TH = cn(TINY_CAPS, 'whitespace-nowrap px-2 py-2 text-zinc-500 dark:text-zinc-400');
const TD = 'px-2 py-1.5 align-middle';
const NUM = 'text-right font-mono tabular-nums';

function RowLabel({ row }: { row: BoardRow }) {
  return (
    <div className="min-w-[8rem] max-w-[14rem]">
      <div className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200" title={row.label}>
        {row.label}
      </div>
      <div className="flex items-center gap-1.5">
        {row.workEmail ? (
          <span className="truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500" title={row.workEmail}>
            {handle(row.workEmail)}
          </span>
        ) : null}
        {row.bucketDay ? (
          <RowTag title={`A weekday Collections bucket: scored once ${WEEKDAY_LABEL[row.bucketDay]}'s PM is in`}>
            {WEEKDAY_LABEL[row.bucketDay]} bucket
          </RowTag>
        ) : null}
        {row.dueSoon ? (
          <RowTag tone="amber" title="Counts the disputes due in the next 7 days">
            due in 7 days
          </RowTag>
        ) : null}
        {row.archived ? <RowTag>removed</RowTag> : null}
      </div>
    </div>
  );
}

export function SectionGrid({
  section,
  rows,
  weekStart,
  lastWeekStart,
  today,
  lookup,
  isManager,
  onSave,
  onEditing,
  lastMeetingDate = null,
}: Props) {
  const dates = useMemo(() => datesFor(weekStart, section.days), [weekStart, section.days]);
  const lastDates = useMemo(() => datesFor(lastWeekStart, section.days), [lastWeekStart, section.days]);
  const summary = useMemo(
    () =>
      summarizeSection(
        section,
        rows,
        {
          lookup,
          collections: [],
          problems: [],
          payrollEvents: [],
          firstClosedPeriodEnd: null,
          today,
          nowIso: new Date().toISOString(),
        },
        weekStart,
        lastWeekStart,
      ),
    [section, rows, lookup, weekStart, lastWeekStart, today],
  );

  const isOpenDisputes = section.kind === 'am_pm' && !section.score;
  const unitFormat = section.goal?.measure === 'score' ? fmtScore : fmtNum;
  const dueSoon = isOpenDisputes ? amPmSectionStats(rows, dates, lookup, undefined, today).dueSoonNow : null;
  const streak = section.kind === 'daily_flag' ? noMeetingStreak(lastMeetingDate, today) : null;

  const header = (
    <SectionHeader
      title={section.title}
      help={section.help}
      right={
        <>
          {isOpenDisputes ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                <span className="font-mono tabular-nums">{fmtNum(summary.headline)}</span> open now
              </span>
              {/* Carla, 2026-10-02: the ones due in the next 7 days, called out. */}
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                  dueSoon ? LIGHT_STYLE.amber.chip : LIGHT_STYLE.none.chip,
                )}
              >
                <span className="font-mono tabular-nums">{fmtNum(dueSoon)}</span> due in the next 7 days
              </span>
            </>
          ) : section.kind === 'amount_count' ? null : (
            <GoalChip goal={section.goal} light={summary.light} value={summary.headline} unitFormat={unitFormat} />
          )}
          {section.kind === 'daily_flag' ? <NoMeetingStreak days={streak} /> : null}
          {section.kind === 'amount_count' ? null : (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Last week{isOpenDisputes ? ' (open)' : ''}{' '}
              <span className={cn('font-mono tabular-nums', LIGHT_STYLE[summary.lastLight].text)}>
                {unitFormat(summary.lastHeadline)}
              </span>
            </span>
          )}
        </>
      }
    />
  );

  if (!rows.length) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyRows noun={section.rowNoun} isManager={isManager} />
      </div>
    );
  }

  const tableProps = { section, rows, dates, lastDates, today, lookup, onSave, onEditing, scope: weekStart };
  return (
    <div className="space-y-4">
      {header}
      <div className="min-w-0 overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        {section.kind === 'am_pm' ? (
          <AmPmTable {...tableProps} />
        ) : section.kind === 'time_span' ? (
          <TimeTable {...tableProps} />
        ) : section.kind === 'amount_count' ? (
          <AmountCountTable {...tableProps} />
        ) : (
          <DailyTable {...tableProps} />
        )}
      </div>
    </div>
  );
}

/**
 * PM Buckets' No Meeting Streak (Carla, 2026-10-02): calendar days since any meeting was ticked.
 * All time; it drops to 0 only when a meeting is ticked. Amber once a week has gone by.
 */
function NoMeetingStreak({ days }: { days: number | null }) {
  const long = days !== null && days >= 7;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
        long ? LIGHT_STYLE.amber.chip : LIGHT_STYLE.none.chip,
      )}
      title="Days since any PM meeting was ticked. All time: it only goes back to 0 when a meeting is ticked."
    >
      <CalendarX2 className="size-3.5" />
      No meeting streak{' '}
      <span className="font-mono font-semibold tabular-nums">
        {days === null ? '—' : `${days} ${days === 1 ? 'day' : 'days'}`}
      </span>
    </span>
  );
}

interface TableProps {
  section: BoardSection;
  rows: BoardRow[];
  dates: string[];
  lastDates: string[];
  today: string;
  lookup: EntryLookup;
  onSave: SaveEntry;
  onEditing: EditingSignal;
  /** The week key: a computed total flashes when it changes within one week, never across weeks. */
  scope: string;
}

function DayHeads({ dates, today, span }: { dates: string[]; today: string; span: number }) {
  return (
    <>
      {dates.map((d) => {
        const h = dayHeader(d);
        return (
          <th key={d} colSpan={span} className={cn(TH, 'text-center', d === today && 'text-orange-600 dark:text-orange-400')}>
            {h.weekday} <span className="font-mono font-normal normal-case tracking-normal">{h.short}</span>
          </th>
        );
      })}
    </>
  );
}

const PM_TITLE = {
  cleared: {
    pm_missing: 'PM missing: skipped. The next reading carries on from the AM (a blank is never a 0)',
    pm_pending: 'PM not in yet',
    am_missing: 'AM missing: skipped (a blank is never a 0)',
  },
  inbox: {
    pm_missing: 'PM missing: this day is not in the end-of-day average',
    pm_pending: 'PM not in yet: this day counts once it is',
    am_missing: 'AM missing',
  },
} as const;

function AmPmTable({ section, rows, dates, lastDates, today, lookup, onSave, onEditing, scope }: TableProps) {
  const stats = amPmSectionStats(rows, dates, lookup, section.score, today);
  const last = amPmSectionStats(rows, lastDates, lookup, section.score, today);
  const rule = section.score;
  const titles = PM_TITLE[rule === 'inbox' ? 'inbox' : 'cleared'];

  return (
    <table className="table-keep w-full border-collapse text-sm">
      <thead className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
        <tr>
          <th rowSpan={2} className={cn(TH, 'sticky left-0 z-10 bg-zinc-50 text-left dark:bg-zinc-900')}>
            {section.rowNoun}
          </th>
          <DayHeads dates={dates} today={today} span={2} />
          {rule === 'cleared' ? (
            <>
              <th rowSpan={2} className={cn(TH, 'text-right')} title="Every decrease between back-to-back readings, overnight too">
                Completed
              </th>
              <th rowSpan={2} className={cn(TH, 'text-right')} title="The latest reading">
                Open
              </th>
              <th rowSpan={2} className={cn(TH, 'text-right')} title="10 × completed ÷ (completed + open)">
                Score
              </th>
            </>
          ) : rule === 'inbox' ? (
            <>
              <th rowSpan={2} className={cn(TH, 'text-right')}>EOD avg</th>
              <th rowSpan={2} className={cn(TH, 'text-right')}>Score</th>
            </>
          ) : (
            <th rowSpan={2} className={cn(TH, 'text-right')} title="The latest reading">
              Now
            </th>
          )}
          <th rowSpan={2} className={cn(TH, 'text-right')}>Last wk</th>
        </tr>
        <tr>
          {dates.map((d) => (
            <FragmentPair key={d} />
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {rows.map((row) => {
          const s = stats.rows.get(row.id)!;
          const l = last.rows.get(row.id)!;
          return (
            <tr
              key={row.id}
              className={cn(
                'transition-colors hover:bg-orange-50/30 dark:hover:bg-zinc-900/40',
                row.dueSoon && 'bg-amber-50/60 dark:bg-amber-950/20',
              )}
            >
              <td className={cn(TD, 'sticky left-0 z-10', row.dueSoon ? 'bg-amber-50 dark:bg-zinc-950' : 'bg-white dark:bg-zinc-950')}>
                <RowLabel row={row} />
              </td>
              {s.days.map((day) => {
                const future = day.state === 'future';
                const disabled = future || row.archived;
                return (
                  <FragmentCells key={day.date}>
                    <td className={cn(TD, PAIR_CELL)}>
                      <NumberCell
                        value={day.am}
                        label={`${row.label} · ${dayHeader(day.date).weekday} AM`}
                        disabled={disabled}
                        // A removed row is read-only: flagging a missing number nobody can type is noise.
                        warn={!row.archived && day.state === 'am_missing'}
                        title={day.state === 'am_missing' ? titles.am_missing : undefined}
                        onCommit={(v) => onSave(row.id, day.date, 'am', v)}
                        onEditing={onEditing}
                      />
                    </td>
                    <td className={cn(TD, PAIR_CELL)}>
                      <NumberCell
                        value={day.pm}
                        label={`${row.label} · ${dayHeader(day.date).weekday} PM`}
                        disabled={disabled}
                        warn={!row.archived && day.state === 'pm_missing'}
                        title={
                          day.state === 'pm_missing' ? titles.pm_missing : day.state === 'pm_pending' ? titles.pm_pending : undefined
                        }
                        onCommit={(v) => onSave(row.id, day.date, 'pm', v)}
                        onEditing={onEditing}
                      />
                    </td>
                  </FragmentCells>
                );
              })}
              {rule === 'cleared' ? (
                <>
                  <td className={cn(TD, NUM)}>
                    <Flash value={s.completed} scope={scope}>{fmtNum(s.completed)}</Flash>
                  </td>
                  <td className={cn(TD, NUM)}>
                    <Flash value={s.open} scope={scope}>{fmtNum(s.open)}</Flash>
                  </td>
                  <td className={cn(TD, NUM, 'font-semibold')}>
                    <Flash value={s.status === 'scored' ? s.score : s.status} scope={scope}>
                      <RowScore stats={s} goal={section.goal} />
                    </Flash>
                  </td>
                  <td className={cn(TD, NUM, DIM)}>
                    <RowScore stats={l} goal={undefined} />
                  </td>
                </>
              ) : rule === 'inbox' ? (
                <>
                  <td className={cn(TD, NUM)}>
                    <Flash value={s.pmAverage} scope={scope}>{fmtScore(s.pmAverage)}</Flash>
                  </td>
                  <td className={cn(TD, NUM, 'font-semibold')}>
                    <Flash value={s.score} scope={scope}>
                      <RowScore stats={s} goal={section.goal} />
                    </Flash>
                  </td>
                  <td className={cn(TD, NUM, DIM)}>{fmtScore(l.score)}</td>
                </>
              ) : (
                <>
                  <td className={cn(TD, NUM, 'font-semibold', row.dueSoon && 'text-amber-700 dark:text-amber-300')}>
                    <Flash value={s.open} scope={scope}>{fmtNum(s.open)}</Flash>
                  </td>
                  <td className={cn(TD, NUM, DIM)}>{fmtNum(l.open)}</td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
      {/* Open Disputes has no Day total: "due in 7 days" is part of "open", so adding the lines double counts. */}
      {rule ? (
        <tfoot className="border-t border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
          <tr>
            <td className={cn(TD, TINY_CAPS, 'sticky left-0 z-10 bg-zinc-50 text-zinc-500 dark:bg-zinc-900')}>
              {rule === 'cleared' ? 'Day total · overall' : 'Day total'}
            </td>
            {stats.dayTotals.map((t) => (
              <FragmentCells key={t.date}>
                <td className={cn(TD, PAIR_CELL, 'text-zinc-600 dark:text-zinc-300')}>
                  <Flash value={t.am} scope={scope}>
                    <BoxAligned>{fmtNum(t.am)}</BoxAligned>
                  </Flash>
                </td>
                <td className={cn(TD, PAIR_CELL, 'text-zinc-600 dark:text-zinc-300')}>
                  <Flash value={t.pm} scope={scope}>
                    <BoxAligned>{fmtNum(t.pm)}</BoxAligned>
                  </Flash>
                </td>
              </FragmentCells>
            ))}
            {rule === 'cleared' ? (
              <>
                <td className={cn(TD, NUM, 'font-semibold')} title="Scored buckets only: N/A and Pending are left out">
                  <Flash value={stats.completedTotal} scope={scope}>{fmtNum(stats.completedTotal)}</Flash>
                </td>
                <td className={cn(TD, NUM, 'font-semibold')} title="Scored buckets only: N/A and Pending are left out">
                  <Flash value={stats.openTotal} scope={scope}>{fmtNum(stats.openTotal)}</Flash>
                </td>
              </>
            ) : (
              <td className={cn(TD, NUM, 'font-semibold')}>
                <Flash value={stats.teamPmAverage} scope={scope}>{fmtScore(stats.teamPmAverage)}</Flash>
              </td>
            )}
            <td className={cn(TD, NUM, 'font-semibold')} title={rule === 'cleared' ? '10 × total completed ÷ total (completed + open), scored buckets only' : undefined}>
              <Flash value={stats.headline} scope={scope}>
                <ScoreText score={stats.headline} goal={section.goal} />
              </Flash>
            </td>
            <td className={cn(TD, NUM, DIM)}>{fmtScore(last.headline)}</td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

/**
 * Every AM/PM column is centred on ONE axis: the label, the 3.5rem box and the day total all sit
 * on the cell's centre line (PAIR_CELL), and a total is right-aligned inside a box-wide span so its
 * digits stack under the digits typed in the box.
 */
const PAIR_CELL = 'px-1 text-center';

function FragmentPair() {
  return (
    <>
      <th className={cn(TH, PAIR_CELL, 'py-1 font-mono text-[9px]')}>AM</th>
      <th className={cn(TH, PAIR_CELL, 'py-1 font-mono text-[9px]')}>PM</th>
    </>
  );
}

/** A footer number shaped like a NumberCell (w-14; 1px border + px-1.5 = 7px), so its digits line up with the box's. */
function BoxAligned({ children }: { children: ReactNode }) {
  return <span className="inline-block min-w-14 pr-[7px] text-right font-mono tabular-nums">{children}</span>;
}

function FragmentCells({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** A score in its stop-light colour: the same thresholds as the Overview (stoplight.ts). */
function ScoreText({ score, goal }: { score: number | null; goal?: GoalRule }) {
  if (score === null) return <span className={DIM}>—</span>;
  const light = goalLight(goal, score);
  return <span className={light === 'none' ? 'text-zinc-800 dark:text-zinc-200' : LIGHT_STYLE[light].text}>{fmtScore(score)}</span>;
}

/** A row's score, or the word for why it has none (N/A, Pending, PM missing). Never a 0 in place of absence. */
function RowScore({ stats, goal }: { stats: AmPmRowStats; goal?: GoalRule }) {
  if (stats.status === 'scored') return <ScoreText score={stats.score} goal={goal} />;
  const word = SCORE_STATUS_TEXT[stats.status];
  return (
    <span
      title={SCORE_STATUS_TITLE[stats.status]}
      className={cn(
        'font-sans text-[11px] font-semibold',
        stats.status === 'pending' ? 'text-orange-600 dark:text-orange-400' : stats.status === 'pm_missing' ? 'text-amber-700 dark:text-amber-300' : DIM,
      )}
    >
      {word}
    </span>
  );
}

function DailyTable({ section, rows, dates, lastDates, today, lookup, onSave, onEditing, scope }: TableProps) {
  const ids = rows.map((r) => r.id);
  const withFlag = section.kind === 'daily_flag';
  const stats = dailySectionStats(ids, dates, lookup);
  const last = dailySectionStats(ids, lastDates, lookup);
  const showShare = section.key === 'cancellations';

  return (
    <table className="table-keep w-full border-collapse text-sm">
      <thead className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
        <tr>
          <th className={cn(TH, 'sticky left-0 z-10 bg-zinc-50 text-left dark:bg-zinc-900')}>{section.rowNoun}</th>
          <DayHeads dates={dates} today={today} span={1} />
          {withFlag ? (
            <>
              <th className={cn(TH, 'text-right')}>WTD avg</th>
              <th className={cn(TH, 'text-right')}>Met</th>
              <th className={cn(TH, 'text-right')}>Last wk avg</th>
            </>
          ) : (
            <>
              <th className={cn(TH, 'text-right')}>Week</th>
              {showShare ? <th className={cn(TH, 'text-right')}>Share</th> : null}
              <th className={cn(TH, 'text-right')}>Last wk</th>
            </>
          )}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {rows.map((row) => {
          const s = stats.rows.get(row.id)!;
          const l = last.rows.get(row.id)!;
          return (
            <tr key={row.id} className="transition-colors hover:bg-orange-50/30 dark:hover:bg-zinc-900/40">
              <td className={cn(TD, 'sticky left-0 z-10 bg-white dark:bg-zinc-950')}>
                <RowLabel row={row} />
              </td>
              {dates.map((date, i) => {
                const disabled = date > today || row.archived;
                const day = dayHeader(date).weekday;
                return (
                  <td key={date} className={cn(TD, 'text-center')}>
                    <div className="inline-flex items-center gap-1.5 align-middle">
                      <NumberCell
                        value={s.values[i]}
                        label={`${row.label} · ${day}`}
                        disabled={disabled}
                        onCommit={(v) => onSave(row.id, date, 'day', v)}
                        onEditing={onEditing}
                      />
                      {withFlag ? (
                        <input
                          type="checkbox"
                          aria-label={`${row.label} · ${day} · met`}
                          title={s.met[i] === null ? 'Meeting not recorded' : s.met[i] ? 'Met' : 'No meeting'}
                          checked={s.met[i] === true}
                          disabled={disabled}
                          onChange={(e) => void onSave(row.id, date, 'mtg', e.target.checked ? 1 : 0)}
                          className="size-4 accent-orange-500"
                        />
                      ) : null}
                    </div>
                  </td>
                );
              })}
              {withFlag ? (
                <>
                  <td className={cn(TD, NUM, 'font-semibold')}>
                    <Flash value={s.average} scope={scope}>{fmtScore(s.average)}</Flash>
                  </td>
                  <td className={cn(TD, NUM)}>
                    {s.met.some((m) => m !== null) ? (
                      <Flash value={s.meetings} scope={scope}>{s.meetings}</Flash>
                    ) : (
                      <span className={DIM}>—</span>
                    )}
                  </td>
                  <td className={cn(TD, NUM, DIM)}>{fmtScore(l.average)}</td>
                </>
              ) : (
                <>
                  <td className={cn(TD, NUM, 'font-semibold')}>
                    <Flash value={s.week} scope={scope}>{fmtNum(s.week)}</Flash>
                  </td>
                  {showShare ? (
                    <td className={cn(TD, NUM)}>
                      {s.week !== null && stats.weekTotal ? `${Math.round((s.week / stats.weekTotal) * 100)}%` : <span className={DIM}>—</span>}
                    </td>
                  ) : null}
                  <td className={cn(TD, NUM, DIM)}>{fmtNum(l.week)}</td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
      <tfoot className="border-t border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
        <tr>
          <td className={cn(TD, TINY_CAPS, 'sticky left-0 z-10 bg-zinc-50 text-zinc-500 dark:bg-zinc-900')}>Day total</td>
          {stats.dayTotals.map((t, i) => (
            <td key={dates[i]} className={cn(TD, 'text-center text-zinc-600 dark:text-zinc-300')}>
              {/* Same shape as the body cell (box + tick), so the total sits under the box and the
                  day's meetings sit under the ticks. */}
              <span className="inline-flex items-center gap-1.5">
                <Flash value={t} scope={scope}>
                  <BoxAligned>{fmtNum(t)}</BoxAligned>
                </Flash>
                {withFlag ? (
                  <span
                    className="w-4 text-center font-mono text-[10px] tabular-nums text-zinc-400"
                    title={`${stats.meetingsByDay[i]} met that day`}
                  >
                    {stats.meetingsByDay[i] || '—'}
                  </span>
                ) : null}
              </span>
            </td>
          ))}
          {withFlag ? (
            <>
              <td className={cn(TD, NUM, 'font-semibold')}>
                <Flash value={stats.averageTotal} scope={scope}>{fmtScore(stats.averageTotal)}</Flash>
              </td>
              <td className={cn(TD, NUM)}>{stats.meetingsByDay.reduce((a, b) => a + b, 0) || <span className={DIM}>—</span>}</td>
              <td className={cn(TD, NUM, DIM)}>{fmtScore(last.averageTotal)}</td>
            </>
          ) : (
            <>
              <td className={cn(TD, NUM, 'font-semibold')}>
                <Flash value={stats.weekTotal} scope={scope}>{fmtNum(stats.weekTotal)}</Flash>
              </td>
              {showShare ? <td className={cn(TD, NUM)}>{stats.weekTotal ? '100%' : <span className={DIM}>—</span>}</td> : null}
              <td className={cn(TD, NUM, DIM)}>{fmtNum(last.weekTotal)}</td>
            </>
          )}
        </tr>
      </tfoot>
    </table>
  );
}

/**
 * Chargeback Outcomes (Carla, 2026-10-02): per outcome, per day, the dollar amount and how many
 * chargebacks ("one dispute won for $99 → Wins: $99 / 1"). Per-outcome week totals only: there is
 * no total across outcomes, because adding a win to a loss means nothing.
 */
function AmountCountTable({ section, rows, dates, lastDates, today, lookup, onSave, onEditing, scope }: TableProps) {
  const ids = rows.map((r) => r.id);
  const stats = amountCountSectionStats(ids, dates, lookup);
  const last = amountCountSectionStats(ids, lastDates, lookup);
  return (
    <table className="table-keep w-full border-collapse text-sm">
      <thead className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
        <tr>
          <th rowSpan={2} className={cn(TH, 'sticky left-0 z-10 bg-zinc-50 text-left dark:bg-zinc-900')}>
            {section.rowNoun}
          </th>
          <DayHeads dates={dates} today={today} span={2} />
          <th colSpan={2} className={cn(TH, 'text-center')}>Week</th>
          <th colSpan={2} className={cn(TH, 'text-center')}>Last wk</th>
        </tr>
        <tr>
          {[...dates, 'week', 'last'].map((d) => (
            <FragmentCells key={d}>
              <th className={cn(TH, PAIR_CELL, 'py-1 font-mono text-[9px]')}>$</th>
              <th className={cn(TH, PAIR_CELL, 'py-1 font-mono text-[9px]')}>#</th>
            </FragmentCells>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {rows.map((row) => {
          const s = stats.rows.get(row.id)!;
          const l = last.rows.get(row.id)!;
          return (
            <tr key={row.id} className="transition-colors hover:bg-orange-50/30 dark:hover:bg-zinc-900/40">
              <td className={cn(TD, 'sticky left-0 z-10 bg-white dark:bg-zinc-950')}>
                <RowLabel row={row} />
              </td>
              {dates.map((date, i) => {
                const disabled = date > today || row.archived;
                const wd = dayHeader(date).weekday;
                return (
                  <FragmentCells key={date}>
                    <td className={cn(TD, PAIR_CELL)}>
                      <NumberCell
                        value={s.usd[i]}
                        label={`${row.label} · ${wd} · dollar amount`}
                        disabled={disabled}
                        className="w-20"
                        onCommit={(v) => onSave(row.id, date, 'usd', v)}
                        onEditing={onEditing}
                      />
                    </td>
                    <td className={cn(TD, PAIR_CELL)}>
                      <NumberCell
                        value={s.count[i]}
                        label={`${row.label} · ${wd} · number of chargebacks`}
                        disabled={disabled}
                        onCommit={(v) => onSave(row.id, date, 'count', v)}
                        onEditing={onEditing}
                      />
                    </td>
                  </FragmentCells>
                );
              })}
              <td className={cn(TD, NUM, 'font-semibold')}>
                <Flash value={s.weekUsd} scope={scope}>{s.weekUsd === null ? '—' : fmtUsd(s.weekUsd)}</Flash>
              </td>
              <td className={cn(TD, NUM, 'font-semibold')}>
                <Flash value={s.weekCount} scope={scope}>{fmtNum(s.weekCount)}</Flash>
              </td>
              <td className={cn(TD, NUM, DIM)}>{l.weekUsd === null ? '—' : fmtUsd(l.weekUsd)}</td>
              <td className={cn(TD, NUM, DIM)}>{fmtNum(l.weekCount)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TimeTable({ section, rows, dates, lastDates, today, lookup, onSave, onEditing, scope }: TableProps) {
  const ids = rows.map((r) => r.id);
  const stats = timeSpanSectionHours(ids, dates, lookup);
  const last = timeSpanSectionHours(ids, lastDates, lookup);

  return (
    <table className="table-keep w-full border-collapse text-sm">
      <thead className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
        <tr>
          <th className={cn(TH, 'sticky left-0 z-10 bg-zinc-50 text-left dark:bg-zinc-900')}>{section.rowNoun}</th>
          <DayHeads dates={dates} today={today} span={1} />
          <th className={cn(TH, 'text-right')}>Hours</th>
          <th className={cn(TH, 'text-right')}>Last wk</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {rows.map((row) => {
          const s = stats.rows.get(row.id)!;
          const l = last.rows.get(row.id)!;
          return (
            <tr key={row.id} className="transition-colors hover:bg-orange-50/30 dark:hover:bg-zinc-900/40">
              <td className={cn(TD, 'sticky left-0 z-10 bg-white dark:bg-zinc-950')}>
                <RowLabel row={row} />
              </td>
              {s.days.map((day) => {
                const disabled = day.date > today || row.archived;
                const wd = dayHeader(day.date).weekday;
                return (
                  <td key={day.date} className={cn(TD, 'text-center')}>
                    <div className="flex flex-col items-center gap-1">
                      <TimeCell
                        value={day.start}
                        label={`${row.label} · ${wd} start`}
                        disabled={disabled}
                        warn={day.invalid}
                        onCommit={(v) => onSave(row.id, day.date, 'start', v)}
                        onEditing={onEditing}
                      />
                      <TimeCell
                        value={day.end}
                        label={`${row.label} · ${wd} end`}
                        disabled={disabled}
                        warn={day.invalid}
                        onCommit={(v) => onSave(row.id, day.date, 'end', v)}
                        onEditing={onEditing}
                      />
                      <span className={cn('font-mono text-[11px] tabular-nums', day.invalid ? 'text-amber-600' : 'text-zinc-500')}>
                        {day.invalid ? 'end ≤ start' : day.hours === null ? '—' : `${fmtNum(day.hours)} h`}
                      </span>
                    </div>
                  </td>
                );
              })}
              <td className={cn(TD, NUM, 'font-semibold')}>
                <Flash value={s.hours} scope={scope}>{fmtNum(s.hours)}</Flash>
              </td>
              <td className={cn(TD, NUM, DIM)}>{fmtNum(l.hours)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot className="border-t border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
        <tr>
          <td className={cn(TD, TINY_CAPS, 'sticky left-0 z-10 bg-zinc-50 text-zinc-500 dark:bg-zinc-900')}>Team</td>
          {dates.map((d) => {
            const hrs = [...stats.rows.values()]
              .map((r) => r.days.find((x) => x.date === d)?.hours ?? null)
              .filter((h): h is number => h !== null);
            return (
              <td key={d} className={cn(TD, NUM, 'text-center text-zinc-600 dark:text-zinc-300')}>
                {hrs.length ? `${fmtNum(Math.round(hrs.reduce((a, b) => a + b, 0) * 100) / 100)} h` : '—'}
              </td>
            );
          })}
          <td className={cn(TD, NUM, 'font-semibold')}>
            <Flash value={stats.total} scope={scope}>{fmtNum(stats.total)}</Flash>
          </td>
          <td className={cn(TD, NUM, DIM)}>{fmtNum(last.total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
