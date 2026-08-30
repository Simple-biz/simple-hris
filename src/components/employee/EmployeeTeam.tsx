'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Ban,
  Briefcase,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crown,
  HandHeart,
  HeartHandshake,
  Inbox,
  Languages,
  Mail,
  MonitorCheck,
  Repeat2,
  Search,
  Shield,
  ShieldAlert,
  TimerReset,
  Unplug,
  Users,
  Video,
  WifiOff,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import { useOnlineEmails } from '@/components/presence/PresenceProvider';
import { SkillBlock, TeamAvatar, formatLastSeen } from '@/components/team/team-ui';
import { formatCurrentProjects } from '@/lib/skill-set-titles';
import { cleanErrorMessage } from '@/lib/clean-error-message';
import {
  groupPolicies,
  policiesForDeptKey,
  type PolicyIconKey,
} from '@/lib/policies/team-policies';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import { collapseHslFamilyLabel } from '@/lib/departments/hsl-subdept';
import type { TeamRankingWeek } from '@/lib/supabase/team-rankings';

/* ── Types ──────────────────────────────────────────────────────────────── */

interface SkillSetEntry {
  role_title: string;
  currently_working_on: string;
  skills: string;
  strengths: string;
  member_notes: string;
  projects?: string[];
  current_projects?: string[];
}

interface Teammate {
  id: string;
  name: string;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  suspended: boolean;
  /** True when this person manages the selected department (department_managers). */
  isManager: boolean;
}

type SubTab = 'directory' | 'rankings' | 'policies';

interface Props {
  employeeEmail: string | null;
  department?: string | null;
}

const EASE = [0.22, 1, 0.36, 1] as const;
const PAGE_SIZE = 12;

/* ── Sub-tab pill (§11.1 sliding indicator) ─────────────────────────────── */

function SubTabPill({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        'relative shrink-0 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-orange-50 hover:text-orange-900 dark:text-zinc-300 dark:hover:bg-blue-950/40 dark:hover:text-orange-100',
      )}
    >
      {active && (
        <motion.span
          layoutId="employee-team-subtab"
          className="absolute inset-0 rounded-md bg-gradient-to-r from-orange-500 to-amber-600 shadow-sm shadow-orange-600/25"
          transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        {label}
        {count != null && (
          <span
            className={cn(
              'rounded-full px-1.5 text-[10px] font-semibold leading-[1.35]',
              active ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
            )}
          >
            {count}
          </span>
        )}
      </span>
    </button>
  );
}

const PANE_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 24 : -24 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -24 : 24 }),
};

/* ── Rankings ───────────────────────────────────────────────────────────── */

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

function RankingsPane({
  weeks,
  loading,
  error,
  selfNorm,
  index,
  dir,
  onNavigate,
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
}) {
  const reduce = useReducedMotion();

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading rankings…</span>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-xl border border-zinc-200/80 bg-white p-3 dark:border-blue-950/60 dark:bg-[#0d1117]"
          >
            <div className="skeleton-shimmer h-7 w-7 shrink-0 rounded-lg" />
            <div className="skeleton-shimmer h-8 w-8 shrink-0 rounded-full" />
            <div className="skeleton-shimmer h-3.5 flex-1 rounded" />
            <div className="skeleton-shimmer h-5 w-16 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    );
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
        <span className="shrink-0 rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          {week.status === 'locked' ? 'Final' : 'Submitted'}
        </span>
      </div>

      {/* Rows */}
      <div className="overflow-x-clip">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.ol
            key={week.periodStart}
            custom={dir}
            variants={PANE_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: reduce ? 0 : 0.22, ease: EASE }}
            className="space-y-2"
          >
            {week.rows.map((r, i) => {
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
          </motion.ol>
        </AnimatePresence>
      </div>

      <p className="px-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-500">
        Ranked by story points for the week. Tiers come from your manager&rsquo;s scoring sheet —
        your own bonus figure lives in <span className="font-medium">KPI Results</span>.
      </p>
    </div>
  );
}

/* ── Policies ───────────────────────────────────────────────────────────── */

const POLICY_ICONS: Record<PolicyIconKey, React.ComponentType<{ className?: string }>> = {
  clock: Clock,
  timer: TimerReset,
  calendar: Calendar,
  monitor: MonitorCheck,
  languages: Languages,
  video: Video,
  loop: Repeat2,
  inbox: Inbox,
  shield: ShieldAlert,
  handshake: HeartHandshake,
  ban: Ban,
  heart: HandHeart,
  unplug: Unplug,
};

function PoliciesPane({ deptKey }: { deptKey: string | null }) {
  const set = useMemo(() => policiesForDeptKey(deptKey), [deptKey]);
  const sections = useMemo(() => groupPolicies(set), [set]);
  const reduce = useReducedMotion();

  return (
    <div className="space-y-5">
      <p className="px-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-500">
        {set.sourceUrl ? (
          <>
            The {set.policies.length} expectations for the{' '}
            <span className="font-semibold text-zinc-800 dark:text-zinc-300">{set.teamLabel}</span>{' '}
            team.
          </>
        ) : (
          <>
            Your team doesn&rsquo;t have its own policy page yet, so these are the company-wide
            expectations. Ask your manager for your team&rsquo;s working hours and time-off notice
            period.
          </>
        )}
      </p>

      {sections.map((section, si) => (
        <motion.section
          key={section.id}
          initial={reduce ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : 0.24, ease: EASE, delay: reduce ? 0 : si * 0.05 }}
          className="space-y-2"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-1">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
              {section.label}
            </h3>
            <span className="text-xs text-zinc-500 dark:text-zinc-500">{section.description}</span>
          </div>

          <div className="overflow-hidden rounded-2xl border border-orange-100/80 bg-white shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]">
            <div className="divide-y divide-orange-100/80 dark:divide-blue-950/60">
              {section.policies.map((p) => {
                const Icon = POLICY_ICONS[p.icon];
                return (
                  <div
                    key={p.id}
                    className="flex gap-3 p-4 transition-colors hover:bg-orange-50/40 dark:hover:bg-blue-950/20 sm:gap-4 sm:p-5"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-50 to-orange-100/70 text-orange-600 ring-1 ring-orange-100 dark:from-blue-950/60 dark:to-blue-950/40 dark:text-orange-300 dark:ring-blue-900/60">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h4 className="text-[0.95rem] font-semibold leading-snug text-zinc-900 dark:text-white">
                        {p.title}
                      </h4>
                      <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                        {p.body}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </motion.section>
      ))}

      <div className="rounded-2xl border border-orange-100/80 bg-orange-50/40 p-4 text-sm text-zinc-700 shadow-sm dark:border-blue-950/60 dark:bg-blue-950/20 dark:text-zinc-300 sm:p-5">
        <p className="font-semibold text-zinc-900 dark:text-white">Questions?</p>
        <p className="mt-1 leading-relaxed">
          If anything here is unclear or you think a situation falls in a grey area, reach out to
          your manager before acting — it&rsquo;s always better to ask early.
        </p>
        {set.sourceUrl && (
          <a
            href={set.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs font-medium text-orange-600 underline-offset-2 hover:underline dark:text-orange-400"
          >
            View the published page
          </a>
        )}
      </div>
    </div>
  );
}

/* ── Main ───────────────────────────────────────────────────────────────── */

export default function EmployeeTeam({ employeeEmail, department }: Props) {
  const reduce = useReducedMotion();

  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageDir, setPageDir] = useState<'next' | 'prev'>('next');

  const [tab, setTab] = useState<SubTab>('directory');
  const [tabDir, setTabDir] = useState(1);

  const [rankingWeeks, setRankingWeeks] = useState<TeamRankingWeek[]>([]);
  const [rankingsLoading, setRankingsLoading] = useState(true);
  const [rankingsError, setRankingsError] = useState<string | null>(null);
  // Which week the Rankings pane is showing. Held here (not in the pane) so it
  // survives sub-tab swaps, which unmount the pane via AnimatePresence.
  const [weekIndex, setWeekIndex] = useState(0);
  const [weekDir, setWeekDir] = useState(1);

  const deptLabel = department?.trim() || '';
  const deptKey = useMemo(
    () => (deptLabel ? normalizeDeptToKey(deptLabel) ?? slugifyDeptKey(deptLabel) : null),
    [deptLabel],
  );

  const onlineEmails = useOnlineEmails();
  const selfNorm = normEmail(employeeEmail ?? '') ?? employeeEmail?.trim().toLowerCase() ?? null;

  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const [skillSets, setSkillSets] = useState<Record<string, SkillSetEntry>>({});
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  // Sticky teammate keeps the modal content rendered through the close
  // animation, so base-ui plays its exit against real content.
  const [stickyTeammate, setStickyTeammate] = useState<Teammate | null>(null);

  const goToPage = (n: number) => {
    setPage((prev) => {
      setPageDir(n >= prev ? 'next' : 'prev');
      return n;
    });
  };

  const goToTab = (next: SubTab) => {
    const order: SubTab[] = ['directory', 'rankings', 'policies'];
    setTabDir(order.indexOf(next) >= order.indexOf(tab) ? 1 : -1);
    setTab(next);
  };

  /* Roster + skill sets + initial last-seen in one roundtrip. Keyed on the raw
     department label, which is stable for the life of the session — so coming
     back to this tab (kept mounted by EmployeeApp) re-runs nothing. */
  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    setLoading(true);
    setError(null);
    fetch(`/api/team-roster?department=${encodeURIComponent(deptLabel)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then(
        (j: {
          profiles?: {
            id: string;
            name: string;
            workEmail: string | null;
            personalEmail: string | null;
            department: string | null;
            isManager: boolean;
          }[];
          skillSets?: Record<string, SkillSetEntry>;
          lastSeen?: Record<string, string>;
          error?: string | null;
        }) => {
          if (cancelled) return;
          if (j.error) setError(j.error);
          setTeammates(
            (j.profiles ?? []).map((p) => ({
              id: p.id,
              name: p.name,
              workEmail: p.workEmail,
              personalEmail: p.personalEmail,
              department: p.department,
              suspended: false,
              isManager: p.isManager,
            })),
          );
          setSkillSets(j.skillSets ?? {});
          setLastSeen(j.lastSeen ?? {});
        },
      )
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load your team');
      })
      .finally(() => {
        // Hold skeletons ~500ms so the shimmer reads as polish, not a flash.
        const wait = Math.max(0, 500 - (Date.now() - startedAt));
        window.setTimeout(() => {
          if (!cancelled) setLoading(false);
        }, wait);
      });
    return () => {
      cancelled = true;
    };
  }, [deptLabel]);

  /* Weekly rankings. Same stable key — one fetch per department, not per visit. */
  useEffect(() => {
    let cancelled = false;
    setRankingsLoading(true);
    setRankingsError(null);
    fetch(`/api/team-rankings?department=${encodeURIComponent(deptLabel)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { weeks?: TeamRankingWeek[]; error?: string | null }) => {
        if (cancelled) return;
        if (j.error) setRankingsError(j.error);
        setRankingWeeks(j.weeks ?? []);
      })
      .catch((e) => {
        if (!cancelled) setRankingsError(e instanceof Error ? e.message : 'Failed to load rankings');
      })
      .finally(() => {
        if (!cancelled) setRankingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deptLabel]);

  /* Slow-tick last-seen refresh so "Last seen 1m ago" creeps forward. */
  const rosterEmailsKey = useMemo(
    () =>
      teammates
        .flatMap((t) => [normEmail(t.workEmail ?? '') ?? '', normEmail(t.personalEmail ?? '') ?? ''])
        .filter(Boolean)
        .join(','),
    [teammates],
  );
  useEffect(() => {
    if (!rosterEmailsKey) return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      fetch(`/api/presence/last-seen?emails=${encodeURIComponent(rosterEmailsKey)}`, {
        cache: 'no-store',
      })
        .then((r) => r.json())
        .then((j: { lastSeen?: Record<string, string> }) => {
          if (!cancelled) setLastSeen(j.lastSeen ?? {});
        })
        .catch(() => {
          /* non-fatal */
        });
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [rosterEmailsKey]);

  const isOnline = (t: Teammate): boolean => {
    const w = normEmail(t.workEmail ?? '');
    const p = normEmail(t.personalEmail ?? '');
    return (!!w && onlineEmails.has(w)) || (!!p && onlineEmails.has(p));
  };
  const skillSetFor = (t: Teammate): SkillSetEntry | undefined => {
    const w = normEmail(t.workEmail ?? '');
    return w ? skillSets[w] : undefined;
  };
  const lastSeenFor = (t: Teammate): string | null => {
    const w = normEmail(t.workEmail ?? '');
    const p = normEmail(t.personalEmail ?? '');
    return (w && lastSeen[w]) || (p && lastSeen[p]) || null;
  };
  const isSelf = (t: Teammate): boolean => {
    if (!selfNorm) return false;
    return normEmail(t.workEmail ?? '') === selfNorm || normEmail(t.personalEmail ?? '') === selfNorm;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? teammates.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.workEmail?.toLowerCase().includes(q) ?? false) ||
            (t.personalEmail?.toLowerCase().includes(q) ?? false),
        )
      : teammates;
    // Managers first, then online, then alphabetical.
    return [...matches].sort((a, b) => {
      const am = a.isManager ? 0 : 1;
      const bm = b.isManager ? 0 : 1;
      if (am !== bm) return am - bm;
      const ao = isOnline(a) ? 0 : 1;
      const bo = isOnline(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teammates, query, onlineEmails]);

  const onlineCount = useMemo(
    () => teammates.filter(isOnline).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teammates, onlineEmails],
  );

  useEffect(() => {
    if (!activeProfileId) return;
    const found = teammates.find((t) => t.id === activeProfileId);
    if (found) setStickyTeammate(found);
  }, [activeProfileId, teammates]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => {
    setPage(1);
  }, [query, deptLabel]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const pageStart = (page - 1) * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, filtered.length);
  const pageItems = filtered.slice(pageStart, pageEnd);

  function pageNumbers(current: number, total: number): (number | 'gap')[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const out: (number | 'gap')[] = [1];
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    if (start > 2) out.push('gap');
    for (let i = start; i <= end; i += 1) out.push(i);
    if (end < total - 1) out.push('gap');
    out.push(total);
    return out;
  }

  // Clamp the shown week if the list shrinks under us (a week un-readied by a
  // manager, or a department change).
  useEffect(() => {
    setWeekIndex((i) => Math.min(i, Math.max(0, rankingWeeks.length - 1)));
  }, [rankingWeeks.length]);

  // The Rankings tab only exists for teams that are actually scored on SP.
  const hasRankings = rankingWeeks.length > 0;
  const tabsRef = useRef<SubTab>(tab);
  tabsRef.current = tab;
  useEffect(() => {
    if (!hasRankings && !rankingsLoading && tabsRef.current === 'rankings') setTab('directory');
  }, [hasRankings, rankingsLoading]);

  // Display only. `deptLabel` stays RAW for the two fetches above — the roster
  // route scopes on the master-list value, so collapsing it there would fail the
  // allow-list. An `hsl:*` cell shows as a single "HSL" per hsl-subdepartments.md.
  const heading = collapseHslFamilyLabel(deptLabel) || 'My Team';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-y-contain bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 [scrollbar-gutter:stable] sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-7xl space-y-5">
        {/* Header */}
        <header>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
              {heading}
            </h2>
            {!loading && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-transparent dark:text-zinc-300">
                  <Users className="h-3 w-3" aria-hidden />
                  {teammates.length}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70 motion-reduce:hidden" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  {onlineCount} online
                </span>
              </div>
            )}
          </div>
          {/* Never advertise the Rankings pill to a viewer who doesn't get one —
              the tab is allow-listed server-side (rankings-viewers.ts), so for
              almost everyone `hasRankings` is false and the sentence must not
              name a section that isn't there. */}
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-500">
            {hasRankings
              ? 'Your team directory, weekly rankings, and the policies for this team.'
              : 'Your team directory and the policies for this team.'}
          </p>
        </header>

        {/* Sub-tabs */}
        <div
          role="tablist"
          aria-label="Team sections"
          className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <SubTabPill
            label="Directory"
            active={tab === 'directory'}
            onClick={() => goToTab('directory')}
            count={teammates.length || undefined}
          />
          {hasRankings && (
            <SubTabPill
              label="Rankings"
              active={tab === 'rankings'}
              onClick={() => goToTab('rankings')}
            />
          )}
          <SubTabPill
            label="Policies"
            active={tab === 'policies'}
            onClick={() => goToTab('policies')}
          />
        </div>

        {/* Panes */}
        <div className="overflow-x-clip">
          <AnimatePresence mode="wait" initial={false} custom={tabDir}>
            <motion.div
              key={tab}
              custom={tabDir}
              variants={PANE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: reduce ? 0 : 0.26, ease: EASE }}
            >
              {tab === 'directory' && (
                <div className="space-y-4">
                  {/* Search */}
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search by name or email"
                      aria-label="Search teammates"
                      className="w-full rounded-xl border border-orange-100 bg-white py-2.5 pl-9 pr-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-blue-950/60 dark:bg-[#0d1117] dark:text-zinc-100 dark:focus:border-blue-800 dark:focus:ring-blue-900/40"
                    />
                  </div>

                  {loading ? (
                    <div
                      className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                      aria-busy="true"
                      aria-live="polite"
                    >
                      <span className="sr-only">Loading your team…</span>
                      {Array.from({ length: 8 }).map((_, i) => (
                        <div
                          key={i}
                          className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]"
                        >
                          <div className="flex items-center gap-3">
                            <div className="skeleton-shimmer h-10 w-10 shrink-0 rounded-full" />
                            <div className="flex-1 space-y-2">
                              <div className="skeleton-shimmer h-3.5 w-3/5 rounded" />
                              <div className="skeleton-shimmer h-3 w-2/5 rounded" />
                            </div>
                          </div>
                          <div className="mt-3 flex items-center gap-2">
                            <div className="skeleton-shimmer h-3 w-3 rounded-sm" />
                            <div className="skeleton-shimmer h-3 w-4/5 rounded" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : error ? (
                    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-14 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
                      <WifiOff className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
                      <p className="text-sm text-zinc-500">{cleanErrorMessage(error)}</p>
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-16 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-400 dark:bg-blue-950/40">
                        <Users className="h-5 w-5" />
                      </div>
                      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                        {query ? 'No teammates match your search.' : 'No teammates to show yet.'}
                      </p>
                    </div>
                  ) : (
                    <div
                      key={`page-${page}-${query}`}
                      className={cn(
                        'grid grid-cols-1 items-start gap-3 animate-in fade-in duration-300 ease-out motion-reduce:animate-none sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
                        pageDir === 'next' ? 'slide-in-from-right-8' : 'slide-in-from-left-8',
                      )}
                    >
                      {pageItems.map((t) => {
                        const online = isOnline(t);
                        const self = isSelf(t);
                        const email = t.workEmail ?? t.personalEmail;
                        const seenIso = online ? null : lastSeenFor(t);
                        const ss = skillSetFor(t);
                        const roleLine = ss?.role_title?.trim() || null;
                        const workingOn = formatCurrentProjects(
                          ss?.current_projects,
                          ss?.currently_working_on,
                        );
                        return (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setActiveProfileId(t.id)}
                            aria-haspopup="dialog"
                            className={cn(
                              'group relative w-full overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-4 text-left shadow-sm',
                              'transition-[transform,box-shadow,border-color] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                              'hover:-translate-y-0.5 hover:border-orange-200 hover:shadow-md hover:shadow-orange-100/40',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400',
                              'dark:border-blue-950/60 dark:bg-[#0d1117] dark:hover:border-blue-900 dark:hover:shadow-blue-950/40',
                            )}
                          >
                            <div className="flex items-center gap-3">
                              <div className="relative shrink-0">
                                <TeamAvatar name={t.name} email={email} />
                                <span
                                  className={cn(
                                    'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white dark:ring-[#0d1117]',
                                    online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                                  )}
                                  title={
                                    online
                                      ? 'Online'
                                      : seenIso
                                      ? `Last seen ${new Date(seenIso).toLocaleString()}`
                                      : 'Offline'
                                  }
                                  aria-hidden
                                />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <h4 className="truncate text-[0.95rem] font-semibold leading-snug text-zinc-900 dark:text-white">
                                    {t.name}
                                  </h4>
                                  {t.isManager && (
                                    <Shield
                                      className="h-3.5 w-3.5 shrink-0 text-violet-500 dark:text-violet-400"
                                      aria-label="Manager"
                                    />
                                  )}
                                  {self && (
                                    <span className="shrink-0 rounded bg-orange-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-orange-700 dark:bg-blue-950/50 dark:text-orange-300">
                                      You
                                    </span>
                                  )}
                                </div>
                                {roleLine && (
                                  <p
                                    className="mt-0.5 truncate text-[12.5px] leading-snug text-zinc-500 dark:text-zinc-400"
                                    title={roleLine}
                                  >
                                    {roleLine}
                                  </p>
                                )}
                              </div>
                            </div>

                            <div className="mt-3 flex items-center gap-2 text-[12.5px] text-zinc-500 dark:text-zinc-400">
                              <Mail className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate" title={email ?? undefined}>
                                {email ?? 'No email on file'}
                              </span>
                            </div>

                            {workingOn && (
                              <div className="mt-1.5 flex items-start gap-2 text-[12.5px] text-zinc-500 dark:text-zinc-400">
                                <Briefcase className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span className="line-clamp-2 leading-snug" title={workingOn}>
                                  {workingOn}
                                </span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {!loading && !error && filtered.length > PAGE_SIZE && (
                    <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Showing{' '}
                        <span className="font-semibold text-zinc-700 dark:text-zinc-200">
                          {pageStart + 1}
                        </span>
                        –
                        <span className="font-semibold text-zinc-700 dark:text-zinc-200">
                          {pageEnd}
                        </span>{' '}
                        of{' '}
                        <span className="font-semibold text-zinc-700 dark:text-zinc-200">
                          {filtered.length}
                        </span>
                      </p>
                      <nav
                        aria-label="Pagination"
                        className="inline-flex items-center gap-1 rounded-xl border border-orange-100/80 bg-white p-1 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]"
                      >
                        <button
                          type="button"
                          onClick={() => goToPage(Math.max(1, page - 1))}
                          disabled={page === 1}
                          aria-label="Previous page"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-orange-50 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-orange-300"
                        >
                          <ChevronLeft className="h-4 w-4" />
                        </button>
                        {pageNumbers(page, totalPages).map((n, i) =>
                          n === 'gap' ? (
                            <span
                              key={`gap-${i}`}
                              className="px-1.5 text-xs text-zinc-400 dark:text-zinc-600"
                              aria-hidden
                            >
                              …
                            </span>
                          ) : (
                            <button
                              key={n}
                              type="button"
                              onClick={() => goToPage(n)}
                              aria-current={n === page ? 'page' : undefined}
                              className={cn(
                                'inline-flex h-8 min-w-[2rem] items-center justify-center rounded-lg px-2 text-xs font-semibold transition-colors',
                                n === page
                                  ? 'bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-sm'
                                  : 'text-zinc-600 hover:bg-orange-50 hover:text-orange-600 dark:text-zinc-300 dark:hover:bg-blue-950/40 dark:hover:text-orange-300',
                              )}
                            >
                              {n}
                            </button>
                          ),
                        )}
                        <button
                          type="button"
                          onClick={() => goToPage(Math.min(totalPages, page + 1))}
                          disabled={page === totalPages}
                          aria-label="Next page"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-orange-50 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-orange-300"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      </nav>
                    </div>
                  )}
                </div>
              )}

              {tab === 'rankings' && (
                <RankingsPane
                  weeks={rankingWeeks}
                  loading={rankingsLoading}
                  error={rankingsError}
                  selfNorm={selfNorm}
                  index={weekIndex}
                  dir={weekDir}
                  onNavigate={(next, direction) => {
                    setWeekDir(direction);
                    setWeekIndex(next);
                  }}
                />
              )}

              {tab === 'policies' && <PoliciesPane deptKey={deptKey} />}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Profile modal */}
        <Dialog
          open={!!activeProfileId}
          onOpenChange={(o) => {
            if (!o) setActiveProfileId(null);
          }}
        >
          {stickyTeammate &&
            (() => {
              const t = stickyTeammate;
              const ss = skillSetFor(t);
              const email = t.workEmail ?? t.personalEmail;
              const online = isOnline(t);
              const seenRel = online ? null : formatLastSeen(lastSeenFor(t));
              return (
                <DialogContent className="gap-0 overflow-hidden border-orange-100/80 bg-white p-0 sm:max-w-4xl dark:border-blue-950/60 dark:bg-[#0d1117]">
                  <div className="grid sm:grid-cols-[280px_1fr]">
                    <div className="flex flex-col gap-3 bg-gradient-to-br from-orange-50 via-white to-blue-50/60 p-6 sm:border-r sm:border-orange-100/60 dark:from-blue-950/40 dark:via-[#0d1117] dark:to-blue-950/30 dark:sm:border-blue-950/40">
                      <div className="relative self-start">
                        <TeamAvatar name={t.name} email={email} size="xl" />
                        <span
                          className={cn(
                            'absolute bottom-1 right-1 h-4 w-4 rounded-full ring-2 ring-white dark:ring-[#0d1117]',
                            online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                          )}
                          aria-hidden
                        />
                      </div>
                      <div className="space-y-1">
                        <DialogTitle className="text-xl font-bold leading-tight text-zinc-900 dark:text-white">
                          {t.name}
                        </DialogTitle>
                        {ss?.role_title?.trim() && (
                          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                            {ss.role_title}
                          </p>
                        )}
                        {t.department && (
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t.department}</p>
                        )}
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {t.isManager && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                              <Shield className="h-2.5 w-2.5" />
                              Manager
                            </span>
                          )}
                          {isSelf(t) && (
                            <span className="rounded-md bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700 dark:bg-blue-950/50 dark:text-orange-300">
                              You
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 space-y-2 border-t border-zinc-200/60 pt-3 text-sm dark:border-zinc-800/60">
                        {email && (
                          <div className="flex items-start gap-2 text-zinc-600 dark:text-zinc-300">
                            <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
                            <span className="break-all">{email}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300">
                          <span
                            className={cn(
                              'h-2 w-2 rounded-full',
                              online ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-500',
                            )}
                          />
                          <span>
                            {online ? 'Online now' : seenRel ? `Last seen ${seenRel}` : 'Offline'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="max-h-[75vh] overflow-y-auto p-6">
                      <DialogDescription className="sr-only">
                        Full profile and skill set for {t.name}.
                      </DialogDescription>
                      {ss ? (
                        <div className="space-y-4">
                          <SkillBlock
                            label="Currently Working On"
                            value={
                              formatCurrentProjects(ss.current_projects, ss.currently_working_on) ?? ''
                            }
                          />
                          <SkillBlock label="Skills" value={ss.skills} chip chipPageSize={60} />
                          <div className="grid gap-4 sm:grid-cols-2">
                            <SkillBlock label="Strengths" value={ss.strengths} />
                            <SkillBlock label="Member Notes" value={ss.member_notes} />
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm italic text-zinc-400 dark:text-zinc-600">
                          This teammate hasn&apos;t shared any profile details yet.
                        </p>
                      )}
                    </div>
                  </div>
                </DialogContent>
              );
            })()}
        </Dialog>
      </div>
    </div>
  );
}
