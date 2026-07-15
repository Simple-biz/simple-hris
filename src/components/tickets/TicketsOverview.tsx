'use client';

import { useMemo, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
} from '@/lib/tickets/types';
import { PRIORITY_STYLES, STATUS_STYLES, relativeTime } from './TicketCard';

/**
 * /tickets → Overview: headline counts and breakdowns computed client-side
 * from the same board fetch (no extra endpoint; realtime refreshes flow in).
 *
 * Layout: one lead figure (Open now — the number this board exists to drive
 * down) plus four compact stat tiles, then the two breakdowns, then a
 * full-width recent-activity list. Per-status counts live only in the Board
 * split legend; they used to be duplicated as a KPI tile per status.
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
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

export default function TicketsOverview({ tickets, loaded, onOpenTicket }: TicketsOverviewProps) {
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
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
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
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
      {/* ── KPI row: one lead figure + four compact tiles ───────────────────── */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        <section className="col-span-2 rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Open now</p>
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
          <p className="mt-2 text-5xl leading-none font-semibold">{stats.open}</p>
          {stats.oldestOpen ? (
            <div className="-mx-2 mt-3.5">
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
            <p className="mt-4 text-xs text-muted-foreground">
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
  );
}

// ── Building blocks ───────────────────────────────────────────────────────────

function StatTile({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl leading-none font-semibold">{value}</p>
      <p className={cn('mt-1.5 h-4 truncate text-[11px] text-muted-foreground/80', !sub && 'invisible')}>
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
