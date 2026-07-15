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
 * Chart-color note: the bars reuse the board's exact status/priority hues so
 * every surface speaks one color vocabulary (color follows the entity). CVD
 * separation of both sets was validated; the legibility duty is carried by
 * mandatory direct labels (name + count on every row/segment) and 2px gaps
 * between stacked segments — never by hue alone.
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
    let completedThisWeek = 0;

    for (const t of tickets) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      if (t.status !== 'done') openByPriority[t.priority] = (openByPriority[t.priority] ?? 0) + 1;
      if (now - Date.parse(t.created_at) < WEEK_MS) createdThisWeek++;
      // `updated_at` bumps on every edit, so this reads "reached Done and
      // untouched since within the week" — close enough for a pulse figure.
      if (t.status === 'done' && now - Date.parse(t.updated_at) < WEEK_MS) completedThisWeek++;
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
      completedThisWeek,
      oldestOpen,
      recent,
      maxOpenPriority: Math.max(1, ...Object.values(openByPriority)),
    };
  }, [tickets]);

  if (!loaded) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      {/* ── KPI row ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Total tickets" value={stats.total} />
        {TICKET_STATUSES.map((s) => (
          <StatTile
            key={s}
            label={STATUS_STYLES[s].label}
            value={stats.byStatus[s]}
            dot={STATUS_STYLES[s].dot}
            sub={s === 'done' && stats.total > 0 ? `${stats.solvedPct}% solved` : undefined}
          />
        ))}
        <StatTile
          label="Open now"
          value={stats.open}
          sub={stats.oldestOpen ? `oldest ${ageDays(stats.oldestOpen.created_at)}` : undefined}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ── Board split (part-to-whole) ─────────────────────────────────────── */}
        <OverviewCard title="Board split" caption="Where every ticket sits right now">
          {stats.total === 0 ? (
            <EmptyNote>No tickets yet — the split shows up with the first request.</EmptyNote>
          ) : (
            <>
              <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Tickets per column">
                {TICKET_STATUSES.filter((s) => stats.byStatus[s] > 0).map((s) => (
                  <div
                    key={s}
                    className={cn('h-full', STATUS_STYLES[s].dot)}
                    style={{ width: `${(stats.byStatus[s] / stats.total) * 100}%`, minWidth: 6 }}
                    title={`${STATUS_STYLES[s].label} — ${stats.byStatus[s]} (${Math.round((stats.byStatus[s] / stats.total) * 100)}%)`}
                  />
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
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

        {/* ── This week ───────────────────────────────────────────────────────── */}
        <OverviewCard title="This week" caption="Last 7 days">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-muted/60 p-3">
              <p className="text-xs text-muted-foreground">New tickets</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{stats.createdThisWeek}</p>
            </div>
            <div className="rounded-lg bg-muted/60 p-3">
              <p className="text-xs text-muted-foreground">Completed</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{stats.completedThisWeek}</p>
            </div>
          </div>
          {stats.oldestOpen ? (
            <button
              type="button"
              onClick={() => onOpenTicket(stats.oldestOpen as TicketRow)}
              className="mt-3 flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60"
              title="Open the oldest unresolved ticket"
            >
              <span className="text-xs text-muted-foreground">Oldest open</span>
              <span className="font-mono text-xs text-muted-foreground">#{stats.oldestOpen.ticket_no}</span>
              <span className="min-w-0 truncate font-medium">{stats.oldestOpen.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {ageDays(stats.oldestOpen.created_at)}
              </span>
            </button>
          ) : (
            <EmptyNote className="mt-3">Nothing open — the board is fully solved. 🎉</EmptyNote>
          )}
        </OverviewCard>

        {/* ── Open by priority (magnitude) ────────────────────────────────────── */}
        <OverviewCard title="Open by priority" caption="Excludes Done">
          {stats.open === 0 ? (
            <EmptyNote>No open tickets.</EmptyNote>
          ) : (
            <div className="space-y-2.5">
              {[...TICKET_PRIORITIES].reverse().map((p) => {
                const count = stats.openByPriority[p];
                return (
                  <div key={p} className="flex items-center gap-3 text-sm">
                    <span className="w-16 shrink-0 text-muted-foreground">
                      {PRIORITY_STYLES[p].label}
                    </span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                      {count > 0 && (
                        <div
                          className={cn('h-full rounded-full', PRIORITY_STYLES[p].dot)}
                          style={{ width: `${(count / stats.maxOpenPriority) * 100}%`, minWidth: 8 }}
                          title={`${PRIORITY_STYLES[p].label} — ${count} open`}
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

        {/* ── Recent activity ─────────────────────────────────────────────────── */}
        <OverviewCard title="Recent activity" caption="Latest updated tickets">
          {stats.recent.length === 0 ? (
            <EmptyNote>Activity shows up here once tickets start moving.</EmptyNote>
          ) : (
            <div className="-mx-1.5 space-y-0.5">
              {stats.recent.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpenTicket(t)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
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
    </div>
  );
}

// ── Building blocks ───────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  dot,
  sub,
}: {
  label: string;
  value: number;
  dot?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {dot && <span className={cn('size-2 shrink-0 rounded-full', dot)} aria-hidden />}
        {label}
      </p>
      <p className="mt-1.5 text-2xl leading-none font-semibold tabular-nums">{value}</p>
      <p className={cn('mt-1 h-4 truncate text-[11px] text-muted-foreground/80', !sub && 'invisible')}>
        {sub ?? '.'}
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
    <section className="rounded-xl border border-border bg-card p-4">
      <header className="mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
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
