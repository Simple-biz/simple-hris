'use client';

/**
 * The weekly SP rankings view, shared by the EMPLOYEE team tab and the MANAGER
 * My Team department view.
 *
 * Extracted 2026-09-14 when Kane asked for rankings on Manager → My Team → AI/API
 * Team. Copying it would have been faster and wrong: this view carries a rule that
 * must hold identically on both surfaces —
 *
 * **SP and TIER, never pesos.** `manager-my-team.md` strips compensation from every
 * My Team surface, and rankings are the one place a teammate sees another person's
 * KPI row. `amount` is absent from `getTeamRankings`' projection — not
 * selected-then-dropped — and a test pins the projection STRING, because a widened
 * SELECT ships pay even against a clean render. Two copies of this component would
 * be two places for a peso column to appear.
 *
 * **`vars.Ranking` is a TIER FLAG (1 / 25 / 50 / 0), not a position.** The `#1..#n`
 * shown is DERIVED by sorting SP descending and is never stored.
 *
 * Who may see it is decided upstream, by `canViewTeamRankings` — a one-name
 * allow-list sitting ABOVE the elevated-role bypass (Kane, 2026-08-29, reaffirmed
 * 2026-09-14). This component renders whatever weeks it is handed and gates nothing.
 *
 * **`showPodium`** (Manager → My Team only, Kane 2026-09-27: *"AI/API Team should have
 * the top 3 as well please"*) adds the gold / silver / bronze top three the other My
 * Team leaderboards open with. It shows the SAME fields as the rows — SP, project SP,
 * the tier — so it can carry nothing a row does not. Opt-in, so the Employee tab is
 * unchanged.
 */
import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronLeft, ChevronRight, Crown, Medal, WifiOff } from 'lucide-react';
import { TeamAvatar } from '@/components/team/team-ui';
import { RankingsSkeleton } from '@/components/team/RankingsSkeleton';
import { RankingsNoMatch, RankingsSearch } from '@/components/team/RankingsSearch';
import { normalizeRankingQuery, rankingRowMatches } from '@/lib/manager/rankings-search';
import { cn } from '@/lib/utils';
import { cleanErrorMessage } from '@/lib/clean-error-message';
import type { TeamRankingWeek } from '@/lib/supabase/team-rankings';

/** The project's arrival curve. */
const EASE = [0.22, 1, 0.36, 1] as const;

/** Horizontal slide between weeks; `dir` is the navigation direction. */
const PANE_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 24 : -24 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -24 : 24 }),
};

const TIER_STYLE: Record<number, { label: string; className: string }> = {
  1: {
    label: 'Rank 1',
    className:
      'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
  },
  25: {
    label: 'Top 25%',
    className:
      'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200',
  },
  50: {
    label: 'Top 50%',
    className:
      'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200',
  },
};

/** Gold / silver / bronze — rank, not money. The same three the My Team leaderboards use. */
const PODIUM = [
  'from-amber-400 to-amber-600',
  'from-zinc-300 to-zinc-500',
  'from-orange-400 to-orange-700',
] as const;

function formatWeek(startIso: string, endIso: string): string {
  const fmt = (iso: string, withYear: boolean) => {
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    // Date-only column — build in local time so the label never slips a day.
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' } : {}),
    });
  };
  return `${fmt(startIso, false)} – ${fmt(endIso, true)}`;
}

export function RankingsPane({
  weeks,
  loading,
  error,
  selfNorm,
  index,
  dir,
  onNavigate,
  showPodium = false,
  searchable = false,
  workEmailsFor,
}: {
  weeks: TeamRankingWeek[];
  loading: boolean;
  error: string | null;
  selfNorm: string | null;
  /** Which week is shown. Owned by the parent so the position survives a
   *  sub-tab hop — AnimatePresence unmounts this pane on every swap. */
  index: number;
  dir: number;
  onNavigate: (nextIndex: number, direction: number) => void;
  /** The top three as a podium above the list (Manager → My Team). */
  showPodium?: boolean;
  /**
   * A search box over the displayed name + WORK emails (Manager → My Team; Kane
   * 2026-09-27). Rows are keyed by the applied row's email, which is personal-first,
   * so the work emails come from the caller's roster via `workEmailsFor` — the row's
   * own email is never matched. It persists across week navigation, so a manager can
   * follow one person week to week.
   */
  searchable?: boolean;
  workEmailsFor?: (rowEmail: string) => readonly string[];
}) {
  const reduce = useReducedMotion();
  const [query, setQuery] = useState('');

  if (loading) {
    // The podium placeholder only where the podium will appear (Manager → My Team).
    return <RankingsSkeleton podium={showPodium} />;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-14 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
        <WifiOff className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
        <p className="text-sm text-zinc-500">{cleanErrorMessage(error)}</p>
      </div>
    );
  }

  const week = weeks[index];
  if (!week) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-16 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-400 dark:bg-blue-950/40">
          <Crown className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
          No rankings published yet.
        </p>
        <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
          A week appears here once your manager submits it.
        </p>
      </div>
    );
  }

  const go = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next > weeks.length - 1) return;
    onNavigate(next, delta);
  };

  const topSp = Math.max(1, ...week.rows.map((r) => r.sp));
  const q = searchable ? normalizeRankingQuery(query) : '';
  const rows = q
    ? week.rows.filter((r) => rankingRowMatches(q, { name: r.name, workEmails: workEmailsFor?.(r.email) ?? [] }))
    : week.rows;

  return (
    <div className="space-y-4">
      {/* Week scroller */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-orange-100/80 bg-white px-3 py-2 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => go(1)}
            disabled={index >= weeks.length - 1}
            aria-label="Older week"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-orange-50 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-orange-300"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
              {formatWeek(week.periodStart, week.periodEnd)}
            </p>
            <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-500">
              {week.bonusName} · {week.rows.length} scored
            </p>
          </div>
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={index <= 0}
            aria-label="Newer week"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-orange-50 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-orange-300"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          {searchable && <RankingsSearch value={query} onChange={setQuery} className="min-w-0 flex-1 sm:w-48 sm:flex-none" />}
          <span className="shrink-0 rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            {week.status === 'locked' ? 'Final' : 'Submitted'}
          </span>
        </div>
      </div>

      {/* Rows */}
      <div className="overflow-x-clip">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div
            key={week.periodStart}
            custom={dir}
            variants={PANE_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: reduce ? 0 : 0.22, ease: EASE }}
            className="space-y-3"
          >
          {showPodium && !q && week.rows.length > 0 && (
            <ol className="grid gap-2 sm:grid-cols-3" aria-label="Top three this week">
              {week.rows.slice(0, 3).map((r) => {
                const tier = TIER_STYLE[r.tier];
                return (
                  <li
                    key={`podium:${r.email}`}
                    className="flex items-center gap-3 rounded-xl border border-zinc-200/80 bg-white p-3 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]"
                  >
                    <span
                      className={cn(
                        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm',
                        PODIUM[Math.min(r.position, 3) - 1] ?? PODIUM[2],
                      )}
                      aria-label={`Rank ${r.position}`}
                    >
                      {r.position === 1 ? <Crown className="h-3.5 w-3.5" aria-hidden /> : <Medal className="h-3.5 w-3.5" aria-hidden />}
                    </span>
                    <TeamAvatar name={r.name} email={r.email} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">{r.name}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                        {r.projectSp > 0 && <span className="truncate tabular-nums">{r.projectSp} project SP</span>}
                        {tier && (
                          <span
                            className={cn(
                              'shrink-0 rounded-full border px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide',
                              tier.className,
                            )}
                          >
                            {tier.label}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-lg font-bold leading-none tabular-nums text-zinc-900 dark:text-zinc-100">
                        {r.sp}
                      </span>
                      <span className="block text-[10px] uppercase tracking-wide text-zinc-500">SP</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {q && rows.length === 0 && <RankingsNoMatch query={query} />}
          <ol className="space-y-2">
            {rows.map((r, i) => {
              const isSelf = !!selfNorm && r.email === selfNorm;
              const tier = TIER_STYLE[r.tier];
              return (
                <motion.li
                  key={r.email}
                  initial={reduce ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: reduce ? 0 : 0.18,
                    ease: 'easeOut',
                    delay: reduce ? 0 : Math.min(i * 0.02, 0.2),
                  }}
                  className={cn(
                    'relative flex items-center gap-3 overflow-hidden rounded-xl border bg-white p-3 shadow-sm dark:bg-[#0d1117]',
                    isSelf
                      ? 'border-orange-300 ring-1 ring-orange-200 dark:border-orange-500/50 dark:ring-orange-500/20'
                      : 'border-zinc-200/80 dark:border-blue-950/60',
                  )}
                >
                  {/* SP proportion rail — a quiet sense of the gap between people. */}
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-orange-50/70 dark:bg-blue-950/30"
                    style={{ width: `${Math.round((r.sp / topSp) * 100)}%` }}
                  />
                  <span
                    className={cn(
                      'relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold tabular-nums',
                      r.position === 1
                        ? 'bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-sm'
                        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
                    )}
                  >
                    {r.position === 1 ? <Crown className="h-3.5 w-3.5" aria-label="Rank 1" /> : r.position}
                  </span>
                  <div className="relative z-10 shrink-0">
                    <TeamAvatar name={r.name} email={r.email} size="sm" />
                  </div>
                  <div className="relative z-10 min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[13.5px] font-semibold text-zinc-900 dark:text-white">
                        {r.name}
                      </p>
                      {isSelf && (
                        <span className="shrink-0 rounded bg-orange-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-orange-700 dark:bg-blue-950/50 dark:text-orange-300">
                          You
                        </span>
                      )}
                    </div>
                    <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                      <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
                        {r.sp}
                      </span>{' '}
                      SP
                      {r.projectSp > 0 && (
                        <>
                          {' · '}
                          <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
                            {r.projectSp}
                          </span>{' '}
                          project SP
                        </>
                      )}
                    </p>
                  </div>
                  {tier && (
                    <span
                      className={cn(
                        'relative z-10 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        tier.className,
                      )}
                    >
                      {tier.label}
                    </span>
                  )}
                </motion.li>
              );
            })}
          </ol>
          </motion.div>
        </AnimatePresence>
      </div>

      <p className="px-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-500">
        Ranked by story points for the week. Tiers come from your manager&rsquo;s scoring sheet —
        your own bonus figure lives in <span className="font-medium">KPI Results</span>.
      </p>
    </div>
  );
}
