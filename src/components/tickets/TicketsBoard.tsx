'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Eye, Plus, RefreshCw, Search, SquareKanban } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { cn } from '@/lib/utils';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
} from '@/lib/tickets/types';
import { PRIORITY_STYLES, STATUS_STYLES, TicketCard } from './TicketCard';
import TicketDialog, { type TicketDraft } from './TicketDialog';

const byPosition = (a: TicketRow, b: TicketRow) =>
  a.position - b.position || a.created_at.localeCompare(b.created_at);

const columnDroppableId = (status: TicketStatus) => `column:${status}`;

/** Midpoint between the sorted neighbors at `index` in `list` (active card
 *  excluded by the caller) — fractional indexing, no mass renumbering. */
function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

interface BoardData {
  tickets: TicketRow[];
  access: 'view' | 'edit';
  viewer: string;
  isAdmin: boolean;
}

export default function TicketsBoard() {
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [access, setAccess] = useState<'view' | 'edit'>('view');
  const [viewer, setViewer] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Optimistic until the Realtime channel reports otherwise; 'degraded' means
  // the websocket is down and the 30s poll / focus refresh are carrying us.
  const [liveStatus, setLiveStatus] = useState<'live' | 'degraded'>('live');

  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TicketPriority>('all');

  const [activeTicket, setActiveTicket] = useState<TicketRow | null>(null);
  const [overColumn, setOverColumn] = useState<TicketStatus | null>(null);
  const draggingRef = useRef(false);
  const snapshotRef = useRef<TicketRow[] | null>(null);
  // Browsers fire a click on the source card right after a drop; without this
  // guard every drag would end by popping the details dialog open.
  const justDroppedRef = useRef(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTicket, setDialogTicket] = useState<TicketRow | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Data ────────────────────────────────────────────────────────────────────
  const fetchBoard = useCallback(async () => {
    // Never clobber an in-flight drag with a refetch — the poll retries in 30s
    // and our own PATCH triggers a realtime refresh right after the drop anyway.
    if (draggingRef.current) return;
    setRefreshing(true);
    try {
      const res = await fetch('/api/tickets', { cache: 'no-store' });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Request failed (${res.status})`);
      }
      const j = (await res.json()) as BoardData;
      if (draggingRef.current) return;
      setTickets(j.tickets ?? []);
      setAccess(j.access ?? 'view');
      setViewer(j.viewer ?? '');
      setIsAdmin(Boolean(j.isAdmin));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the board');
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchBoard();
  }, [fetchBoard]);

  useLiveRefresh({
    tables: ['tickets', 'ticket_comments'],
    channel: 'tickets-board',
    onRefresh: () => void fetchBoard(),
    enabled: loaded,
    onStatusChange: setLiveStatus,
  });

  const canEdit = access === 'edit';
  const filtersActive = search.trim() !== '' || priorityFilter !== 'all';
  // Dragging a filtered subset would compute positions against hidden
  // neighbors, so sorting pauses while a filter narrows the board.
  const dragEnabled = canEdit && !filtersActive;

  // ── Derived columns ─────────────────────────────────────────────────────────
  const columns = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = tickets.filter((t) => {
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q) ||
        `#${t.ticket_no}`.includes(q) ||
        t.created_by.toLowerCase().includes(q) ||
        (t.created_by_name ?? '').toLowerCase().includes(q)
      );
    });
    const map = Object.fromEntries(TICKET_STATUSES.map((s) => [s, [] as TicketRow[]])) as Record<
      TicketStatus,
      TicketRow[]
    >;
    for (const t of [...visible].sort(byPosition)) map[t.status]?.push(t);
    return map;
  }, [tickets, search, priorityFilter]);

  const columnOf = useCallback(
    (id: string): TicketStatus | null => {
      if (id.startsWith('column:')) return id.slice('column:'.length) as TicketStatus;
      return tickets.find((t) => t.id === id)?.status ?? null;
    },
    [tickets],
  );

  // ── Mutations (optimistic, revert by refetch) ───────────────────────────────
  const patchTicket = useCallback(
    async (id: string, patch: Partial<TicketRow>): Promise<boolean> => {
      const res = await fetch(`/api/tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(j?.error ?? 'Could not update the ticket');
        void fetchBoard();
        return false;
      }
      const j = (await res.json()) as { ticket: TicketRow };
      // Single-row writes don't carry the comment aggregate — keep the count.
      setTickets((prev) =>
        prev.map((t) => (t.id === id ? { ...j.ticket, comment_count: t.comment_count } : t)),
      );
      return true;
    },
    [fetchBoard],
  );

  const createTicket = useCallback(async (draft: TicketDraft): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          description: draft.description,
          priority: draft.priority,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(j?.error ?? 'Could not create the ticket');
        return false;
      }
      const j = (await res.json()) as { ticket: TicketRow };
      setTickets((prev) => [{ ...j.ticket, comment_count: 0 }, ...prev]);
      toast.success(`Ticket #${j.ticket.ticket_no} created`);
      return true;
    } finally {
      setSaving(false);
    }
  }, []);

  const saveTicket = useCallback(
    async (id: string, draft: TicketDraft): Promise<boolean> => {
      setSaving(true);
      try {
        return await patchTicket(id, {
          title: draft.title,
          description: draft.description,
          priority: draft.priority,
          status: draft.status,
          assigned_to: draft.assigned_to || null,
        });
      } finally {
        setSaving(false);
      }
    },
    [patchTicket],
  );

  const deleteTicket = useCallback(
    async (id: string): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(`/api/tickets/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          toast.error(j?.error ?? 'Could not delete the ticket');
          return false;
        }
        setTickets((prev) => prev.filter((t) => t.id !== id));
        toast.success('Ticket deleted');
        return true;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  // ── Drag and drop ───────────────────────────────────────────────────────────
  const sensors = useSensors(
    // 5px of travel before a drag starts, so plain clicks still open the card.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (event: DragStartEvent) => {
    const t = tickets.find((x) => x.id === event.active.id);
    if (!t) return;
    draggingRef.current = true;
    snapshotRef.current = tickets;
    setActiveTicket(t);
    setOverColumn(t.status);
  };

  const onDragOver = (event: DragOverEvent) => {
    const overId = event.over?.id as string | undefined;
    if (!overId) return;
    const activeId = event.active.id as string;
    const from = columnOf(activeId);
    const to = columnOf(overId);
    if (!to) return;
    setOverColumn(to);
    if (!from || from === to) return;
    // Cross-column hover: move the card into the hovered column immediately so
    // the board reflows under the pointer instead of waiting for the drop.
    setTickets((prev) => {
      const overTicket = prev.find((t) => t.id === overId);
      const target = prev.filter((t) => t.status === to && t.id !== activeId).sort(byPosition);
      const transient = overTicket
        ? overTicket.position - 0.5
        : (target[target.length - 1]?.position ?? 0) + 1;
      return prev.map((t) => (t.id === activeId ? { ...t, status: to, position: transient } : t));
    });
  };

  const finishDrag = () => {
    draggingRef.current = false;
    snapshotRef.current = null;
    setActiveTicket(null);
    setOverColumn(null);
    justDroppedRef.current = true;
    window.setTimeout(() => {
      justDroppedRef.current = false;
    }, 150);
  };

  const onDragCancel = () => {
    if (snapshotRef.current) setTickets(snapshotRef.current);
    finishDrag();
  };

  const onDragEnd = (event: DragEndEvent) => {
    const activeId = event.active.id as string;
    const overId = event.over?.id as string | undefined;
    const started = snapshotRef.current ?? tickets;
    const startedTicket = started.find((t) => t.id === activeId);
    const current = tickets.find((t) => t.id === activeId);

    if (!overId || !current || !startedTicket) {
      onDragCancel();
      return;
    }

    const status = current.status; // onDragOver already parked it in the target column
    let column = tickets.filter((t) => t.status === status).sort(byPosition);

    // Same-column reorder lands on a card: replay the visual arrayMove.
    if (!overId.startsWith('column:') && overId !== activeId) {
      const overIndex = column.findIndex((t) => t.id === overId);
      const activeIndex = column.findIndex((t) => t.id === activeId);
      if (overIndex >= 0 && activeIndex >= 0) column = arrayMove(column, activeIndex, overIndex);
    }

    const index = column.findIndex((t) => t.id === activeId);
    const position = positionBetween(column[index - 1]?.position, column[index + 1]?.position);
    const moved = startedTicket.status !== status;
    const reordered = position !== startedTicket.position;

    setTickets((prev) => prev.map((t) => (t.id === activeId ? { ...t, status, position } : t)));
    finishDrag();

    if (moved || reordered) {
      void patchTicket(activeId, { status, position });
    }
  };

  const openTicket = (t: TicketRow) => {
    if (draggingRef.current || justDroppedRef.current) return;
    setDialogTicket(t);
    setDialogOpen(true);
  };

  const canDeleteDialogTicket =
    dialogTicket !== null &&
    canEdit &&
    (isAdmin || dialogTicket.created_by.toLowerCase() === viewer.toLowerCase());

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <SquareKanban className="size-4.5" />
          </span>
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold">HRIS Updates</h1>
            <p className="text-xs text-muted-foreground">
              Request board · {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {loaded && !loadError && (
            <span
              className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
              title={
                liveStatus === 'live'
                  ? 'Connected to Supabase Realtime — changes appear instantly'
                  : 'Realtime connection lost — auto-refreshing every 30s'
              }
            >
              <span className="relative flex size-2" aria-hidden>
                {liveStatus === 'live' && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
                )}
                <span
                  className={cn(
                    'relative inline-flex size-2 rounded-full',
                    liveStatus === 'live' ? 'bg-emerald-500' : 'bg-amber-500',
                  )}
                />
              </span>
              {liveStatus === 'live' ? 'Live' : 'Auto-refresh'}
            </span>
          )}
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh board"
            title="Refresh board"
            disabled={!loaded}
            onClick={() => void fetchBoard()}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
          {loaded && !canEdit && (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-muted-foreground">
              <Eye className="size-3.5" />
              View only
            </span>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tickets…"
              className="h-8 w-44 pl-8 sm:w-56"
              aria-label="Search tickets"
            />
          </div>
          <Select
            value={priorityFilter}
            onValueChange={(v) => v && setPriorityFilter(v as 'all' | TicketPriority)}
          >
            <SelectTrigger aria-label="Filter by priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value="all">All priorities</SelectItem>
              {TICKET_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  <span className={cn('size-2 rounded-full', PRIORITY_STYLES[p].dot)} aria-hidden />
                  {PRIORITY_STYLES[p].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canEdit && (
            <Button
              onClick={() => {
                setDialogTicket(null);
                setDialogOpen(true);
              }}
            >
              <Plus data-icon="inline-start" />
              New ticket
            </Button>
          )}
        </div>
      </header>

      {canEdit && filtersActive && (
        <p className="border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground sm:px-6">
          Drag-to-move is paused while a search or filter is narrowing the board.
        </p>
      )}

      <main className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        {!loaded ? (
          <BoardSkeleton />
        ) : loadError && tickets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-muted-foreground">{loadError}</p>
            <Button variant="outline" onClick={() => void fetchBoard()}>
              <RefreshCw data-icon="inline-start" />
              Try again
            </Button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            <div className="flex h-full min-w-max gap-3 p-4 sm:min-w-0 sm:p-6 sm:pt-4">
              {TICKET_STATUSES.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  tickets={columns[status]}
                  dragEnabled={dragEnabled}
                  highlighted={activeTicket !== null && overColumn === status}
                  activeId={activeTicket?.id ?? null}
                  onOpen={openTicket}
                />
              ))}
            </div>
            <DragOverlay
              dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}
            >
              {activeTicket ? (
                <TicketCard ticket={activeTicket} overlay className="w-72" />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </main>

      <TicketDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        ticket={dialogTicket}
        canEdit={canEdit}
        canDelete={canDeleteDialogTicket}
        saving={saving}
        onCreate={createTicket}
        onSave={saveTicket}
        onDelete={deleteTicket}
      />
    </div>
  );
}

// ── Column ────────────────────────────────────────────────────────────────────

function BoardColumn({
  status,
  tickets,
  dragEnabled,
  highlighted,
  activeId,
  onOpen,
}: {
  status: TicketStatus;
  tickets: TicketRow[];
  dragEnabled: boolean;
  highlighted: boolean;
  activeId: string | null;
  onOpen: (t: TicketRow) => void;
}) {
  const { setNodeRef } = useDroppable({ id: columnDroppableId(status) });
  const style = STATUS_STYLES[status];

  return (
    <section
      ref={setNodeRef}
      aria-label={`${TICKET_STATUS_LABELS[status]} column, ${tickets.length} tickets`}
      className={cn(
        'flex h-full w-72 shrink-0 flex-col rounded-xl bg-muted/50 sm:w-auto sm:min-w-56 sm:flex-1 dark:bg-muted/30',
        'transition-[box-shadow,background-color] duration-150 motion-reduce:transition-none',
        highlighted && 'bg-orange-500/[0.06] ring-1 ring-orange-500/35 dark:bg-orange-400/[0.07]',
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className={cn('size-2 rounded-full', style.dot)} aria-hidden />
        <h2 className="text-[13px] font-semibold">{style.label}</h2>
        <span className="ml-auto rounded-full bg-background px-1.5 py-px font-mono text-[11px] text-muted-foreground tabular-nums dark:bg-muted">
          {tickets.length}
        </span>
      </header>

      <SortableContext
        items={tickets.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
        disabled={!dragEnabled}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {tickets.length === 0 ? (
            <div className="mx-1 mt-1 flex h-20 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
              {status === 'todo' ? 'New requests land here' : 'No tickets'}
            </div>
          ) : (
            tickets.map((t) => (
              <SortableTicketCard
                key={t.id}
                ticket={t}
                dragEnabled={dragEnabled}
                ghosted={t.id === activeId}
                onOpen={onOpen}
              />
            ))
          )}
        </div>
      </SortableContext>
    </section>
  );
}

// ── Sortable card wrapper ─────────────────────────────────────────────────────

function SortableTicketCard({
  ticket,
  dragEnabled,
  ghosted,
  onOpen,
}: {
  ticket: TicketRow;
  dragEnabled: boolean;
  ghosted: boolean;
  onOpen: (t: TicketRow) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    disabled: !dragEnabled,
  });

  return (
    <TicketCard
      ref={setNodeRef}
      ticket={ticket}
      canDrag={dragEnabled}
      ghosted={ghosted || isDragging}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => onOpen(ticket)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(ticket);
      }}
      {...attributes}
      {...listeners}
    />
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function BoardSkeleton() {
  return (
    <div className="flex h-full min-w-max gap-3 p-4 sm:min-w-0 sm:p-6 sm:pt-4">
      {TICKET_STATUSES.map((status) => (
        <div
          key={status}
          className="flex h-full w-72 shrink-0 flex-col rounded-xl bg-muted/50 sm:w-auto sm:min-w-56 sm:flex-1 dark:bg-muted/30"
        >
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <span className={cn('size-2 rounded-full', STATUS_STYLES[status].dot)} aria-hidden />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="flex flex-col gap-2 px-2 pb-2">
            {Array.from({ length: status === 'done' ? 1 : 2 + (status === 'todo' ? 1 : 0) }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-white p-3 dark:bg-[#151b29]">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-8" />
                  <Skeleton className="h-4 w-14 rounded-full" />
                </div>
                <Skeleton className="mt-2 h-4 w-full" />
                <Skeleton className="mt-1 h-4 w-2/3" />
                <div className="mt-3 flex items-center gap-2">
                  <Skeleton className="size-5 rounded-full" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
