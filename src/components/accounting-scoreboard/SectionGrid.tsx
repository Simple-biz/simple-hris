'use client';

/**
 * One grid section of the Accounting Scoreboard (every section except Collections): rows down the
 * side, the section's days across, the sheet's computed columns on the right, and a team total
 * row. Every number is computed by src/lib/accounting-scoreboard/scoring.ts; nothing here sums.
 */

import { useMemo, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { ResolvedSection, Slot } from '@/lib/accounting-scoreboard/sections';
import { datesFor, dayHeader } from '@/lib/accounting-scoreboard/week';
import {
  amPmSectionStats,
  dailySectionStats,
  timeSpanSectionHours,
  type EntryLookup,
} from '@/lib/accounting-scoreboard/scoring';
import type { BoardRow } from '@/lib/accounting-scoreboard/types';
import { summarizeSection } from '@/lib/accounting-scoreboard/board';
import {
  DIM,
  EmptyRows,
  Flash,
  GoalChip,
  NumberCell,
  SectionHeader,
  TimeCell,
  TINY_CAPS,
  fmtNum,
  fmtScore,
  handle,
  type EditingSignal,
} from './shared';

export type SaveEntry = (rowId: string, date: string, slot: Slot, value: number | null) => Promise<boolean>;

interface Props {
  section: ResolvedSection;
  rows: BoardRow[];
  weekStart: string;
  lastWeekStart: string;
  today: string;
  lookup: EntryLookup;
  isManager: boolean;
  onSave: SaveEntry;
  onEditing: EditingSignal;
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
        {row.archived ? (
          <span className={cn(TINY_CAPS, 'rounded bg-zinc-100 px-1 text-[9px] text-zinc-500 dark:bg-zinc-800')}>
            removed
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function SectionGrid({ section, rows, weekStart, lastWeekStart, today, lookup, isManager, onSave, onEditing }: Props) {
  const dates = useMemo(() => datesFor(weekStart, section.days), [weekStart, section.days]);
  const lastDates = useMemo(() => datesFor(lastWeekStart, section.days), [lastWeekStart, section.days]);
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const summary = useMemo(
    () => summarizeSection(section, rowIds, lookup, [], weekStart, lastWeekStart, today),
    [section, rowIds, lookup, weekStart, lastWeekStart, today],
  );

  const unitFormat = section.goal?.measure === 'avg_score' ? fmtScore : fmtNum;
  const header = (
    <SectionHeader
      title={section.title}
      help={section.help}
      right={
        <>
          <GoalChip goal={section.goal} met={summary.met} value={summary.headline} unitFormat={unitFormat} />
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Last week <span className="font-mono tabular-nums">{unitFormat(summary.lastHeadline)}</span>
          </span>
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

  return (
    <div className="space-y-4">
      {header}
      <div className="min-w-0 overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        {section.kind === 'am_pm' ? (
          <AmPmTable {...{ section, rows, dates, lastDates, today, lookup, onSave, onEditing }} scope={weekStart} />
        ) : section.kind === 'time_span' ? (
          <TimeTable {...{ section, rows, dates, lastDates, today, lookup, onSave, onEditing }} scope={weekStart} />
        ) : (
          <DailyTable {...{ section, rows, dates, lastDates, today, lookup, onSave, onEditing }} scope={weekStart} />
        )}
      </div>
    </div>
  );
}

interface TableProps {
  section: ResolvedSection;
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

function AmPmTable({ section, rows, dates, lastDates, today, lookup, onSave, onEditing, scope }: TableProps) {
  const ids = rows.map((r) => r.id);
  const stats = amPmSectionStats(ids, dates, lookup, section.score, today);
  const last = amPmSectionStats(ids, lastDates, lookup, section.score, today);
  const isInbox = section.score === 'inbox';

  return (
    <table className="table-keep w-full border-collapse text-sm">
      <thead className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
        <tr>
          <th rowSpan={2} className={cn(TH, 'sticky left-0 z-10 bg-zinc-50 text-left dark:bg-zinc-900')}>
            {section.rowNoun}
          </th>
          <DayHeads dates={dates} today={today} span={2} />
          {isInbox ? <th rowSpan={2} className={cn(TH, 'text-right')}>EOD avg</th> : <th rowSpan={2} className={cn(TH, 'text-right')}>Comp</th>}
          {section.score ? <th rowSpan={2} className={cn(TH, 'text-right')}>Score</th> : null}
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
            <tr key={row.id} className="transition-colors hover:bg-orange-50/30 dark:hover:bg-zinc-900/40">
              <td className={cn(TD, 'sticky left-0 z-10 bg-white dark:bg-zinc-950')}>
                <RowLabel row={row} />
              </td>
              {s.days.map((day) => {
                const future = day.state === 'future';
                const disabled = future || row.archived;
                return (
                  <FragmentCells key={day.date}>
                    <td className={cn(TD, 'pr-0.5')}>
                      <NumberCell
                        value={day.am}
                        label={`${row.label} · ${dayHeader(day.date).weekday} AM`}
                        disabled={disabled}
                        warn={day.state === 'am_missing'}
                        title={day.state === 'am_missing' ? 'AM missing: this day is not counted in Comp' : undefined}
                        onCommit={(v) => onSave(row.id, day.date, 'am', v)}
                        onEditing={onEditing}
                      />
                    </td>
                    <td className={cn(TD, 'pl-0.5')}>
                      <NumberCell
                        value={day.pm}
                        label={`${row.label} · ${dayHeader(day.date).weekday} PM`}
                        disabled={disabled}
                        warn={day.state === 'pm_missing'}
                        title={
                          day.state === 'pm_missing'
                            ? 'PM missing: this day is not counted (the sheet counted it as cleared)'
                            : day.state === 'pm_pending'
                              ? 'PM not in yet: this day counts once it is'
                              : undefined
                        }
                        onCommit={(v) => onSave(row.id, day.date, 'pm', v)}
                        onEditing={onEditing}
                      />
                    </td>
                  </FragmentCells>
                );
              })}
              <td className={cn(TD, NUM)}>
                <Flash value={isInbox ? s.pmAverage : s.comp} scope={scope}>
                  {isInbox ? fmtScore(s.pmAverage) : fmtNum(s.comp)}
                </Flash>
              </td>
              {section.score ? (
                <td className={cn(TD, NUM, 'font-semibold')}>
                  <Flash value={s.score} scope={scope}>
                    <ScoreText score={s.score} goal={section.goal?.value} />
                  </Flash>
                </td>
              ) : null}
              <td className={cn(TD, NUM, DIM)}>{section.score ? fmtScore(l.score) : fmtNum(l.comp)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot className="border-t border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
        <tr>
          <td className={cn(TD, TINY_CAPS, 'sticky left-0 z-10 bg-zinc-50 text-zinc-500 dark:bg-zinc-900')}>Day total</td>
          {stats.dayTotals.map((t) => (
            <FragmentCells key={t.date}>
              <td className={cn(TD, NUM, 'pr-2 text-zinc-600 dark:text-zinc-300')}>
                <Flash value={t.am} scope={scope}>{fmtNum(t.am)}</Flash>
              </td>
              <td className={cn(TD, NUM, 'pr-2 text-zinc-600 dark:text-zinc-300')}>
                <Flash value={t.pm} scope={scope}>{fmtNum(t.pm)}</Flash>
              </td>
            </FragmentCells>
          ))}
          <td className={cn(TD, NUM, 'font-semibold')}>
            <Flash value={isInbox ? stats.teamPmAverage : stats.compTotal} scope={scope}>
              {isInbox ? fmtScore(stats.teamPmAverage) : fmtNum(stats.compTotal)}
            </Flash>
          </td>
          {section.score ? (
            <td className={cn(TD, NUM, 'font-semibold')}>
              <Flash value={stats.headline} scope={scope}>
                <ScoreText score={stats.headline} goal={section.goal?.value} />
              </Flash>
            </td>
          ) : null}
          <td className={cn(TD, NUM, DIM)}>{section.score ? fmtScore(last.headline) : fmtNum(last.compTotal)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function FragmentPair() {
  return (
    <>
      <th className={cn(TH, 'py-1 text-right font-mono text-[9px]')}>AM</th>
      <th className={cn(TH, 'py-1 text-right font-mono text-[9px]')}>PM</th>
    </>
  );
}

function FragmentCells({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function ScoreText({ score, goal }: { score: number | null; goal?: number }) {
  if (score === null) return <span className={DIM}>—</span>;
  const tone =
    goal === undefined
      ? 'text-zinc-800 dark:text-zinc-200'
      : score >= goal
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-amber-700 dark:text-amber-400';
  return <span className={tone}>{fmtScore(score)}</span>;
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
                    <div className="inline-flex items-center gap-1.5">
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
            <td key={dates[i]} className={cn(TD, NUM, 'text-center text-zinc-600 dark:text-zinc-300')}>
              <Flash value={t} scope={scope}>{fmtNum(t)}</Flash>
              {withFlag && stats.meetingsByDay[i] ? (
                <span className="ml-1 text-[10px] text-zinc-400">· {stats.meetingsByDay[i]} met</span>
              ) : null}
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
