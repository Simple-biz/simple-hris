'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketMember,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
} from '@/lib/tickets/types';
import { PRIORITY_STYLES, STATUS_STYLES, initialsFor, relativeTime } from './TicketCard';

/**
 * /tickets → Overview: headline counts and breakdowns computed client-side
 * from the same board fetch (no extra endpoint; realtime refreshes flow in).
 *
 * Layout: two columns on lg+. The left/middle two-thirds carry the numbers —
 * one lead figure (Open now — the number this board exists to drive down),
 * four compact stat tiles, the two breakdowns, then the recent-activity list.
 * The right third is the Members rail (who can see this board — the one
 * server-fetched block, from /api/tickets/members). Everything stacks on
 * smaller screens. Per-status counts live only in the Board split legend;
 * they used to be duplicated as a KPI tile per status.
 *
 * Chart-color note: the bars reuse the board's exact status/priority hues so
 * every surface speaks one color vocabulary (color follows the entity). CVD
 * separation and 3:1 contrast of both sets were validated against the console
 * card surface; the legibility duty is carried by mandatory direct labels
 * (name + count on every row/segment) and 2px surface gaps between stacked
 * segments — never by hue alone.
 */

interface TicketsOverviewProps {
  tickets: TicketRow[];
  loaded: boolean;
  onOpenTicket: (t: TicketRow) => void;
  /** Board members, fetched once by TicketsBoard (shared with the assignee
   *  pickers and card labels). `null` = still loading. */
  members: TicketMember[] | null;
  membersError: string | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** iOS-style Liquid Glass surface for the KPI cards — a crisp frosted pane like
 *  the iPhone Control Center, not a smoked tint. The full recipe (vibrancy blur
 *  + saturation, even frost, bright hairline edge, soft top highlight) lives in
 *  `.kpi-glass` in index.css; rounding/padding stay on the element's own
 *  utilities. Only the KPI row wears it, so the glass reads as a moment. */
const GLASS_CARD = 'kpi-glass';

function ageDays(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? '<1d' : `${days}d`;
}

/** Signed week-over-week movement, or undefined when there is nothing to say. */
function weekDelta(cur: number, prev: number): string | undefined {
  if (cur === 0 && prev === 0) return undefined;
  const d = cur - prev;
  if (d === 0) return 'same as prior week';
  return `${d > 0 ? '+' : ''}${d} vs prior week`;
}

export default function TicketsOverview({
  tickets,
  loaded,
  onOpenTicket,
  members,
  membersError,
}: TicketsOverviewProps) {
  const stats = useMemo(() => {
    const byStatus = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<
      TicketStatus,
      number
    >;
    const openByPriority = Object.fromEntries(TICKET_PRIORITIES.map((p) => [p, 0])) as Record<
      TicketPriority,
      number
    >;
    const now = Date.now();
    let createdThisWeek = 0;
    let createdPrevWeek = 0;
    let completedThisWeek = 0;
    let completedPrevWeek = 0;

    for (const t of tickets) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      if (t.status !== 'done') openByPriority[t.priority] = (openByPriority[t.priority] ?? 0) + 1;
      const createdAge = now - Date.parse(t.created_at);
      if (createdAge < WEEK_MS) createdThisWeek++;
      else if (createdAge < 2 * WEEK_MS) createdPrevWeek++;
      // `updated_at` bumps on every edit, so this reads "reached Done and
      // untouched since within the window" — close enough for a pulse figure.
      if (t.status === 'done') {
        const doneAge = now - Date.parse(t.updated_at);
        if (doneAge < WEEK_MS) completedThisWeek++;
        else if (doneAge < 2 * WEEK_MS) completedPrevWeek++;
      }
    }

    const total = tickets.length;
    const done = byStatus.done;
    const open = total - done;
    const oldestOpen =
      [...tickets]
        .filter((t) => t.status !== 'done')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
    const recent = [...tickets]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 6);

    return {
      byStatus,
      openByPriority,
      total,
      done,
      open,
      solvedPct: total > 0 ? Math.round((done / total) * 100) : 0,
      createdThisWeek,
      createdPrevWeek,
      completedThisWeek,
      completedPrevWeek,
      oldestOpen,
      recent,
      urgentOpen: openByPriority.urgent,
      maxOpenPriority: Math.max(1, ...Object.values(openByPriority)),
    };
  }, [tickets]);

  if (!loaded) {
    return (
      <div className="mx-auto grid w-full max-w-7xl items-start gap-4 p-4 sm:p-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
            <Skeleton className="col-span-2 h-36 rounded-xl" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <Skeleton className="h-48 rounded-xl" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
          <Skeleton className="h-44 rounded-xl" />
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-7xl items-start gap-4 p-4 sm:p-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
      {/* ── KPI block: one full-width lead figure + four compact tiles ──────── */}
      <div className="relative grid grid-cols-2 gap-3 xl:grid-cols-4">
        <section className={cn('relative col-span-2 overflow-hidden rounded-xl p-4 sm:p-5 xl:col-span-4', GLASS_CARD)}>
          {/* Window-chrome row: control dots + a quiet "open · now" tag. */}
          <div className="flex items-center justify-between gap-2">
            <WindowDots />
            <span className="text-xs text-muted-foreground">open · now</span>
          </div>
          {/* Metric label + urgent flag on one line, the lead figure below. */}
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Open now</p>
            {stats.urgentOpen > 0 && (
              <span
                className={cn(
                  'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium',
                  PRIORITY_STYLES.urgent.chip,
                )}
              >
                <span className={cn('size-1.5 rounded-full', PRIORITY_STYLES.urgent.dot)} aria-hidden />
                {stats.urgentOpen} urgent
              </span>
            )}
          </div>
          <p className="mt-1.5 text-5xl leading-none font-semibold">{stats.open}</p>
          <div className="mt-4 border-t border-border" />
          {stats.oldestOpen ? (
            <div className="-mx-2 mt-1">
              <button
                type="button"
                onClick={() => onOpenTicket(stats.oldestOpen as TicketRow)}
                title="Open the oldest unresolved ticket"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              >
                <span className="shrink-0 text-xs text-muted-foreground">Oldest</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  #{stats.oldestOpen.ticket_no}
                </span>
                <span className="min-w-0 truncate font-medium">{stats.oldestOpen.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {ageDays(stats.oldestOpen.created_at)}
                </span>
              </button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              {stats.total > 0
                ? 'All caught up. Nothing is open right now.'
                : 'No tickets yet. New requests land here.'}
            </p>
          )}
        </section>

        <StatTile label="Total tickets" value={stats.total} />
        <StatTile
          label="Solved"
          value={stats.done}
          sub={stats.total > 0 ? `${stats.solvedPct}% of all tickets` : undefined}
        />
        <StatTile
          label="New this week"
          value={stats.createdThisWeek}
          sub={weekDelta(stats.createdThisWeek, stats.createdPrevWeek)}
        />
        <StatTile
          label="Done this week"
          value={stats.completedThisWeek}
          sub={weekDelta(stats.completedThisWeek, stats.completedPrevWeek)}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ── Board split (part-to-whole) ─────────────────────────────────────── */}
        <OverviewCard title="Board split" caption="Where every ticket sits right now">
          {stats.total === 0 ? (
            <EmptyNote>No tickets yet. The split appears with the first request.</EmptyNote>
          ) : (
            <>
              <div
                className="ticket-bar-grow flex h-2.5 gap-[2px] overflow-hidden rounded-full"
                role="img"
                aria-label={`Tickets per column: ${TICKET_STATUSES.map(
                  (s) => `${STATUS_STYLES[s].label} ${stats.byStatus[s]}`,
                ).join(', ')}`}
              >
                {TICKET_STATUSES.filter((s) => stats.byStatus[s] > 0).map((s) => (
                  <div
                    key={s}
                    className={cn('h-full', STATUS_STYLES[s].dot)}
                    style={{ width: `${(stats.byStatus[s] / stats.total) * 100}%`, minWidth: 6 }}
                    title={`${STATUS_STYLES[s].label}: ${stats.byStatus[s]} (${Math.round((stats.byStatus[s] / stats.total) * 100)}%)`}
                  />
                ))}
              </div>
              <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2">
                {TICKET_STATUSES.map((s) => (
                  <div key={s} className="flex items-center gap-2 text-sm">
                    <span className={cn('size-2 shrink-0 rounded-full', STATUS_STYLES[s].dot)} aria-hidden />
                    <span className="text-muted-foreground">{STATUS_STYLES[s].label}</span>
                    <span className="ml-auto font-medium tabular-nums">
                      {stats.byStatus[s]}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        {stats.total > 0 ? Math.round((stats.byStatus[s] / stats.total) * 100) : 0}%
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </OverviewCard>

        {/* ── Open by priority (magnitude) ────────────────────────────────────── */}
        <OverviewCard title="Open by priority" caption="Everything not yet done">
          {stats.open === 0 ? (
            <EmptyNote>No open tickets right now.</EmptyNote>
          ) : (
            <div className="space-y-3">
              {[...TICKET_PRIORITIES].reverse().map((p, i) => {
                const count = stats.openByPriority[p];
                return (
                  <div
                    key={p}
                    className="flex items-center gap-3 text-sm"
                    title={`${PRIORITY_STYLES[p].label}: ${count} open`}
                  >
                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                      {PRIORITY_STYLES[p].label}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/60">
                      {count > 0 && (
                        <div
                          className={cn('ticket-bar-grow h-full rounded-r-full', PRIORITY_STYLES[p].dot)}
                          style={{
                            width: `${(count / stats.maxOpenPriority) * 100}%`,
                            minWidth: 8,
                            animationDelay: `${i * 50}ms`,
                          }}
                        />
                      )}
                    </div>
                    <span className="w-6 shrink-0 text-right font-medium tabular-nums">{count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </OverviewCard>
      </div>

      {/* ── Recent activity ─────────────────────────────────────────────────── */}
      <OverviewCard title="Recent activity" caption="Latest updated tickets">
        {stats.recent.length === 0 ? (
          <EmptyNote>Activity shows up here once tickets start moving.</EmptyNote>
        ) : (
          <div className="-mx-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
            {stats.recent.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onOpenTicket(t)}
                className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              >
                <span className="w-9 shrink-0 font-mono text-xs text-muted-foreground">
                  #{t.ticket_no}
                </span>
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={cn('size-1.5 rounded-full', STATUS_STYLES[t.status].dot)} aria-hidden />
                  {STATUS_STYLES[t.status].label}
                </span>
                <span className="w-14 shrink-0 text-right text-xs text-muted-foreground/80">
                  {relativeTime(t.updated_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </OverviewCard>
      </div>

      {/* ── Members rail (right column) ─────────────────────────────────────── */}
      <div className="min-w-0">
        <OverviewCard
          title="Members"
          caption={`Everyone with access to this board${members && members.length > 0 ? ` · ${members.length}` : ''}`}
        >
          <MembersTable members={members} error={membersError} />
        </OverviewCard>
      </div>
    </div>
  );
}

// ── Members table ─────────────────────────────────────────────────────────────

const ACCESS_STYLES: Record<TicketMember['access'], { label: string; chip: string; dot: string }> = {
  admin: {
    label: 'Admin',
    chip: 'bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-400',
    dot: 'bg-red-500',
  },
  edit: {
    label: 'Edit',
    chip: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  view: {
    label: 'View',
    chip: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground/60',
  },
};

/** Rows per Members page — sized so the rail stays about as tall as the left
 *  column instead of scrolling the whole Overview. */
const MEMBERS_PAGE_SIZE = 8;

/** Profile photo with an initials fallback (missing URL or a broken image). */
function MemberAvatar({ member }: { member: TicketMember }) {
  const [broken, setBroken] = useState(false);
  const showPhoto = Boolean(member.photo_url) && !broken;
  return (
    <span
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[11px] font-semibold text-muted-foreground"
      aria-hidden
    >
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element -- external avatar hosts (Google SSO, Supabase Storage) aren't in next/image's allowlist
        <img
          src={member.photo_url as string}
          alt=""
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        initialsFor(member.name, member.email)
      )}
    </span>
  );
}

function MembersTable({ members, error }: { members: TicketMember[] | null; error: string | null }) {
  const [page, setPage] = useState(0);

  if (members === null) {
    return (
      <div className="space-y-2.5">
        {Array.from({ length: MEMBERS_PAGE_SIZE }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-12 shrink-0" />
          </div>
        ))}
      </div>
    );
  }
  if (members.length === 0) {
    return <EmptyNote>{error ?? 'No one has been granted access to this board yet.'}</EmptyNote>;
  }

  const pages = Math.ceil(members.length / MEMBERS_PAGE_SIZE);
  const safePage = Math.min(page, pages - 1);
  const start = safePage * MEMBERS_PAGE_SIZE;
  const pageMembers = members.slice(start, start + MEMBERS_PAGE_SIZE);

  return (
    <div>
      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pr-1 pb-2 font-medium">Member</th>
            <th className="w-[5.5rem] px-1 pb-2 font-medium">Dept</th>
            <th className="w-14 pb-2 text-right font-medium">Access</th>
          </tr>
        </thead>
        <tbody>
          {pageMembers.map((m) => {
            const access = ACCESS_STYLES[m.access] ?? ACCESS_STYLES.view;
            return (
              <tr key={m.email} className="border-b border-border/60 last:border-b-0">
                <td className="py-2 pr-1">
                  <span className="flex items-center gap-2.5">
                    <MemberAvatar member={m} />
                    <span className="min-w-0 leading-tight">
                      <span className="block truncate font-medium" title={m.name ?? m.email}>
                        {m.name ?? m.email.split('@')[0]}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground" title={m.email}>
                        {m.email}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="truncate px-1 py-2 text-xs text-muted-foreground" title={m.department ?? undefined}>
                  {m.department ?? '—'}
                </td>
                <td className="py-2 text-right">
                  <span
                    className={cn(
                      'inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap',
                      access.chip,
                    )}
                    title={`${access.label} access`}
                  >
                    <span className={cn('size-1.5 shrink-0 rounded-full', access.dot)} aria-hidden />
                    {access.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-muted-foreground tabular-nums">
            {start + 1}–{Math.min(start + MEMBERS_PAGE_SIZE, members.length)} of {members.length}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous members page"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next members page"
              disabled={safePage >= pages - 1}
              onClick={() => setPage(safePage + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Building blocks ───────────────────────────────────────────────────────────

/** macOS-style window control dots — the design's per-card chrome motif. Against
 *  the black console cards they read as terminal window buttons; decorative, so
 *  hidden from assistive tech. */
function WindowDots({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-1.5', className)} aria-hidden>
      <span className="size-2 rounded-full bg-red-500" />
      <span className="size-2 rounded-full bg-amber-400" />
      <span className="size-2 rounded-full bg-emerald-500" />
    </span>
  );
}

/** Tone for a stat's sub-line: signed week-over-week deltas read green up / red
 *  down (matching the reference); unsigned captions (percentages, "Across this
 *  board") stay muted. */
function deltaTone(sub?: string): 'up' | 'down' | 'muted' {
  if (sub?.startsWith('+')) return 'up';
  if (sub?.startsWith('-')) return 'down';
  return 'muted';
}

function StatTile({ label, value, sub }: { label: string; value: number; sub?: string }) {
  const tone = deltaTone(sub);
  return (
    <div className={cn('relative rounded-xl p-4 sm:p-5', GLASS_CARD)}>
      <WindowDots className="mb-3" />
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl leading-none font-semibold">{value}</p>
      <p
        className={cn(
          'mt-1.5 h-4 truncate text-[11px]',
          tone === 'up' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'down' && 'text-red-600 dark:text-red-400',
          tone === 'muted' && 'text-muted-foreground/80',
          !sub && 'invisible',
        )}
      >
        {sub ?? ' '}
      </p>
    </div>
  );
}

function OverviewCard({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <WindowDots className="mb-3" />
      <header className="mb-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {caption && <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>}
      </header>
      {children}
    </section>
  );
}

function EmptyNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground', className)}>
      {children}
    </p>
  );
}
