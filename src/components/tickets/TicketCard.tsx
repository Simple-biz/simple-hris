'use client';

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TicketRow, TicketPriority, TicketStatus } from '@/lib/tickets/types';

/** Shared visual vocabulary for the board — one place so the card, the column
 *  headers, and the dialogs all speak the same color language. Tinted (never
 *  full-saturation) chips per the app's restrained product palette. */
export const PRIORITY_STYLES: Record<
  TicketPriority,
  { label: string; chip: string; dot: string }
> = {
  urgent: {
    label: 'Urgent',
    chip: 'bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-400',
    dot: 'bg-red-500',
  },
  high: {
    label: 'High',
    chip: 'bg-orange-500/10 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400',
    dot: 'bg-orange-500',
  },
  medium: {
    label: 'Medium',
    chip: 'bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
    dot: 'bg-blue-500',
  },
  low: {
    label: 'Low',
    chip: 'bg-zinc-500/10 text-zinc-600 dark:bg-zinc-400/15 dark:text-zinc-400',
    dot: 'bg-zinc-400',
  },
};

export const STATUS_STYLES: Record<TicketStatus, { label: string; dot: string }> = {
  todo: { label: 'To Do', dot: 'bg-blue-500' },
  in_progress: { label: 'In Progress', dot: 'bg-amber-500' },
  testing: { label: 'Testing', dot: 'bg-violet-500' },
  done: { label: 'Done', dot: 'bg-emerald-500' },
};

export function initialsFor(name: string | null, email: string): string {
  const source = (name ?? '').trim() || email.split('@')[0].replace(/[._-]+/g, ' ');
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface TicketCardProps extends ComponentPropsWithoutRef<'div'> {
  ticket: TicketRow;
  /** The original card left behind while its overlay clone is being dragged. */
  ghosted?: boolean;
  /** Rendered inside the DragOverlay — lifted look, no hover states. */
  overlay?: boolean;
  canDrag?: boolean;
}

/** Presentational card. Sorting/drag behavior is attached by the board via the
 *  ref + spread props (dnd-kit listeners), so this stays a pure visual. */
export const TicketCard = forwardRef<HTMLDivElement, TicketCardProps>(function TicketCard(
  { ticket, ghosted = false, overlay = false, canDrag = false, className, ...props },
  ref,
) {
  const prio = PRIORITY_STYLES[ticket.priority] ?? PRIORITY_STYLES.medium;
  const creator = ticket.created_by_name ?? ticket.created_by.split('@')[0];

  return (
    <div
      ref={ref}
      className={cn(
        'group/card relative rounded-lg border border-border bg-white p-3 shadow-xs outline-none dark:bg-[#151b29]',
        'transition-[box-shadow,transform,opacity] duration-150 ease-out motion-reduce:transition-none',
        'focus-visible:ring-2 focus-visible:ring-ring/60',
        canDrag && !overlay && 'cursor-grab hover:-translate-y-px hover:shadow-md active:cursor-grabbing',
        !canDrag && !overlay && 'cursor-pointer hover:shadow-md',
        ghosted && 'opacity-40',
        overlay &&
          'rotate-2 scale-[1.03] cursor-grabbing shadow-xl ring-1 ring-orange-500/25 dark:shadow-black/50',
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-medium text-muted-foreground">
          #{ticket.ticket_no}
        </span>
        <span
          className={cn(
            'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium',
            prio.chip,
          )}
        >
          <span className={cn('size-1.5 rounded-full', prio.dot)} aria-hidden />
          {prio.label}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-sm leading-snug font-medium text-foreground">
        {ticket.title}
      </p>
      {ticket.description ? (
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
          {ticket.description}
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-1.5">
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground"
          aria-hidden
        >
          {initialsFor(ticket.created_by_name, ticket.created_by)}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={ticket.created_by}>
          {creator}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground/80">
          {(ticket.comment_count ?? 0) > 0 && (
            <span
              className="flex items-center gap-0.5"
              title={`${ticket.comment_count} repl${ticket.comment_count === 1 ? 'y' : 'ies'}`}
            >
              <MessageSquare className="size-3" aria-hidden />
              {ticket.comment_count}
            </span>
          )}
          {relativeTime(ticket.created_at)}
        </span>
      </div>
    </div>
  );
});
