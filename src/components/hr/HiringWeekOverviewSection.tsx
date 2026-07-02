'use client';

import { useMemo, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { addWeeks, formatWeekLabel, sundayIso } from '@/lib/hr/hiring-week';
import HiringSourcesCard from './HiringSourcesCard';
import HiringByRecruiterCard from './HiringByRecruiterCard';

/**
 * HR Overview: the New Hire Checklist hiring cards (sources + recruiter
 * leaderboard), with a period selector that scopes both to a single Sun–Sat
 * week or back out to all-time. Defaults to next week — the week HR is
 * currently hiring for.
 */
export default function HiringWeekOverviewSection() {
  const [currentSunday] = useState(() => sundayIso(new Date()));
  const [week, setWeek] = useState<string | null>(() => addWeeks(sundayIso(new Date()), 1));

  const badge = useMemo(() => {
    if (week === null) return null;
    if (week === currentSunday) return 'this week';
    if (week === addWeeks(currentSunday, 1)) return 'next week';
    return null;
  }, [week, currentSunday]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-emerald-700/80 dark:text-emerald-400/70">
            New Hire Checklist
          </p>
          <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Hiring
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <div className="flex items-center overflow-hidden rounded-lg border border-emerald-200 dark:border-emerald-800">
            <button
              type="button"
              onClick={() => setWeek(null)}
              className={cn(
                'flex h-8 items-center px-2.5 text-[12px] font-medium transition-colors',
                week === null
                  ? 'bg-emerald-600 text-white'
                  : 'bg-white text-emerald-700 hover:bg-emerald-50 dark:bg-zinc-900 dark:text-emerald-300 dark:hover:bg-emerald-950/40',
              )}
            >
              All time
            </button>
            <button
              type="button"
              onClick={() => setWeek((w) => w ?? addWeeks(currentSunday, 1))}
              className={cn(
                'flex h-8 items-center px-2.5 text-[12px] font-medium transition-colors',
                week !== null
                  ? 'bg-emerald-600 text-white'
                  : 'bg-white text-emerald-700 hover:bg-emerald-50 dark:bg-zinc-900 dark:text-emerald-300 dark:hover:bg-emerald-950/40',
              )}
            >
              By week
            </button>
          </div>

          {week !== null && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setWeek((w) => addWeeks(w ?? currentSunday, -1))}
                aria-label="Previous week"
                className="flex h-8 w-7 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-2.5 text-[13px] font-medium text-zinc-800 dark:border-emerald-800 dark:bg-zinc-900 dark:text-zinc-100">
                <CalendarClock className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                <span className="tabular-nums">{formatWeekLabel(week)}</span>
                {badge && (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                    {badge}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setWeek((w) => addWeeks(w ?? currentSunday, 1))}
                aria-label="Next week"
                className="flex h-8 w-7 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
        <HiringSourcesCard periodStart={week ?? undefined} />
        <HiringByRecruiterCard periodStart={week ?? undefined} />
      </div>
    </section>
  );
}
